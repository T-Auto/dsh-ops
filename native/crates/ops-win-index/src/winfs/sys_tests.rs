use super::*;
use crate::winfs::FSCTL_ENUM_USN_DATA;
use crate::winfs::FSCTL_READ_USN_JOURNAL;
use crate::winfs::enum_data::{EnumRequest, read_enum_page};
use crate::winfs::error::WinfsError;
use std::path::Path;

#[test]
fn the_control_codes_are_the_documented_ctl_codes() {
    // CTL_CODE(9, function, METHOD_NEITHER = 3, FILE_ANY_ACCESS = 0).
    assert_eq!(FSCTL_ENUM_USN_DATA, 0x0009_00b3);
    assert_eq!(FSCTL_READ_USN_JOURNAL, 0x0009_00bb);
}

#[test]
fn win32_errors_map_to_the_fallback_vocabulary() {
    assert_eq!(map_win32(ERROR_ACCESS_DENIED), WinfsError::AccessDenied);
    assert_eq!(map_win32(ERROR_INVALID_FUNCTION), WinfsError::Unsupported);
    assert_eq!(map_win32(ERROR_NOT_SUPPORTED), WinfsError::Unsupported);
    // A rejected request is a diagnostic, not "this volume cannot be served":
    // keep the raw code so the caller can tell a real volume failure apart.
    assert_eq!(map_win32(87), WinfsError::Fsctl(87));
    assert_eq!(map_win32(1234), WinfsError::Fsctl(1234));
}

#[test]
fn completion_codes_are_not_failures() {
    // ERROR_MORE_DATA and ERROR_HANDLE_EOF are handled inside the
    // DeviceIoControl wrapper; this pins the constants the wrapper matches on.
    assert_eq!(ERROR_MORE_DATA, 234);
    assert_eq!(ERROR_HANDLE_EOF, 38);
}

#[test]
fn the_default_mount_point_is_rejected_without_privilege() {
    // A temporary directory is not a volume root, so the failure is the
    // fallback, never an access-denied surprise from a raw call.
    let error = VolumeHandle::open(&std::env::temp_dir()).unwrap_err();
    assert_eq!(error, WinfsError::Unsupported);
}

#[test]
fn a_volume_handle_either_opens_or_reports_a_fallback() {
    // CI's Windows runner usually has an elevated token, but not always (and
    // wine's kernel32 is a stub). Either answer is a contract: when the handle
    // opens, a real FSCTL page must come back; when it does not, the error must
    // map to the documented fallback so the caller keeps its own traversal.
    match VolumeHandle::open(Path::new("C:\\")) {
        Ok(volume) => {
            let mut buffer = vec![0u8; 64 * 1024];
            let page = read_enum_page(&volume, EnumRequest::from_start(0), &mut buffer)
                .expect("the first C: page is readable");
            assert!(page.bytes > 0, "an NTFS volume always has records");
            assert!(!page.records.is_empty());
        }
        Err(error) => assert!(
            matches!(
                error,
                WinfsError::AccessDenied | WinfsError::Unsupported | WinfsError::Fsctl(_)
            ),
            "unexpected failure: {error}"
        ),
    }
}
