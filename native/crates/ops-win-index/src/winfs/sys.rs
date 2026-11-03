// Design informed by mustafaahci/goz (MIT).

//! The only module that touches the kernel.
//!
//! Everything below this line is deliberate `unsafe` in one small island: the
//! Win32 declarations, the volume handle's lifetime, and the `DeviceIoControl`
//! call. The rest of the crate sees [`VolumeHandle`] and [`VolumeIo`] only.
//!
//! A volume handle is opened with `GENERIC_READ` and `FILE_SHARE_READ |
//! FILE_SHARE_WRITE`. Read access to a volume needs elevation, which is exactly
//! the documented non-Administrator fallback: [`WinfsError::AccessDenied`] maps
//! to [`ops_index::SourceError::Unsupported`] and the caller keeps its own
//! traversal.
//!
//! The completion codes are part of the protocol, not failures:
//!
//! - `ERROR_MORE_DATA` (234) means "the page was filled; there is more";
//! - `ERROR_HANDLE_EOF` (38) means "the enumeration or the journal read is
//!   complete", which is a successful empty page.

use crate::winfs::error::WinfsError;
use std::ffi::c_void;
use std::io::ErrorKind;
use std::path::{Component, Path};
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
const ERROR_INVALID_PARAMETER: u32 = 87;
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

/// One kernel call surface, so page logic is testable without a volume.
///
/// The real implementation is [`VolumeHandle`]; tests inject a fake that
/// returns prepared bytes. `input` and `output` are exactly what
/// `DeviceIoControl` receives: the encoded request struct and the page buffer.
pub trait VolumeIo {
    /// Sends one `FSCTL_*` code and returns how many output bytes were written.
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
    ) -> Result<usize, WinfsError>;
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
    /// `mount_point` must be a drive root such as `C:\` (a trailing separator is
    /// optional). UNC roots and directories below a root are
    /// [`WinfsError::Unsupported`]: these FSCTLs address a whole volume, and a
    /// caller that needs a different volume must pass its root.
    ///
    /// # Errors
    ///
    /// - [`WinfsError::AccessDenied`] when the process is not elevated;
    /// - [`WinfsError::Unsupported`] for a path that is not a drive root, or a
    ///   volume that refuses the control code;
    /// - [`WinfsError::Fsctl`] / [`WinfsError::Io`] otherwise.
    pub fn open(mount_point: &Path) -> Result<Self, WinfsError> {
        let path = volume_device_path(mount_point)?;
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
            return Err(map_win32(unsafe { GetLastError() }));
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
    ) -> Result<usize, WinfsError> {
        let in_size =
            u32::try_from(input.len()).map_err(|_| WinfsError::Io(ErrorKind::InvalidInput))?;
        let out_size =
            u32::try_from(output.len()).map_err(|_| WinfsError::Io(ErrorKind::InvalidInput))?;
        let mut returned: u32 = 0;
        // SAFETY: the handle is owned by `self` and valid until drop; both
        // buffers are live for the whole call and their lengths are passed
        // exactly; `returned` is a valid out-parameter; the calls are
        // synchronous (no overlapped I/O).
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
            return Ok(returned as usize);
        }
        // SAFETY: `GetLastError` has no preconditions and is read on the thread
        // that made the failing call, as the API requires.
        let error = unsafe { GetLastError() };
        match error {
            // The page filled up: a success with data, per the FSCTL protocol.
            ERROR_MORE_DATA => Ok(returned as usize),
            // The enumeration or journal read is complete.
            ERROR_HANDLE_EOF => Ok(0),
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

/// Maps a Win32 error code to the failure vocabulary.
fn map_win32(code: u32) -> WinfsError {
    match code {
        ERROR_ACCESS_DENIED => WinfsError::AccessDenied,
        ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED | ERROR_INVALID_PARAMETER => {
            WinfsError::Unsupported
        }
        other => WinfsError::Fsctl(other),
    }
}

/// Builds the `\\.\X:` device path for a drive root, NUL-terminated.
fn volume_device_path(mount_point: &Path) -> Result<Vec<u16>, WinfsError> {
    let mut components = mount_point.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Err(WinfsError::Unsupported);
    };
    let text = prefix.as_os_str().to_string_lossy();
    let mut chars = text.chars();
    let Some(letter) = chars.next() else {
        return Err(WinfsError::Unsupported);
    };
    if !letter.is_ascii_alphabetic() || chars.next() != Some(':') || chars.next().is_some() {
        // Covers UNC (\\server\share) and verbatim (\\?\C:) prefixes: neither
        // is a drive root this fallback can address.
        return Err(WinfsError::Unsupported);
    }
    match components.next() {
        None | Some(Component::RootDir) => {}
        Some(_) => return Err(WinfsError::Unsupported),
    }
    if components.next().is_some() {
        return Err(WinfsError::Unsupported);
    }
    let device = format!("\\\\\\.\\\\{}:", letter.to_ascii_uppercase());
    Ok(device.encode_utf16().chain(std::iter::once(0)).collect())
}

#[cfg(test)]
#[path = "sys_tests.rs"]
mod sys_tests;
