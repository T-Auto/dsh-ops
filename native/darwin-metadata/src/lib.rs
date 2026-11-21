//! Darwin ACL probe and scrub helper. Nonempty extended ACLs are not yet
//! supported by the publication pipeline; reject before staging rather than
//! widen access, and strip any ACE a bare clone inherits from its parent.
#![cfg(target_os = "macos")]
use std::{ffi::c_void, fs::File, io, os::fd::AsRawFd};
#[link(name = "System")]
unsafe extern "C" {
    fn acl_get_fd_np(fd: i32, acl_type: u32) -> *mut c_void;
    fn acl_get_entry(acl: *mut c_void, entry_id: i32, entry: *mut *mut c_void) -> i32;
    fn acl_init(count: i32) -> *mut c_void;
    fn acl_set_fd(fd: i32, acl: *mut c_void) -> i32;
    fn acl_free(obj: *mut c_void) -> i32;
    fn __error() -> *mut i32;
}
const ACL_TYPE_EXTENDED: u32 = 0x100;
const EINVAL: i32 = 22;
/// The borrowed handle stays open; all OS-allocated ACL storage is freed here.
/// No ACL, mode, owner or privilege is modified by this probe.
pub fn require_no_extended_acl(file: &File) -> io::Result<()> {
    // SAFETY: __error returns this thread's errno pointer; acl_get_fd_np borrows
    // a valid live fd. A successful non-null ACL is released exactly once.
    let acl = unsafe {
        *__error() = 0;
        acl_get_fd_np(file.as_raw_fd(), ACL_TYPE_EXTENDED)
    };
    if acl.is_null() {
        let error = io::Error::last_os_error();
        // Apple's acl_get_fd_np delegates to filesec_get_property(FILESEC_ACL),
        // which returns ENOENT when this live descriptor has no ACL property.
        // This is not a path lookup: verify the fd is still valid before treating
        // that documented absent-property result as an empty ACL.
        if error.raw_os_error() == Some(0) || error.raw_os_error() == Some(2) {
            file.metadata()?;
            return Ok(());
        }
        return Err(error);
    }
    let mut entry = std::ptr::null_mut();
    // Darwin acl_get_entry returns 0 for success, -1/EINVAL for no first entry
    // (unlike the POSIX convention used by Linux implementations).
    let status = unsafe {
        *__error() = 0;
        acl_get_entry(acl, 0, &mut entry)
    };
    let error = io::Error::last_os_error();
    unsafe {
        acl_free(acl);
    }
    if status == 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Darwin extended ACL publication is not supported; source untouched and no sibling created",
        ));
    }
    if error.raw_os_error() == Some(EINVAL) {
        return Ok(());
    }
    Err(error)
}

/// Remove every extended ACL entry from `file`.
///
/// The publication pipeline rejects sources that carry an ACL, so a clone must
/// not gain one from its destination directory. macOS 12 refuses `CLONE_ACL`
/// with EINVAL, and a clone without that flag inherits the parent's inheritable
/// entries; callers strip them before publishing. An absent ACL is not an
/// error: setting an empty one is a no-op on this platform.
pub fn clear_extended_acl(file: &File) -> io::Result<()> {
    // SAFETY: acl_init allocates a fresh, empty ACL or returns null; the
    // borrowed descriptor stays valid for the call; acl_free releases the
    // allocation exactly once on both paths.
    let empty = unsafe { acl_init(0) };
    if empty.is_null() {
        return Err(io::Error::last_os_error());
    }
    let status = unsafe {
        *__error() = 0;
        acl_set_fd(file.as_raw_fd(), empty)
    };
    let error = (status != 0).then(io::Error::last_os_error);
    unsafe {
        acl_free(empty);
    }
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
