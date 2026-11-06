use super::*;
use ops_index::SourceError;
use ops_index::usn::WalkError;
use std::io::ErrorKind;

#[test]
fn every_error_maps_to_the_source_vocabulary() {
    let cases = [
        (WinfsError::AccessDenied, SourceError::Unsupported),
        (WinfsError::Unsupported, SourceError::Unsupported),
        (
            WinfsError::Io(ErrorKind::PermissionDenied),
            SourceError::Io(ErrorKind::PermissionDenied),
        ),
        (WinfsError::Fsctl(87), SourceError::Io(ErrorKind::Other)),
        (
            WinfsError::Malformed(WalkError::ZeroRecordLength { offset: 8 }),
            SourceError::Io(ErrorKind::InvalidData),
        ),
        (
            WinfsError::Incomplete,
            SourceError::Io(ErrorKind::InvalidData),
        ),
    ];
    for (error, expected) in cases {
        assert_eq!(error.source_error(), expected, "{error}");
    }
}

#[test]
fn every_error_has_a_stable_code() {
    assert_eq!(WinfsError::AccessDenied.code(), "WINFS_ACCESS_DENIED");
    assert_eq!(WinfsError::Unsupported.code(), "WINFS_UNSUPPORTED");
    assert_eq!(WinfsError::Fsctl(87).code(), "WINFS_FSCTL");
    assert_eq!(WinfsError::Io(ErrorKind::Other).code(), "WINFS_IO");
    assert_eq!(
        WinfsError::Malformed(WalkError::TruncatedHeader { offset: 0 }).code(),
        "WINFS_MALFORMED_PAGE"
    );
    assert_eq!(WinfsError::Incomplete.code(), "WINFS_INCOMPLETE_PAGE");
}

#[test]
fn display_names_the_failure() {
    assert!(WinfsError::AccessDenied.to_string().contains("elevation"));
    assert!(WinfsError::Fsctl(87).to_string().contains("87"));
    assert!(
        WinfsError::Malformed(WalkError::ZeroRecordLength { offset: 8 })
            .to_string()
            .contains("offset 8")
    );
    assert!(WinfsError::Incomplete.to_string().contains("truncated"));
}
