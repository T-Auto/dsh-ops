use std::{
    io::{self, Read, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::null_mut,
    sync::{Arc, Mutex},
};
use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA,
        ERROR_NOT_FOUND,
    },
    Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType, ReadFile, WriteFile},
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Threading::{CreateEventW, GetCurrentProcess},
    },
};

type InvalidHandler = Option<unsafe extern "C" fn(*const u16, *const u16, *const u16, u32, usize)>;
unsafe extern "C" {
    fn _set_thread_local_invalid_parameter_handler(handler: InvalidHandler) -> InvalidHandler;
}
unsafe extern "C" fn invalid_descriptor(
    _: *const u16,
    _: *const u16,
    _: *const u16,
    _: u32,
    _: usize,
) {
}
struct Inner {
    handle: OwnedHandle,
    closed: Mutex<bool>,
}
pub struct Pipe(Arc<Inner>);

pub fn shutdown(pipe: &Pipe) -> io::Result<()> {
    let mut closed = pipe
        .0
        .closed
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if *closed {
        return Ok(());
    }
    *closed = true;
    // SAFETY: all clones issue I/O on this same owned handle. Holding the launch
    // lock prevents a new operation from starting after cancellation's snapshot.
    if unsafe { CancelIoEx(pipe.0.handle.as_raw_handle(), null_mut()) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_NOT_FOUND as i32) {
            return Err(error);
        }
    }
    Ok(())
}

pub fn inherited() -> io::Result<Pipe> {
    // SAFETY: scope the recoverable invalid-fd handler to this thread and restore it
    // immediately. _get_osfhandle borrows the CRT's handle; 7 is not a Win32 HANDLE.
    let raw = unsafe {
        let previous = _set_thread_local_invalid_parameter_handler(Some(invalid_descriptor));
        let raw = libc::get_osfhandle(7);
        _set_thread_local_invalid_parameter_handler(previous);
        raw as *mut std::ffi::c_void
    };
    // SAFETY: GetFileType validates an OS handle without taking ownership.
    if raw.is_null() || raw as isize == -1 || unsafe { GetFileType(raw) } != FILE_TYPE_PIPE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "fd 7 is not an inherited Windows pipe",
        ));
    }
    let mut owned = null_mut();
    // SAFETY: borrow the valid CRT handle; duplicate is non-inheritable and independently owned.
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            raw,
            GetCurrentProcess(),
            &mut owned,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: DuplicateHandle transferred exactly one owned handle.
    let pipe = Pipe::owned(unsafe { OwnedHandle::from_raw_handle(owned) });
    // SAFETY: close the original through its CRT owner, never CloseHandle(raw).
    if unsafe { libc::close(7) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(pipe)
}
impl Pipe {
    fn owned(handle: OwnedHandle) -> Self {
        Self(Arc::new(Inner {
            handle,
            closed: Mutex::new(false),
        }))
    }
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self(self.0.clone()))
    }
    fn transfer(&self, bytes: *mut u8, len: usize, read: bool) -> io::Result<usize> {
        if len == 0 {
            return Ok(0);
        }
        // SAFETY: unnamed manual-reset event, without inheritance or shared state.
        let event = unsafe { CreateEventW(null_mut(), 1, 0, null_mut()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful CreateEventW transferred an owned event handle.
        let event = unsafe { OwnedHandle::from_raw_handle(event) };
        // SAFETY: all-zero OVERLAPPED has valid inactive fields; this event is per operation.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.as_raw_handle();
        let handle = self.0.handle.as_raw_handle();
        let closed = self
            .0
            .closed
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *closed {
            return if read {
                Ok(0)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "control channel is closed",
                ))
            };
        }
        // SAFETY: Read/Write callers lend the buffer until this operation completes;
        // the OVERLAPPED and event stay live through GetOverlappedResult's wait.
        let started = unsafe {
            if read {
                ReadFile(
                    handle,
                    bytes,
                    len.min(u32::MAX as usize) as u32,
                    null_mut(),
                    &mut overlapped,
                )
            } else {
                WriteFile(
                    handle,
                    bytes,
                    len.min(u32::MAX as usize) as u32,
                    null_mut(),
                    &mut overlapped,
                )
            }
        };
        let error = (started == 0).then(io::Error::last_os_error);
        drop(closed); // Never hold the launch lock while awaiting completion.
        if let Some(error) = error {
            if read
                && matches!(error.raw_os_error(), Some(code) if code == ERROR_BROKEN_PIPE as i32 || code == ERROR_NO_DATA as i32)
            {
                return Ok(0);
            }
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
        }
        let mut count = 0;
        // SAFETY: wait for terminal completion before the caller can reuse its buffer.
        if unsafe { GetOverlappedResult(handle, &overlapped, &mut count, 1) } == 0 {
            let error = io::Error::last_os_error();
            if read && error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(0);
            }
            return Err(error);
        }
        Ok(count as usize)
    }
}

#[cfg(test)]
#[path = "windows_control_fixture.rs"]
mod fixture;
#[cfg(test)]
pub use fixture::test_pair;
impl Read for Pipe {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.transfer(bytes.as_mut_ptr(), bytes.len(), true)
    }
}
impl Write for Pipe {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.transfer(bytes.as_ptr().cast_mut(), bytes.len(), false)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
