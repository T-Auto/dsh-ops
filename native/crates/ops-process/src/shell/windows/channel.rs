use super::{check, job::Job, owned, security};
use crate::shell::{Capture, budget};
use std::{
    ffi::OsString,
    io,
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, OwnedHandle},
    },
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, ERROR_PIPE_CONNECTED,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX, ReadFile,
    },
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
            PIPE_REJECT_REMOTE_CLIENTS,
        },
        Threading::{CreateEventW, WaitForSingleObject},
    },
};

#[derive(Default, Debug, Clone)]
pub struct ChannelSnapshot {
    pub bytes: Vec<u8>,
    pub observed: u64,
    pub truncated: bool,
    pub accepted: Vec<u32>,
    pub eof: u32,
    pub rejected: u32,
    pub errors: Vec<String>,
}
#[derive(Default)]
struct State {
    capture: Capture,
    accepted: Vec<u32>,
    eof: u32,
    rejected: u32,
    errors: Vec<String>,
}
pub struct Channel {
    name: OsString,
    stop: Arc<AtomicBool>,
    seal_connects: Arc<AtomicBool>,
    state: Arc<Mutex<State>>,
    handles: Vec<Weak<OwnedHandle>>,
    readers: Vec<JoinHandle<()>>,
}
impl Channel {
    pub(super) fn new(job: Arc<Job>, cap: usize) -> io::Result<Self> {
        budget(cap)?;
        let name = security::private_name()?;
        let descriptor = security::Security::new()?;
        let attributes = descriptor.attributes();
        let mut channel = Self {
            name: OsString::from_wide(&name[..name.len() - 1]),
            stop: Arc::new(AtomicBool::new(false)),
            seal_connects: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(State::default())),
            handles: Vec::new(),
            readers: Vec::new(),
        };
        // Bound open probes and real writers together; never admit unbounded connections.
        let mut handles = Vec::with_capacity(4);
        for index in 0..4 {
            let flags = PIPE_ACCESS_DUPLEX
                | FILE_FLAG_OVERLAPPED
                | if index == 0 {
                    FILE_FLAG_FIRST_PIPE_INSTANCE
                } else {
                    0
                };
            // SAFETY: descriptor, name and output allocation remain alive for this call.
            handles.push(Arc::new(owned(unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    flags,
                    PIPE_REJECT_REMOTE_CLIENTS,
                    4,
                    65536,
                    65536,
                    0,
                    &attributes,
                )
            })?));
        }
        for handle in &handles {
            channel.handles.push(Arc::downgrade(handle));
            let (handle, stop, seal, state, job) = (
                handle.clone(),
                channel.stop.clone(),
                channel.seal_connects.clone(),
                channel.state.clone(),
                job.clone(),
            );
            channel.readers.push(
                thread::Builder::new()
                    .name("ops-shell-channel".into())
                    .spawn(move || {
                        if let Err(error) = receive(&handle, &job, &stop, &seal, &state, cap)
                            && !stop.load(Ordering::Acquire)
                        {
                            state.lock().unwrap().errors.push(error.to_string());
                        }
                    })?,
            );
        }
        // Readers alone retain their instances; EOF/rejection must retire each server.
        drop(handles);
        Ok(channel)
    }
    pub fn name(&self) -> &std::ffi::OsStr {
        &self.name
    }
    pub fn snapshot(&self) -> ChannelSnapshot {
        let state = self.state.lock().unwrap();
        ChannelSnapshot {
            bytes: state.capture.bytes.clone(),
            observed: state.capture.observed,
            truncated: state.capture.truncated,
            accepted: state.accepted.clone(),
            eof: state.eof,
            rejected: state.rejected,
            errors: state.errors.clone(),
        }
    }
    /// After confirmed Job emptiness, drain admitted peers to natural EOF and retire
    /// unused connect operations. This proves physical drain, not a command receipt.
    pub fn drain(&mut self, deadline: Instant) -> io::Result<()> {
        self.seal_connects.store(true, Ordering::Release);
        while self.readers.iter().any(|reader| !reader.is_finished()) {
            if Instant::now() >= deadline {
                self.close();
                self.state
                    .lock()
                    .unwrap()
                    .errors
                    .push("channel drain deadline exceeded".into());
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "channel drain deadline exceeded",
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
        self.close();
        let state = self.state.lock().unwrap();
        if !state.errors.is_empty() {
            return Err(io::Error::other(state.errors.join("; ")));
        }
        if state.eof as usize != state.accepted.len() {
            return Err(io::Error::other("admitted channel peers did not reach EOF"));
        }
        Ok(())
    }
    pub fn close(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.seal_connects.store(true, Ordering::Release);
        for handle in &self.handles {
            if let Some(handle) = handle.upgrade() {
                unsafe { CancelIoEx(handle.as_raw_handle(), std::ptr::null()) };
            }
        }
        for reader in self.readers.drain(..) {
            if reader.join().is_err() {
                self.state
                    .lock()
                    .unwrap()
                    .errors
                    .push("channel reader panicked".into());
            }
        }
        self.handles.clear();
    }
}
impl Drop for Channel {
    fn drop(&mut self) {
        self.close();
    }
}
fn operation(
    handle: &OwnedHandle,
    stop: &AtomicBool,
    connect: bool,
    bytes: &mut [u8],
) -> io::Result<u32> {
    if !connect && stop.load(Ordering::Acquire) {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "channel closed"));
    }
    let event = owned(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?;
    let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
    ov.hEvent = event.as_raw_handle();
    // SAFETY: OVERLAPPED, event and read buffer live until completion/cancellation is joined below.
    let started = unsafe {
        if connect {
            ConnectNamedPipe(handle.as_raw_handle(), &mut ov)
        } else {
            ReadFile(
                handle.as_raw_handle(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                std::ptr::null_mut(),
                &mut ov,
            )
        }
    };
    if started == 0 {
        let error = io::Error::last_os_error();
        if connect && error.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) {
            return Ok(0);
        }
        if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
            return Err(error);
        }
    }
    loop {
        if stop.load(Ordering::Acquire) {
            return cancel_join(handle, &ov);
        }
        let waited = unsafe { WaitForSingleObject(event.as_raw_handle(), 10) };
        if waited == WAIT_OBJECT_0 {
            let mut count = 0;
            check(unsafe { GetOverlappedResult(handle.as_raw_handle(), &ov, &mut count, 0) })?;
            return Ok(count);
        }
        if waited != WAIT_TIMEOUT {
            let error = io::Error::last_os_error();
            let _ = cancel_join(handle, &ov);
            return Err(error);
        }
    }
}
fn cancel_join(handle: &OwnedHandle, ov: &OVERLAPPED) -> io::Result<u32> {
    // Cancellation may lose to normal completion. Preserve its bytes/connected state,
    // and always join before the OVERLAPPED, buffer or event may leave scope.
    unsafe { CancelIoEx(handle.as_raw_handle(), ov) };
    let mut count = 0;
    check(unsafe { GetOverlappedResult(handle.as_raw_handle(), ov, &mut count, 1) })?;
    Ok(count)
}
fn receive(
    handle: &OwnedHandle,
    job: &Job,
    stop: &AtomicBool,
    seal: &AtomicBool,
    state: &Mutex<State>,
    cap: usize,
) -> io::Result<()> {
    match operation(handle, seal, true, &mut []) {
        Err(error)
            if seal.load(Ordering::Acquire)
                && error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32) =>
        {
            return Ok(());
        }
        result => {
            result?;
        }
    }
    let mut pid = 0;
    check(unsafe { GetNamedPipeClientProcessId(handle.as_raw_handle(), &mut pid) })?;
    if !job.contains_pid(pid)? {
        check(unsafe { DisconnectNamedPipe(handle.as_raw_handle()) })?;
        state.lock().unwrap().rejected += 1;
        return Ok(());
    }
    state.lock().unwrap().accepted.push(pid);
    read_peer(handle, stop, state, cap)
}
fn read_peer(
    handle: &OwnedHandle,
    stop: &AtomicBool,
    state: &Mutex<State>,
    cap: usize,
) -> io::Result<()> {
    let mut bytes = [0; 8192];
    loop {
        match operation(handle, stop, false, &mut bytes) {
            Ok(0) => break,
            Ok(count) => state
                .lock()
                .unwrap()
                .capture
                .append(&bytes[..count as usize], cap),
            Err(error) if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => break,
            Err(error) => return Err(error),
        }
    }
    state.lock().unwrap().eof += 1;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, io::Write, sync::mpsc};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};

    fn connected_pipe() -> (OwnedHandle, File) {
        let name = security::private_name().unwrap();
        let security = security::Security::new().unwrap();
        let server = owned(unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                0,
                &security.attributes(),
            )
        })
        .unwrap();
        let client = owned(unsafe {
            CreateFileW(
                name.as_ptr(),
                0x40000000,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        })
        .unwrap();
        operation(&server, &AtomicBool::new(false), true, &mut []).unwrap();
        (server, File::from(client))
    }

    #[test]
    fn cancellation_preserves_an_already_completed_read() {
        let (server, mut client) = connected_pipe();
        client.write_all(b"last").unwrap();
        let event =
            owned(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) }).unwrap();
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = event.as_raw_handle();
        let mut bytes = [0u8; 4];
        let started = unsafe {
            ReadFile(
                server.as_raw_handle(),
                bytes.as_mut_ptr(),
                4,
                std::ptr::null_mut(),
                &mut ov,
            )
        };
        if started == 0 {
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(ERROR_IO_PENDING as i32)
            );
        }
        let mut completed = 0;
        check(unsafe { GetOverlappedResult(server.as_raw_handle(), &ov, &mut completed, 1) })
            .unwrap();
        assert_eq!(completed, 4);
        assert_eq!(cancel_join(&server, &ov).unwrap(), 4);
        assert_eq!(&bytes, b"last");
    }

    #[test]
    fn drain_seals_unused_instances_without_claiming_a_writer() {
        let mut channel = Channel::new(Arc::new(Job::new().unwrap()), 64).unwrap();
        channel
            .drain(Instant::now() + Duration::from_secs(2))
            .unwrap();
        let snapshot = channel.snapshot();
        assert!(snapshot.accepted.is_empty());
        assert_eq!(snapshot.eof, 0);
        assert!(snapshot.errors.is_empty());
        assert!(channel.readers.is_empty());
    }

    #[test]
    fn drain_waits_for_buffered_output_and_natural_eof() {
        let (server, mut client) = connected_pipe();
        client.write_all(b"final buffered output").unwrap();
        drop(client);
        let server = Arc::new(server);
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(State::default()));
        state.lock().unwrap().accepted.push(std::process::id());
        let (release, gate) = mpsc::channel();
        let (handle, reader_stop, reader_state) = (server.clone(), stop.clone(), state.clone());
        let reader = thread::spawn(move || {
            gate.recv().unwrap();
            if let Err(error) = read_peer(&handle, &reader_stop, &reader_state, 64) {
                reader_state.lock().unwrap().errors.push(error.to_string());
            }
        });
        let mut channel = Channel {
            name: OsString::new(),
            stop,
            seal_connects: Arc::new(AtomicBool::new(false)),
            state,
            handles: vec![Arc::downgrade(&server)],
            readers: vec![reader],
        };
        drop(server);
        let seal = channel.seal_connects.clone();
        let (finished, result) = mpsc::channel();
        let finish = thread::spawn(move || {
            let drained = channel.drain(Instant::now() + Duration::from_secs(2));
            finished.send((drained, channel.snapshot())).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while !seal.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(seal.load(Ordering::Acquire));
        assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
        release.send(()).unwrap();
        let (drained, snapshot) = result.recv_timeout(Duration::from_secs(3)).unwrap();
        drained.unwrap();
        assert_eq!(snapshot.bytes, b"final buffered output");
        assert_eq!(snapshot.eof, 1);
        assert!(snapshot.errors.is_empty());
        finish.join().unwrap();
    }
}
