use super::{check, owned};
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{ERROR_IO_PENDING, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Storage::FileSystem::WriteFile,
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        Threading::{CreateEventW, WaitForSingleObject},
    },
};

pub(super) fn write(
    handle: &OwnedHandle,
    mut bytes: &[u8],
    deadline: Instant,
    stopped: impl Fn() -> bool,
) -> io::Result<()> {
    if bytes.len() > 8 * 1024 * 1024 + 4096 {
        return Err(io::Error::other("command record exceeds bound"));
    }
    while !bytes.is_empty() {
        if stopped() || Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "command write cancelled or expired",
            ));
        }
        let event = owned(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?;
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        ov.hEvent = event.as_raw_handle();
        let started = unsafe {
            WriteFile(
                handle.as_raw_handle(),
                bytes.as_ptr(),
                bytes.len().min(65536) as u32,
                std::ptr::null_mut(),
                &mut ov,
            )
        };
        if started == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
        }
        loop {
            if stopped() || Instant::now() >= deadline {
                unsafe { CancelIoEx(handle.as_raw_handle(), &ov) };
                let mut ignored = 0;
                unsafe { GetOverlappedResult(handle.as_raw_handle(), &ov, &mut ignored, 1) };
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "command write cancelled or expired",
                ));
            }
            match unsafe { WaitForSingleObject(event.as_raw_handle(), 10) } {
                WAIT_TIMEOUT => continue,
                WAIT_OBJECT_0 => break,
                _ => {
                    let error = io::Error::last_os_error();
                    unsafe { CancelIoEx(handle.as_raw_handle(), &ov) };
                    let mut ignored = 0;
                    unsafe { GetOverlappedResult(handle.as_raw_handle(), &ov, &mut ignored, 1) };
                    return Err(error);
                }
            }
        }
        let mut count = 0;
        check(unsafe { GetOverlappedResult(handle.as_raw_handle(), &ov, &mut count, 0) })?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "command pipe wrote no bytes",
            ));
        }
        bytes = &bytes[count as usize..];
    }
    Ok(())
}
