//! One writer owns each pending operation. Cancellation never releases its buffer early.
use super::{check, owned};
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
    sync::{Arc, Mutex},
};
use windows_sys::Win32::{
    Foundation::{ERROR_IO_PENDING, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::WriteFile,
    System::{
        IO::{CancelIoEx, CancelSynchronousIo, GetOverlappedResult, OVERLAPPED},
        Threading::{
            CreateEventW, GetCurrentThreadId, OpenThread, THREAD_TERMINATE, WaitForSingleObject,
        },
    },
};

#[derive(Default)]
struct Phase {
    thread: Option<OwnedHandle>,
    active: bool,
    file: Option<usize>,
    cancelled: bool,
    #[cfg(test)]
    pending: Option<std::sync::mpsc::Sender<()>>,
    #[cfg(test)]
    gate: Option<Arc<TestGate>>,
    #[cfg(test)]
    close_gate: Option<Arc<TestGate>>,
}
#[cfg(test)]
pub(super) struct TestGate {
    entered: std::sync::mpsc::Sender<()>,
    released: Mutex<bool>,
    changed: std::sync::Condvar,
}
#[cfg(test)]
impl TestGate {
    pub fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
    fn wait(&self) {
        let _ = self.entered.send(());
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.changed.wait(released).unwrap();
        }
    }
}
#[derive(Clone, Default)]
pub(super) struct Cancellation(Arc<Mutex<Phase>>);
impl Cancellation {
    #[cfg(test)]
    pub fn gate_next_write(&self) -> (Arc<TestGate>, std::sync::mpsc::Receiver<()>) {
        self.install_gate(false)
    }
    #[cfg(test)]
    pub fn gate_next_close(&self) -> (Arc<TestGate>, std::sync::mpsc::Receiver<()>) {
        self.install_gate(true)
    }
    #[cfg(test)]
    pub fn wait_close_gate(&self) {
        let gate = self.0.lock().unwrap().close_gate.take();
        if let Some(gate) = gate {
            gate.wait();
        }
    }
    #[cfg(test)]
    fn install_gate(&self, close: bool) -> (Arc<TestGate>, std::sync::mpsc::Receiver<()>) {
        let (entered, receiver) = std::sync::mpsc::channel();
        let gate = Arc::new(TestGate {
            entered,
            released: Mutex::new(false),
            changed: std::sync::Condvar::new(),
        });
        if close {
            self.0.lock().unwrap().close_gate = Some(gate.clone());
        } else {
            self.0.lock().unwrap().gate = Some(gate.clone());
        }
        (gate, receiver)
    }
    #[cfg(test)]
    fn on_pending(&self, sender: std::sync::mpsc::Sender<()>) {
        self.0.lock().unwrap().pending = Some(sender);
    }
    pub fn register(&self) -> io::Result<()> {
        let handle = owned(unsafe { OpenThread(THREAD_TERMINATE, 0, GetCurrentThreadId()) })?;
        self.0.lock().unwrap().thread = Some(handle);
        Ok(())
    }
    pub fn cancel(&self) {
        let mut phase = self.0.lock().unwrap();
        phase.cancelled = true;
        if phase.active {
            // The writer must reacquire this lock before leaving its I/O phase. A late
            // cancellation therefore cannot hit its subsequent anonymous-pipe read.
            if let Some(file) = phase.file {
                unsafe { CancelIoEx(file as HANDLE, std::ptr::null()) };
            }
            if let Some(thread) = &phase.thread {
                unsafe { CancelSynchronousIo(thread.as_raw_handle()) };
            }
        }
    }
    pub fn cancelled(&self) -> bool {
        self.0.lock().unwrap().cancelled
    }
    pub fn operation<T>(
        &self,
        file: Option<HANDLE>,
        cleanup: bool,
        operation: impl FnOnce() -> io::Result<T>,
    ) -> io::Result<T> {
        {
            let mut phase = self.0.lock().unwrap();
            if phase.cancelled && !cleanup {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "spill cancelled",
                ));
            }
            phase.active = true;
            phase.file = file.map(|value| value as usize);
        }
        let result = operation();
        let mut phase = self.0.lock().unwrap();
        phase.active = false;
        phase.file = None;
        result
    }
}

