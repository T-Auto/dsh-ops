use super::{
    channel_wake::{ConnectSeal, wait_readers},
    check,
    job::Job,
    output::Output,
    owned, security,
    spill_file::SpillStore,
    spill_io::Cancellation,
};
use crate::shell::{Capture, CaptureView, Retention, SpillSnapshot, budget};
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
        mpsc,
    },
    thread,
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
        Threading::{CreateEventW, INFINITE, WaitForMultipleObjects, WaitForSingleObject},
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
    pub ready: bool,
    pub writer_eof: bool,
    /// Authenticated pipe EOF, which can precede checked spill sealing.
    pub writer_closed: bool,
    pub storage_pending: bool,
    pub spill: Option<SpillSnapshot>,
    pub spill_error: Option<String>,
    pub cleanup_unconfirmed: bool,
}
#[derive(Clone)]
struct Spilling {
    view: CaptureView,
    store: SpillStore,
    stream: &'static str,
    busy: Arc<AtomicBool>,
}
struct ReaderOutput {
    capture: Output,
    busy: Arc<AtomicBool>,
}
impl ReaderOutput {
    fn start(&mut self) {
        self.capture.start();
    }
    fn append(&mut self, bytes: &[u8]) {
        self.busy.store(true, Ordering::Release);
        self.capture.append(bytes);
        self.busy.store(false, Ordering::Release);
    }
    fn finish(self, result: &io::Result<()>) {
        self.busy.store(true, Ordering::Release);
        self.capture.finish(result);
        self.busy.store(false, Ordering::Release);
    }
}
#[derive(Clone)]
pub(super) struct Prefix {
    pub bytes: Vec<u8>,
    pub duplex: bool,
}
struct Connection<'a> {
    stop: &'a AtomicBool,
    seal: &'a ConnectSeal,
    armed: mpsc::SyncSender<io::Result<()>>,
    output: Option<ReaderOutput>,
}
#[cfg(test)]
type ConnectGate = Arc<(Mutex<bool>, std::sync::Condvar)>;
#[derive(Default)]
struct State {
    progress: Option<super::channel_progress::ChannelProgress>,
    capture: Capture,
    accepted: Vec<u32>,
    eof: u32,
    rejected: u32,
    errors: Vec<String>,
    ready: bool,
    writer_eof: bool,
    writer_closed: bool,
    writer: Option<Weak<OwnedHandle>>,
}
impl State {
    fn changed(&self) {
        if let Some(progress) = &self.progress {
            progress.changed();
        }
    }
}
pub struct Channel {
    name: OsString,
    stop: Arc<AtomicBool>,
    seal_connects: Arc<ConnectSeal>,
    state: Arc<Mutex<State>>,
    handles: Vec<Weak<OwnedHandle>>,
    readers: Vec<super::channel_pool::Reader>,
    pool: Option<super::channel_pool::Lease>,
    spilling: Option<Spilling>,
    cancellations: Vec<Cancellation>,
    poisoned: bool,
}
#[derive(Clone)]
pub struct ChannelView(
    Arc<Mutex<State>>,
    Option<CaptureView>,
    Option<Arc<AtomicBool>>,
);
impl Channel {
    /// Install before sending a command; this hint never replaces snapshot checks.
    pub fn observe_progress(&self, progress: super::channel_progress::ChannelProgress) {
        self.state.lock().unwrap().progress = Some(progress);
    }
    pub fn name(&self) -> &std::ffi::OsStr {
        &self.name
    }
    pub fn snapshot(&self) -> ChannelSnapshot {
        self.view().snapshot()
    }
    pub fn view(&self) -> ChannelView {
        ChannelView(
            self.state.clone(),
            self.spilling.as_ref().map(|value| value.view.clone()),
            self.spilling.as_ref().map(|value| value.busy.clone()),
        )
    }
    pub fn cleanup_unconfirmed(&self) -> bool {
        self.poisoned
            || self
                .spilling
                .as_ref()
                .is_some_and(|value| value.view.snapshot().cleanup_unconfirmed)
    }
    /// After Job emptiness or a trusted protocol forbids new writers, drain to EOF and retire
    /// unused connect operations. This proves physical drain, not a command receipt.
    pub fn drain(&mut self, deadline: Instant) -> io::Result<()> {
        self.seal_connects.set()?;
        if !wait_readers(&self.readers, deadline)? {
            self.close_until(Instant::now() + Duration::from_secs(1))?;
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
        self.close_until(deadline)?;
        let state = self.state.lock().unwrap();
        if !state.errors.is_empty() {
            return Err(io::Error::other(state.errors.join("; ")));
        }
        if state.eof as usize != state.accepted.len() {
            return Err(io::Error::other("admitted channel peers did not reach EOF"));
        }
        Ok(())
    }
    /// Only the authenticated peer that sends the exact prefix receives command bytes.
    pub fn write(&self, bytes: &[u8], deadline: Instant, cancel: &AtomicBool) -> io::Result<()> {
        let handle = self
            .state
            .lock()
            .unwrap()
            .writer
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "command peer is not ready")
            })?;
        super::pipe_write::write(&handle, bytes, deadline, || {
            self.stop.load(Ordering::Acquire) || cancel.load(Ordering::Acquire)
        })
    }
    pub fn close(&mut self) {
        let _ = self.close_until(Instant::now() + Duration::from_secs(5));
    }
    /// Failed joining retains every reader; the coordinator must trigger fatal host teardown.
    pub fn close_until(&mut self, deadline: Instant) -> io::Result<()> {
        self.stop.store(true, Ordering::Release);
        self.seal_connects.set()?;
        while self.readers.iter().any(|reader| !reader.is_finished()) {
            for cancel in &self.cancellations {
                cancel.cancel();
            }
            for handle in &self.handles {
                if let Some(handle) = handle.upgrade() {
                    unsafe { CancelIoEx(handle.as_raw_handle(), std::ptr::null()) };
                }
            }
            if self.cleanup_unconfirmed() || Instant::now() >= deadline {
                self.poisoned = true;
                if let Some(pool) = &self.pool {
                    pool.poison();
                }
                if let Some(spilling) = &self.spilling {
                    spilling
                        .view
                        .poison("channel output cleanup unconfirmed".into());
                }
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "channel cleanup unconfirmed; managed kernel teardown required",
                ));
            }
            wait_readers(
                &self.readers,
                deadline.min(Instant::now() + Duration::from_millis(2)),
            )?;
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
        self.cancellations.clear();
        if let Some(pool) = self.pool.take() {
            if self.poisoned || !self.state.lock().unwrap().errors.is_empty() {
                pool.poison();
            }
            drop(pool);
        }
        if self.poisoned {
            Err(io::Error::other("channel owner is poisoned"))
        } else {
            Ok(())
        }
    }
}
impl Drop for Channel {
    fn drop(&mut self) {
        self.close();
        // Never detach an operation that still owns a file or borrowed OVERLAPPED buffer.
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}
impl ChannelView {
    pub fn snapshot(&self) -> ChannelSnapshot {
        let state = self.0.lock().unwrap();
        let output = self.1.as_ref().map(CaptureView::snapshot);
        let mut errors = state.errors.clone();
        if let Some(error) = output.as_ref().and_then(|value| value.error.as_ref())
            && !errors.contains(error)
        {
            errors.push(error.clone());
        }
        ChannelSnapshot {
            bytes: output
                .as_ref()
                .map_or_else(|| state.capture.bytes.clone(), |value| value.bytes.clone()),
            observed: output
                .as_ref()
                .map_or(state.capture.observed, |value| value.observed),
            truncated: output
                .as_ref()
                .map_or(state.capture.truncated, |value| value.truncated),
            accepted: state.accepted.clone(),
            eof: state.eof,
            rejected: state.rejected,
            errors,
            ready: state.ready,
            writer_eof: state.writer_eof,
            writer_closed: state.writer_closed,
            storage_pending: self
                .2
                .as_ref()
                .is_some_and(|busy| busy.load(Ordering::Acquire)),
            spill: output.as_ref().and_then(|value| value.spill.clone()),
            spill_error: output.as_ref().and_then(|value| value.spill_error.clone()),
            cleanup_unconfirmed: output
                .as_ref()
                .is_some_and(|value| value.cleanup_unconfirmed),
        }
    }
}
fn operation(
    handle: &OwnedHandle,
    stop: &AtomicBool,
    connect: bool,
    bytes: &mut [u8],
    armed: Option<&mpsc::SyncSender<io::Result<()>>>,
    connect_wake: Option<&OwnedHandle>,
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
            if let Some(armed) = armed {
                let _ = armed.send(Ok(()));
            }
            return Ok(0);
        }
        if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
            if let Some(armed) = armed {
                let _ = armed.send(Err(io::Error::new(error.kind(), error.to_string())));
            }
            return Err(error);
        }
    }
    if let Some(armed) = armed {
        let _ = armed.send(Ok(()));
    }
    loop {
        if stop.load(Ordering::Acquire) {
            return cancel_join(handle, &ov);
        }
        // A sealed connector wakes immediately. Active reads retain their own
        // cancellation scope and still drain to EOF; sealing cannot cancel them.
        let waited = if let Some(wake) = connect_wake {
            let events = [event.as_raw_handle(), wake.as_raw_handle()];
            unsafe { WaitForMultipleObjects(2, events.as_ptr(), 0, INFINITE) }
        } else {
            unsafe { WaitForSingleObject(event.as_raw_handle(), 10) }
        };
        if waited == WAIT_OBJECT_0 {
            let mut count = 0;
            check(unsafe { GetOverlappedResult(handle.as_raw_handle(), &ov, &mut count, 0) })?;
            return Ok(count);
        }
        if connect_wake.is_some() && waited == WAIT_OBJECT_0 + 1 {
            return cancel_join(handle, &ov);
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
    handle: &Arc<OwnedHandle>,
    job: &Job,
    state: &Mutex<State>,
    cap: usize,
    prefix: Option<&Prefix>,
    connection: Connection<'_>,
) -> io::Result<()> {
    let Connection {
        stop,
        seal,
        armed,
        output,
    } = connection;
    match operation(
        handle,
        &seal.flag,
        true,
        &mut [],
        Some(&armed),
        Some(&seal.event),
    ) {
        Err(error)
            if seal.flag.load(Ordering::Acquire)
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
    read_peer(handle, stop, state, cap, prefix, output)
}
fn read_peer(
    handle: &Arc<OwnedHandle>,
    stop: &AtomicBool,
    state: &Mutex<State>,
    cap: usize,
    prefix: Option<&Prefix>,
    mut output: Option<ReaderOutput>,
) -> io::Result<()> {
    let mut bytes = [0; 8192];
    let mut prefix_read = 0;
    let mut ready = false;
    let result = (|| {
        loop {
            match operation(handle, stop, false, &mut bytes, None, None) {
                Ok(0) => break,
                Ok(count) => {
                    let mut data = &bytes[..count as usize];
                    if let Some(prefix) = prefix {
                        let take = data.len().min(prefix.bytes.len() - prefix_read);
                        if data[..take] != prefix.bytes[prefix_read..prefix_read + take] {
                            return Err(io::Error::other("channel prefix mismatch"));
                        }
                        prefix_read += take;
                        data = &data[take..];
                        if prefix_read == prefix.bytes.len() && !ready {
                            let mut current = state.lock().unwrap();
                            if current.ready {
                                return Err(io::Error::other("duplicate channel writer"));
                            }
                            ready = true;
                            current.ready = true;
                            if prefix.duplex {
                                current.writer = Some(Arc::downgrade(handle));
                            }
                            drop(current);
                            if let Some(output) = &mut output {
                                output.start();
                            }
                        }
                    }
                    if let Some(output) = &mut output {
                        if ready {
                            output.append(data);
                        }
                    } else {
                        state.lock().unwrap().capture.append(data, cap);
                    }
                    state.lock().unwrap().changed();
                }
                Err(error) if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) => break,
                Err(error) => return Err(error),
            }
        }
        if prefix_read != 0 && !ready {
            return Err(io::Error::other("incomplete channel prefix"));
        }
        Ok(())
    })();
    if ready && result.is_ok() {
        let mut current = state.lock().unwrap();
        current.writer_closed = true;
        current.changed();
    }
    if ready && let Some(output) = output {
        output.finish(&result);
    }
    result?;
    let mut current = state.lock().unwrap();
    current.eof += 1;
    if ready {
        current.writer_eof = true;
    }
    current.changed();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, io::Write, sync::mpsc};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};

    #[test]
    fn endpoint_is_not_published_before_every_connect_is_armed() {
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let worker_gate = gate.clone();
        let (send, receive) = mpsc::channel();
        let worker = thread::spawn(move || {
            send.send(Channel::create(
                Arc::new(Job::new().unwrap()),
                64,
                None,
                None,
                Some(worker_gate),
            ))
            .unwrap();
        });
        // Every reader is held before ConnectNamedPipe. Without the constructor's
        // arming barrier, it publishes the endpoint while those readers are held.
        let premature = receive.recv_timeout(Duration::from_millis(50)).ok();
        let published_early = premature.is_some();
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        let mut channel = premature
            .unwrap_or_else(|| receive.recv_timeout(Duration::from_secs(2)).unwrap())
            .unwrap();
        channel
            .drain(Instant::now() + Duration::from_secs(2))
            .unwrap();
        worker.join().unwrap();
        assert!(
            !published_early,
            "pipe names escaped before their connect operations were armed"
        );
    }

    #[test]
    fn framed_prefix_is_not_output_and_empty_metadata_open_is_not_eof() {
        let state = Mutex::new(State::default());
        let prefix = Prefix {
            bytes: b"OUT:id\n".to_vec(),
            duplex: false,
        };
        let (server, client) = connected_pipe();
        drop(client);
        read_peer(
            &Arc::new(server),
            &AtomicBool::new(false),
            &state,
            4,
            Some(&prefix),
            None,
        )
        .unwrap();
        assert!(!state.lock().unwrap().ready);
        assert!(!state.lock().unwrap().writer_eof);
        let (server, mut client) = connected_pipe();
        client.write_all(b"OUT:id\nabcdef").unwrap();
        drop(client);
        read_peer(
            &Arc::new(server),
            &AtomicBool::new(false),
            &state,
            4,
            Some(&prefix),
            None,
        )
        .unwrap();
        let value = state.lock().unwrap();
        assert_eq!(value.capture.bytes, b"abcd");
        assert_eq!(value.capture.observed, 6);
        assert!(value.capture.truncated && value.ready && value.writer_eof);
    }

    #[test]
    fn a_wrong_or_partial_prefix_cannot_authenticate_a_writer() {
        for bytes in [b"WRONG\n".as_slice(), b"OUT:i".as_slice()] {
            let (server, mut client) = connected_pipe();
            client.write_all(bytes).unwrap();
            drop(client);
            let state = Mutex::new(State::default());
            let prefix = Prefix {
                bytes: b"OUT:id\n".to_vec(),
                duplex: false,
            };
            assert!(
                read_peer(
                    &Arc::new(server),
                    &AtomicBool::new(false),
                    &state,
                    4,
                    Some(&prefix),
                    None,
                )
                .is_err()
            );
            let value = state.lock().unwrap();
            assert!(!value.ready);
            assert_eq!(value.capture.observed, 0);
        }
    }

    #[test]
    fn duplex_write_uses_the_prefix_peer_and_cancels_backpressure() {
        use std::io::Read;
        let (server, mut client) = connected_pipe();
        let server = Arc::new(server);
        let state = Arc::new(Mutex::new(State::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (reader_handle, reader_state, reader_stop) =
            (server.clone(), state.clone(), stop.clone());
        let reader = thread::spawn(move || {
            read_peer(
                &reader_handle,
                &reader_stop,
                &reader_state,
                64,
                Some(&Prefix {
                    bytes: b"READY\n".to_vec(),
                    duplex: true,
                }),
                None,
            )
        });
        client.write_all(b"READY\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !state.lock().unwrap().ready && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(
            state
                .lock()
                .unwrap()
                .writer
                .as_ref()
                .and_then(Weak::upgrade)
                .is_some()
        );
        super::super::pipe_write::write(&server, b"command", deadline, || false).unwrap();
        let mut bytes = [0; 7];
        client.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"command");
        let cancel = Arc::new(AtomicBool::new(false));
        let writer_cancel = cancel.clone();
        let writer_handle = server.clone();
        let (done, result) = mpsc::channel();
        let writer = thread::spawn(move || {
            let result = super::super::pipe_write::write(
                &writer_handle,
                &vec![b'x'; 1024 * 1024],
                Instant::now() + Duration::from_secs(2),
                || writer_cancel.load(Ordering::Acquire),
            );
            done.send(result).unwrap();
        });
        assert!(matches!(
            result.recv_timeout(Duration::from_millis(50)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        cancel.store(true, Ordering::Release);
        assert!(
            result
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_err()
        );
        writer.join().unwrap();
        drop(client);
        reader.join().unwrap().unwrap();
        assert!(state.lock().unwrap().writer_eof);
    }

    pub(super) fn connected_pipe() -> (OwnedHandle, File) {
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
                0xc0000000,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        })
        .unwrap();
        operation(&server, &AtomicBool::new(false), true, &mut [], None, None).unwrap();
        (server, File::from(client))
    }

    #[test]
    fn output_progress_wakes_observers_without_claiming_eof() {
        let progress = super::super::channel_progress::ChannelProgress::default();
        let state = Arc::new(Mutex::new(State {
            progress: Some(progress.clone()),
            ..State::default()
        }));
        let (server, mut client) = connected_pipe();
        let reader_state = state.clone();
        let reader = thread::spawn(move || {
            read_peer(
                &Arc::new(server),
                &AtomicBool::new(false),
                &reader_state,
                64,
                Some(&Prefix {
                    bytes: b"OUT:id\n".to_vec(),
                    duplex: false,
                }),
                None,
            )
        });
        let observed = progress.version();
        client.write_all(b"OUT:id\nabc").unwrap();
        let awakened = progress.wait(observed, Instant::now() + Duration::from_secs(2));
        let (bytes, premature_eof) = {
            let value = state.lock().unwrap();
            (value.capture.bytes.clone(), value.writer_eof)
        };
        let before_eof = progress.version();
        drop(client);
        reader.join().unwrap().unwrap();
        assert!(awakened);
        assert_eq!(bytes, b"abc");
        assert!(!premature_eof, "notification is not completion authority");
        assert!(progress.wait(before_eof, Instant::now()));
        assert!(state.lock().unwrap().writer_eof);
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
            if let Err(error) = read_peer(&handle, &reader_stop, &reader_state, 64, None, None) {
                reader_state.lock().unwrap().errors.push(error.to_string());
            }
        });
        let mut channel = Channel {
            name: OsString::new(),
            stop,
            seal_connects: Arc::new(ConnectSeal::new().unwrap()),
            state,
            handles: vec![Arc::downgrade(&server)],
            readers: vec![super::super::channel_pool::Reader::Dedicated(reader)],
            pool: None,
            spilling: None,
            cancellations: Vec::new(),
            poisoned: false,
        };
        drop(server);
        let seal = channel.seal_connects.clone();
        let (finished, result) = mpsc::channel();
        let finish = thread::spawn(move || {
            let drained = channel.drain(Instant::now() + Duration::from_secs(2));
            finished.send((drained, channel.snapshot())).unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while !seal.flag.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(seal.flag.load(Ordering::Acquire));
        assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
        release.send(()).unwrap();
        let (drained, snapshot) = result.recv_timeout(Duration::from_secs(3)).unwrap();
        drained.unwrap();
        assert_eq!(snapshot.bytes, b"final buffered output");
        assert_eq!(snapshot.eof, 1);
        assert!(snapshot.errors.is_empty());
        finish.join().unwrap();
    }

    #[test]
    fn timed_out_pool_retirement_remains_poisoned_after_late_task_completion() {
        let pool =
            super::super::channel_pool::ChannelPool::new(Arc::new(Job::new().unwrap())).unwrap();
        let lease = pool.lease().unwrap();
        let handles = lease.handles();
        let (release, gate) = mpsc::channel();
        let reader = lease
            .start(0, Box::new(move || gate.recv().unwrap()))
            .unwrap();
        let mut channel = Channel {
            name: lease.name(),
            stop: Arc::new(AtomicBool::new(false)),
            seal_connects: Arc::new(ConnectSeal::new().unwrap()),
            state: Arc::new(Mutex::new(State::default())),
            handles: handles.iter().map(Arc::downgrade).collect(),
            readers: vec![reader],
            pool: Some(lease),
            spilling: None,
            cancellations: Vec::new(),
            poisoned: false,
        };
        // Release the deliberately stuck task before asserting, so even a
        // regression cannot strand the test's teardown behind its own barrier.
        let refused = channel.close_until(Instant::now()).is_err();
        let blocked = pool.framed(64, b"OUT:too-early\n").is_err();
        release.send(()).unwrap();
        let still_poisoned = channel
            .close_until(Instant::now() + Duration::from_secs(2))
            .is_err();
        drop(channel);
        assert!(refused && blocked && still_poisoned);
        assert!(pool.framed(64, b"OUT:too-late\n").is_err());
    }
}

#[cfg(test)]
#[path = "channel_spill_tests.rs"]
mod spill_tests;

#[path = "channel_build.rs"]
mod build;
