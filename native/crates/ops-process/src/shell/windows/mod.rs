mod argv;
mod channel;
mod job;
mod launch;
mod security;
mod signal;
pub use channel::{Channel, ChannelSnapshot};
pub use launch::Range;
pub use signal::signal_console_and_exit;

use std::{
    io,
    os::windows::io::{FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
pub(super) fn check(ok: i32) -> io::Result<()> {
    if ok != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
pub(super) fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful creator transfers this unique handle to us.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
