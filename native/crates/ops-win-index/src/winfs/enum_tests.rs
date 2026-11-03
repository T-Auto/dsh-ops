use super::*;
use crate::winfs::FSCTL_ENUM_USN_DATA;
use crate::winfs::fixtures::{FakeIo, enum_page, record_len, v2_record};
use crate::winfs::sys::PageOutcome;
use ops_index::usn::WalkError;
use std::io::ErrorKind;

fn page() -> FakeIo {
    let first = v2_record(11, 5, 100, 0x100, 0x20, "alpha.txt");
    let second = v2_record(12, 5, 108, 0x200, 0x10, "beta");
    FakeIo::replying(FSCTL_ENUM_USN_DATA, enum_page(99, &[first, second]))
}

#[test]
fn the_request_is_the_documented_v0_layout() {
    assert_eq!(ENUM_REQUEST_LEN, 24);
    let io = FakeIo::end_of_data(FSCTL_ENUM_USN_DATA);
    let request = EnumRequest {
        start: 0x0102_0304_0506_0708,
        low_usn: -2,
        high_usn: 77,
    };
    let mut buffer = vec![0u8; 4096];
    let _ = read_enum_page(&io, request, &mut buffer).expect("empty page is fine");
    let captured = io.captured();
    assert_eq!(captured.len(), ENUM_REQUEST_LEN);
    assert_eq!(&captured[0..8], &0x0102_0304_0506_0708u64.to_le_bytes());
    assert_eq!(&captured[8..16], &(-2i64).to_le_bytes());
    assert_eq!(&captured[16..24], &77i64.to_le_bytes());
}

#[test]
fn a_page_returns_the_next_start_and_its_records() {
    let io = page();
    let mut buffer = vec![0u8; 4096];
    let page = read_enum_page(&io, EnumRequest::from_start(0), &mut buffer).expect("a valid page");
    assert_eq!(page.next_start, 99);
    assert!(page.more);
    assert_eq!(page.records.len(), 2);
    // Records are padded to the kernel's 8-byte boundary.
    assert_eq!(page.bytes, 8 + record_len("alpha.txt") + record_len("beta"));
    assert_eq!(page.records[0].record.get(), 11);
    assert_eq!(page.records[0].parent.get(), 5);
    assert_eq!(page.records[0].usn, 100);
    assert_eq!(page.records[0].name, b"alpha.txt".to_vec());
    assert!(!page.records[0].is_dir());
    assert_eq!(page.records[1].name, b"beta".to_vec());
    assert!(page.records[1].is_dir());
}

#[test]
fn an_empty_page_ends_the_enumeration() {
    let io = FakeIo::end_of_data(FSCTL_ENUM_USN_DATA);
    let mut buffer = vec![0u8; 4096];
    let page =
        read_enum_page(&io, EnumRequest::from_start(42), &mut buffer).expect("EOF is success");
    assert_eq!(page.next_start, 0);
    assert!(!page.more);
    assert!(page.records.is_empty());
    assert_eq!(page.bytes, 0);
}

#[test]
fn truncation_is_not_a_clean_end() {
    // ERROR_MORE_DATA with zero bytes: the kernel says more exists but none fit.
    let io = FakeIo::reporting(FSCTL_ENUM_USN_DATA, PageOutcome::Wrote(0), Vec::new());
    let mut buffer = vec![0u8; 4096];
    let error = read_enum_page(&io, EnumRequest::from_start(0), &mut buffer).unwrap_err();
    assert_eq!(error, WinfsError::Incomplete);
    assert_eq!(error.code(), "WINFS_INCOMPLETE_PAGE");
    assert_eq!(
        error.source_error(),
        ops_index::SourceError::Io(ErrorKind::InvalidData)
    );
}

#[test]
fn a_misreported_length_is_rejected() {
    // A kernel byte count beyond the buffer is untrustworthy; the page functions
    // re-check it even though the handle validates it too.
    let io = FakeIo::reporting(FSCTL_ENUM_USN_DATA, PageOutcome::Wrote(4096), vec![0u8; 8]);
    let mut buffer = vec![0u8; 16];
    let error = read_enum_page(&io, EnumRequest::from_start(0), &mut buffer).unwrap_err();
    assert_eq!(error, WinfsError::Io(ErrorKind::InvalidData));
}

#[test]
fn a_truncated_page_is_rejected_as_malformed() {
    let io = FakeIo::replying(FSCTL_ENUM_USN_DATA, vec![1, 2, 3, 4, 5, 6, 7]);
    let mut buffer = vec![0u8; 4096];
    let error = read_enum_page(&io, EnumRequest::from_start(0), &mut buffer).unwrap_err();
    assert_eq!(
        error,
        WinfsError::Malformed(WalkError::TruncatedHeader { offset: 0 })
    );
    assert_eq!(error.code(), "WINFS_MALFORMED_PAGE");
    assert_eq!(
        error.source_error(),
        ops_index::SourceError::Io(ErrorKind::InvalidData)
    );
}

#[test]
fn a_corrupt_record_length_fails_the_whole_page() {
    let mut record = v2_record(11, 5, 100, 0x100, 0x20, "alpha");
    record[0..4].copy_from_slice(&2u32.to_le_bytes());
    let io = FakeIo::replying(FSCTL_ENUM_USN_DATA, enum_page(0, &[record]));
    let mut buffer = vec![0u8; 4096];
    let error = read_enum_page(&io, EnumRequest::from_start(0), &mut buffer).unwrap_err();
    assert!(matches!(
        error,
        WinfsError::Malformed(WalkError::TruncatedHeader { offset: 8 })
    ));
}

#[test]
fn a_short_buffer_is_refused_before_the_kernel_call() {
    let io = FakeIo::end_of_data(FSCTL_ENUM_USN_DATA);
    let mut buffer = [0u8; 4];
    let error = read_enum_page(&io, EnumRequest::from_start(0), &mut buffer).unwrap_err();
    assert_eq!(error, WinfsError::Io(ErrorKind::InvalidInput));
    assert!(io.captured().is_empty(), "the kernel must not be called");
}

#[test]
fn a_kernel_failure_is_propagated_unchanged() {
    let io = FakeIo::failing(FSCTL_ENUM_USN_DATA, WinfsError::AccessDenied);
    let mut buffer = vec![0u8; 4096];
    let error = read_enum_page(&io, EnumRequest::from_start(0), &mut buffer).unwrap_err();
    assert_eq!(error, WinfsError::AccessDenied);
    assert_eq!(error.source_error(), ops_index::SourceError::Unsupported);
}

#[test]
fn the_start_helper_covers_the_whole_journal_window() {
    let request = EnumRequest::from_start(7);
    assert_eq!(request.start, 7);
    assert_eq!(request.low_usn, 0);
    assert_eq!(request.high_usn, i64::MAX);
}
