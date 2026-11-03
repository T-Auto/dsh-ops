// Design informed by mustafaahci/goz (MIT).

//! The only module that touches the kernel.
//!
//! Everything below this line is deliberate `unsafe` in one small island: the
//! Win32 declarations, the volume handle's lifetime, and the
//! `DeviceIoControl` call. The rest of the crate sees [`VolumeHandle`] and
//! [`VolumeIo`] only.
//!
//! A volume handle is opened with `GENERIC_READ` and `FILE_SHARE_READ |
//! FILE_SHARE_WRITE`. Read access to a volume needs elevation, which is exactly
//! the documented non-Administrator fallback: [`WinfsError::AccessDenied`] maps
//! to [`ops_index::SourceError::Unsupported`] and the caller keeps its own
//! traversal.
//!
//! The completion codes are part of the protocol, not failures:
//!
//! - `ERROR_MORE_DATA` (234) means "the page filled up; there is more", so it
//!   is a [`PageOutcome::Wrote`] even when the kernel wrote nothing — that case
//!   is a truncation signal the page functions reject, never a clean end;
//! - `ERROR_HANDLE_EOF` (38) means "the enumeration or the journal read is
//!   complete", which is [`PageOutcome::EndOfData`].
//!
//! These FSCTLs use `METHOD_NEITHER`: the kernel receives the caller's own
//! user-mode buffer pointers, so the buffer must stay live and unaliased for
//! the duration of the call (the borrow checker plus `&mut [u8]` enforce that)
//! and no alignment is promised to the driver. Driver behavior on a real volume
//! was exercised by the capability test when the process is elevated; the
//! integration slice (W4) must additionally verify one real `METHOD_NEITHER`
//! page per volume on an administrator machine, which is recorded as pending
//! manual evidence in the PR rather than claimed here.

use crate::winfs::error::WinfsError;
use crate::winfs::volume_path;
use std::ffi::c_void;
use std::io::ErrorKind;
use std::path::Path;
use std::ptr;

/// A Win32 object handle. The crate never dereferences it.
pub(crate) type Handle = *mut c_void;

/// `INVALID_HANDLE_VALUE`, the failure value of `CreateFileW`.
const INVALID_HANDLE_VALUE: Handle = usize::MAX as Handle;

const GENERIC_READ: u32 = 0x8000_0000;
const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const OPEN_EXISTING: u32 = 3;

const ERROR_ACCESS_DENIED: u32 = 5;
const ERROR_INVALID_FUNCTION: u32 = 1;
const ERROR_MORE_DATA: u32 = 234;
const ERROR_NOT_SUPPORTED: u32 = 50;
const ERROR_HANDLE_EOF: u32 = 38;

// SAFETY (declarations): these signatures mirror the Win32 documentation for
// kernel32; the linker binds them at build time. No Rust code may call them
// outside an unsafe block with a SAFETY comment.
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(
        lp_file_name: *const u16,
        dw_desired_access: u32,
        dw_share_mode: u32,
        lp_security_attributes: *mut c_void,
        dw_creation_disposition: u32,
        dw_flags_and_attributes: u32,
        h_template_file: Handle,
    ) -> Handle;
    fn DeviceIoControl(
        h_device: Handle,
        dw_io_control_code: u32,
        lp_in_buffer: *const c_void,
        n_in_buffer_size: u32,
        lp_out_buffer: *mut c_void,
        n_out_buffer_size: u32,
        lp_bytes_returned: *mut u32,
        lp_overlapped: *mut c_void,
    ) -> i32;
    fn CloseHandle(h_object: Handle) -> i32;
    fn GetLastError() -> u32;
}

/// How one kernel page call ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageOutcome {
    /// The kernel wrote this many bytes into the output buffer.
    ///
    /// Zero bytes together with `ERROR_MORE_DATA` is a truncation signal: the
    /// kernel says more data exists but none fit. Page functions reject it; a
    /// clean end is always [`PageOutcome::EndOfData`].
    Wrote(usize),
    /// The kernel reported a clean end (`ERROR_HANDLE_EOF`), not a page.
    EndOfData,
}

/// One kernel call surface, so page logic is testable without a volume.
///
/// The real implementation is [`VolumeHandle`]; tests inject a fake that
/// returns prepared bytes. `input` and `output` are exactly what
/// `DeviceIoControl` receives: the encoded request struct and the page buffer.
pub trait VolumeIo {
    /// Sends one `FSCTL_*` code and reports how the call ended.
    ///
    /// # Errors
    ///
    /// [`WinfsError`] — see the variant docs; the caller decides between
    /// fallback and rescan.
    fn device_io_control(
        &self,
        code: u32,
        input: &[u8],
        output: &mut [u8],
    ) -> Result<PageOutcome, WinfsError>;
}

