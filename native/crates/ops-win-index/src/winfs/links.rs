// Design informed by mustafaahci/goz (MIT).
//! FindFirstFileNameW/FindNextFileNameW bridge.
//!
//! This is the crate's only unsafe code. Each block carries a SAFETY note
//! describing the buffer/handle invariant it relies on, and every handle is
//! closed exactly once by SearchHandle's drop, including on the error paths.
//!
//! The Win32 loop has two documented quirks handled here:
//!
//! - ERROR_MORE_DATA (234) means the name buffer was too small; the call
//!   updates the length to the required size and must be retried once;
//! - ERROR_HANDLE_EOF (38) ends the enumeration normally.
//!
//! Any other failure mid-walk discards the partial set: applying a subset of a
//! file's names would delete real links.

use crate::links::{LinkFailure, LinkFailureKind, MAX_LINKS};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_HANDLE_EOF, ERROR_MORE_DATA,
    ERROR_PATH_NOT_FOUND, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{FindClose, FindFirstFileNameW, FindNextFileNameW};

/// Starting name buffer, in UTF-16 units.
const START_NAME_UNITS: usize = 512;
/// Longest name buffer accepted, in UTF-16 units; beyond this is a corrupt or
/// hostile answer, not a path.
const MAX_NAME_UNITS: u32 = 32_768;

/// Closed on drop, including every early return.
struct SearchHandle(HANDLE);

impl Drop for SearchHandle {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful FindFirstFileNameW and is
        // not used after this point; FindClose tolerates a terminating search.
        unsafe {
            FindClose(self.0);
        }
    }
}

/// Enumerates every link name of anchor, which must be NUL-free and absolute.
pub(crate) fn enumerate(anchor: &OsStr) -> Result<Vec<Vec<u16>>, LinkFailure> {
    let mut wide: Vec<u16> = anchor.encode_wide().collect();
    if wide.is_empty() {
        return Err(failure(LinkFailureKind::InvalidAnchor, 0));
    }
    wide.push(0);

    let mut buf = vec![0u16; START_NAME_UNITS];
    let mut length = START_NAME_UNITS as u32;
    // SAFETY: wide is NUL-terminated, length names buf's capacity in UTF-16
    // units, and the API writes at most that many units into buf.
    let find = unsafe { FindFirstFileNameW(wide.as_ptr(), 0, &mut length, buf.as_mut_ptr()) };
    let handle = if find == INVALID_HANDLE_VALUE {
        // SAFETY: plain FFI read of the calling thread's last error.
        let code = unsafe { GetLastError() };
        if code != ERROR_MORE_DATA {
            return Err(map_error(code, 0));
        }
        if length == 0 || length > MAX_NAME_UNITS {
            return Err(failure(LinkFailureKind::WalkAborted, 0));
        }
        buf = vec![0u16; length as usize];
        // SAFETY: buf now holds exactly the size the API just asked for.
        let retry = unsafe { FindFirstFileNameW(wide.as_ptr(), 0, &mut length, buf.as_mut_ptr()) };
        if retry == INVALID_HANDLE_VALUE {
            // SAFETY: plain FFI read of the calling thread's last error.
            return Err(map_error(unsafe { GetLastError() }, 0));
        }
        SearchHandle(retry)
    } else {
        SearchHandle(find)
    };

    let mut names = Vec::new();
    match take_name(&buf) {
        Some(name) => names.push(name),
        None => return Err(failure(LinkFailureKind::WalkAborted, 0)),
    }

    loop {
        if names.len() >= MAX_LINKS {
            return Err(failure(LinkFailureKind::TooManyLinks, names.len() as u32));
        }
        let mut length = buf.len() as u32;
        // SAFETY: handle is a live search handle from FindFirstFileNameW;
        // length names buf's capacity and the API writes at most that much.
        let ok = unsafe { FindNextFileNameW(handle.0, &mut length, buf.as_mut_ptr()) };
        if ok == 0 {
            // SAFETY: plain FFI read of the calling thread's last error.
            let code = unsafe { GetLastError() };
            match code {
                ERROR_HANDLE_EOF => break,
                ERROR_MORE_DATA => {
                    if length == 0 || length > MAX_NAME_UNITS {
                        return Err(failure(LinkFailureKind::WalkAborted, names.len() as u32));
                    }
                    buf = vec![0u16; length as usize];
                    // SAFETY: buf is now the size the API just asked for.
                    let retry =
                        unsafe { FindNextFileNameW(handle.0, &mut length, buf.as_mut_ptr()) };
                    if retry == 0 {
                        // SAFETY: plain FFI read of the calling thread's last error.
                        let last = unsafe { GetLastError() };
                        return Err(map_error(last, names.len() as u32));
                    }
                }
                _ => return Err(map_error(code, names.len() as u32)),
            }
        }
        match take_name(&buf) {
            Some(name) => names.push(name),
            None => return Err(failure(LinkFailureKind::WalkAborted, names.len() as u32)),
        }
    }

    if names.is_empty() {
        return Err(failure(LinkFailureKind::WalkAborted, 0));
    }
    Ok(names)
}

/// Copies the NUL-terminated name out of the scratch buffer; None when the
/// API did not terminate it (a contract violation, treated as aborted).
fn take_name(buf: &[u16]) -> Option<Vec<u16>> {
    let end = buf.iter().position(|&unit| unit == 0)?;
    Some(buf[..end].to_vec())
}

fn map_error(code: u32, seen: u32) -> LinkFailure {
    let kind = match code {
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => LinkFailureKind::FileGone,
        ERROR_ACCESS_DENIED => LinkFailureKind::AccessDenied,
        _ => LinkFailureKind::WalkAborted,
    };
    LinkFailure { kind, seen }
}

fn failure(kind: LinkFailureKind, seen: u32) -> LinkFailure {
    LinkFailure { kind, seen }
}
