mod argv;
mod channel;
mod identity;
mod job;
mod launch;
mod output;
mod pipe_write;
mod security;
mod signal;
mod spill_file;
mod spill_io;
pub use channel::{Channel, ChannelSnapshot, ChannelView};
pub use identity::Baseline;
pub use launch::Range;
pub use signal::signal_console_and_exit;
pub use spill_file::{MAX_SPILL_BYTES, SpillStore};

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