/// An open volume handle.
///
/// Owns the handle and closes it on drop. Not `Send`/`Sync`: a volume handle is
/// bound to the thread that opened it.
#[derive(Debug)]
pub struct VolumeHandle {
    handle: Handle,
}

impl VolumeHandle {
    /// Opens the volume whose root is `mount_point` for `FSCTL_*` reads.
    ///
    /// Accepts the drive-root spellings a caller can produce:
    ///
    /// - `C:` and `c:/\`: an absolute drive root;
    /// - `C:`: a bare drive (drive-relative with no tail);
    /// - `\?C:`: the verbatim form W1 may carry, with its prefix stripped.
    ///
    /// A drive-relative tail (`C:some\dir`) is accepted because the handle
    /// addresses the volume, not the CWD-relative path; the tail is dropped.
    /// UNC roots, device namespaces and absolute paths *below* a drive root are
    /// [`WinfsError::Unsupported`]: these FSCTLs address a whole volume, and a
    /// caller that needs a different volume must pass its root.
    ///
    /// # Errors
    ///
    /// - [`WinfsError::AccessDenied`] when the process is not elevated;
    /// - [`WinfsError::Unsupported`] for a path that is not a drive volume;
    /// - [`WinfsError::Fsctl`] / [`WinfsError::Io`] otherwise.
    pub fn open(mount_point: &Path) -> Result<Self, WinfsError> {
        let spelling = mount_point.as_os_str().to_string_lossy();
        let path = volume_path::device_path(&spelling)?;
        // SAFETY: `path` is a NUL-terminated UTF-16 buffer that outlives the
        // call; the remaining arguments are the documented constants for
        // opening a volume for read access; no security attributes and no
        // template file are passed (null pointers are the documented "none").
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null_mut(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(map_win32(last_error()));
        }
        Ok(Self { handle })
    }
}

impl VolumeIo for VolumeHandle {
    fn device_io_control(
        &self,
        code: u32,
        input: &[u8],
        output: &mut [u8],
    ) -> Result<PageOutcome, WinfsError> {
        let in_size =
            u32::try_from(input.len()).map_err(|_| WinfsError::Io(ErrorKind::InvalidInput))?;
        let out_size =
            u32::try_from(output.len()).map_err(|_| WinfsError::Io(ErrorKind::InvalidInput))?;
        let mut returned: u32 = 0;
        // SAFETY: the handle is owned by `self` and valid until drop; both
        // buffers are live for the whole call and their lengths are passed
        // exactly; `returned` is a valid out-parameter; the calls are
        // synchronous (no overlapped I/O), which is what METHOD_NEITHER needs.
        let ok = unsafe {
            DeviceIoControl(
                self.handle,
                code,
                input.as_ptr().cast(),
                in_size,
                output.as_mut_ptr().cast(),
                out_size,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if ok != 0 {
            return written_page(returned, output.len());
        }
        let error = last_error();
        match error {
            // The page filled up: success with data, per the FSCTL protocol. A
            // zero-byte return is kept as `Wrote(0)` so page functions can
            // reject it instead of calling it a clean end.
            ERROR_MORE_DATA => written_page(returned, output.len()),
            // The enumeration or journal read is complete.
            ERROR_HANDLE_EOF => Ok(PageOutcome::EndOfData),
            other => Err(map_win32(other)),
        }
    }
}

impl Drop for VolumeHandle {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by `self` and has not been closed
        // anywhere else; `CloseHandle` accepts it exactly once.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// Validates the kernel's byte count against the buffer and wraps it.
fn written_page(returned: u32, capacity: usize) -> Result<PageOutcome, WinfsError> {
    let written = returned as usize;
    if written > capacity {
        // A kernel count beyond the buffer means the page is untrustworthy.
        return Err(WinfsError::Io(ErrorKind::InvalidData));
    }
    if written == 0 {
        // Zero bytes with a successful call means "nothing available".
        return Ok(PageOutcome::EndOfData);
    }
    Ok(PageOutcome::Wrote(written))
}

/// Reads `GetLastError` immediately after a failed call on this thread.
fn last_error() -> u32 {
    // SAFETY: `GetLastError` has no preconditions and returns a thread-local
    // value; it is called on the thread that made the failing call, as the API
    // requires.
    unsafe { GetLastError() }
}

/// Maps a Win32 error code to the failure vocabulary.
fn map_win32(code: u32) -> WinfsError {
    match code {
        ERROR_ACCESS_DENIED => WinfsError::AccessDenied,
        ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED => WinfsError::Unsupported,
        // A malformed request or an FSCTL a volume rejects is a diagnostic, not
        // "this volume cannot be served this way": keep the raw code.
        other => WinfsError::Fsctl(other),
    }
}

#[cfg(test)]
#[path = "sys_tests.rs"]
mod sys_tests;