pub(super) fn write(
    file: HANDLE,
    mut offset: u64,
    mut bytes: &[u8],
    cancel: &Cancellation,
) -> io::Result<()> {
    while !bytes.is_empty() {
        let count = cancel.operation(Some(file), false, || {
            #[cfg(test)]
            {
                let gate = cancel.0.lock().unwrap().gate.take();
                if let Some(gate) = gate {
                    gate.wait();
                }
            }
            let event = owned(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?;
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            ov.hEvent = event.as_raw_handle();
            ov.Anonymous.Anonymous.Offset = offset as u32;
            ov.Anonymous.Anonymous.OffsetHigh = (offset >> 32) as u32;
            // One 8 KiB piece stays borrowed until completion is observed, even if a
            // cancellation request fails. The owner can report an unconfirmed join.
            let started = unsafe {
                WriteFile(
                    file,
                    bytes.as_ptr(),
                    bytes.len().min(8192) as u32,
                    std::ptr::null_mut(),
                    &mut ov,
                )
            };
            if started == 0
                && io::Error::last_os_error().raw_os_error() != Some(ERROR_IO_PENDING as i32)
            {
                return Err(io::Error::last_os_error());
            }
            #[cfg(test)]
            if unsafe { WaitForSingleObject(event.as_raw_handle(), 0) } == WAIT_TIMEOUT
                && let Some(sender) = cancel.0.lock().unwrap().pending.take()
            {
                let _ = sender.send(());
            }
            loop {
                if cancel.cancelled() {
                    unsafe { CancelIoEx(file, &ov) };
                }
                match unsafe { WaitForSingleObject(event.as_raw_handle(), 10) } {
                    WAIT_TIMEOUT => continue,
                    WAIT_OBJECT_0 => break,
                    _ => {
                        let error = io::Error::last_os_error();
                        unsafe { CancelIoEx(file, &ov) };
                        let mut ignored = 0;
                        // Do not detach or reuse the buffer after a failed wait.
                        unsafe { GetOverlappedResult(file, &ov, &mut ignored, 1) };
                        return Err(error);
                    }
                }
            }
            let mut count = 0;
            check(unsafe { GetOverlappedResult(file, &ov, &mut count, 0) })?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "spill wrote no bytes",
                ));
            }
            Ok(count as usize)
        })?;
        offset += count as u64;
        bytes = &bytes[count..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::security::{self, Security};
    use super::*;
    use std::{sync::mpsc, thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::{ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE},
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
        },
        System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS},
    };
    #[test]
    fn pending_write_cancellation_joins_before_releasing_its_buffer() {
        let name = security::private_name().unwrap();
        let security = Security::new().unwrap();
        let server = owned(unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_REJECT_REMOTE_CLIENTS,
                1,
                1024,
                1024,
                0,
                &security.attributes(),
            )
        })
        .unwrap();
        let client = owned(unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        })
        .unwrap();
        let connected = unsafe { ConnectNamedPipe(server.as_raw_handle(), std::ptr::null_mut()) };
        assert!(
            connected != 0
                || io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32)
        );
        let cancel = Cancellation::default();
        let (signal, pending) = mpsc::channel();
        cancel.on_pending(signal);
        let owned_cancel = cancel.clone();
        let (completed, done) = mpsc::channel();
        let writer = thread::spawn(move || {
            owned_cancel.register().unwrap();
            let bytes = vec![120; 2 * 1024 * 1024];
            let result = write(server.as_raw_handle(), 0, &bytes, &owned_cancel);
            completed.send(result).unwrap();
        });
        let armed = pending.recv_timeout(Duration::from_secs(5));
        let remained_pending = done.try_recv().is_err();
        cancel.cancel();
        let result = done.recv_timeout(Duration::from_secs(5));
        // Close the deliberately unread endpoint before joining on any assertion
        // failure, so the fixture cannot strand its own writer.
        drop(client);
        writer.join().unwrap();
        armed.unwrap();
        assert!(remained_pending, "the unread pipe must still be pending");
        assert!(result.unwrap().is_err());
    }
}
