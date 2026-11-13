//! Connected overlapped pipes, matching the public host's descriptor mode.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::{
    Foundation::{ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_DUPLEX},
    System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub fn test_pair() -> io::Result<(Pipe, Pipe)> {
    let name: Vec<u16> = format!(
        "\\\\.\\pipe\\ops-control-{}-{}\0",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
    .encode_utf16()
    .collect();
    // SAFETY: bounded NUL-terminated name; non-inheritable byte pipe, overlapped on both ends.
    let raw = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_WAIT,
            1,
            4096,
            4096,
            0,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful creation transferred an owned pipe handle.
    let server = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: same live pipe name, requesting one non-inheritable overlapped client handle.
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful open transferred an owned pipe handle.
    let client = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: the client connected above, so this call completes synchronously
    // with ERROR_PIPE_CONNECTED; the initialized record remains live for the call.
    let mut overlap: OVERLAPPED = unsafe { std::mem::zeroed() };
    if unsafe { ConnectNamedPipe(server.as_raw_handle(), &mut overlap) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED as i32) {
            if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) {
                let mut count = 0;
                // SAFETY: even unexpected pending work must settle before its
                // stack-owned OVERLAPPED can leave this fixture function.
                unsafe {
                    CancelIoEx(server.as_raw_handle(), &overlap);
                    GetOverlappedResult(server.as_raw_handle(), &overlap, &mut count, 1);
                }
            }
            return Err(error);
        }
    }
    Ok((Pipe::owned(server), Pipe::owned(client)))
}
