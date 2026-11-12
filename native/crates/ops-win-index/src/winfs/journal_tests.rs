use super::*;
use crate::winfs::FSCTL_READ_USN_JOURNAL;
use crate::winfs::fixtures::{FakeIo, journal_page, record_len, v2_record};
use crate::winfs::sys::PageOutcome;
use ops_index::usn::WalkError;
use std::io::ErrorKind;

#[test]
fn the_request_is_the_documented_v0_layout() {
    assert_eq!(READ_JOURNAL_REQUEST_LEN, 40);
    let io = FakeIo::end_of_data(FSCTL_READ_USN_JOURNAL);
    let request = ReadJournalRequest {
        journal_id: 0x0102_0304_0506_0708,
        start_usn: -9,
        reason_mask: 0x1234,
        return_only_on_close: true,
        timeout_100ns: 0x0102_0304,
        bytes_to_wait_for: 0x0203_0405,
    };
    let mut buffer = vec![0u8; 4096];
    let _ = read_journal_page(&io, request, &mut buffer).expect("empty page is fine");
    let captured = io.captured();
    assert_eq!(captured.len(), READ_JOURNAL_REQUEST_LEN);
    assert_eq!(&captured[0..8], &(-9i64).to_le_bytes());
    assert_eq!(&captured[8..12], &0x1234u32.to_le_bytes());
    assert_eq!(&captured[12..16], &1u32.to_le_bytes());
    assert_eq!(&captured[16..24], &0x0102_0304u64.to_le_bytes());
    assert_eq!(&captured[24..32], &0x0203_0405u64.to_le_bytes());
    assert_eq!(&captured[32..40], &0x0102_0304_0506_0708u64.to_le_bytes());
}

#[test]
fn a_page_advances_to_its_leading_usn() {
    let record = v2_record(11, 5, 120, 0x100, 0x20, "alpha.txt");
    let io = FakeIo::replying(FSCTL_READ_USN_JOURNAL, journal_page(130, &[record]));
    let mut buffer = vec![0u8; 4096];
    let page = read_journal_page(&io, ReadJournalRequest::from_start(7, 100), &mut buffer)
        .expect("a valid page");
    assert_eq!(page.next_usn, 130);
    assert!(page.more);
    assert_eq!(page.records.len(), 1);
    assert_eq!(page.records[0].usn, 120);
    assert_eq!(page.bytes, 8 + record_len("alpha.txt"));
}

#[test]
fn an_empty_page_keeps_the_requested_cursor() {
    let io = FakeIo::end_of_data(FSCTL_READ_USN_JOURNAL);
    let mut buffer = vec![0u8; 4096];
    let page = read_journal_page(&io, ReadJournalRequest::from_start(7, 100), &mut buffer)
        .expect("no new records is success");
    assert_eq!(page.next_usn, 100);
    assert!(!page.more);
    assert!(page.records.is_empty());
    assert_eq!(page.bytes, 0);
}

#[test]
fn truncation_is_not_a_clean_end() {
    let io = FakeIo::reporting(FSCTL_READ_USN_JOURNAL, PageOutcome::Wrote(0), Vec::new());
    let mut buffer = vec![0u8; 4096];
    let error =
        read_journal_page(&io, ReadJournalRequest::from_start(7, 100), &mut buffer).unwrap_err();
    assert_eq!(error, WinfsError::Incomplete);
    assert_eq!(error.code(), "WINFS_INCOMPLETE_PAGE");
    assert_eq!(
        error.source_error(),
        ops_index::SourceError::Io(ErrorKind::InvalidData)
    );
}

#[test]
fn a_misreported_length_is_rejected() {
    let io = FakeIo::reporting(
        FSCTL_READ_USN_JOURNAL,
        PageOutcome::Wrote(4096),
        vec![0u8; 8],
    );
    let mut buffer = vec![0u8; 16];
    let error =
        read_journal_page(&io, ReadJournalRequest::from_start(7, 100), &mut buffer).unwrap_err();
    assert_eq!(error, WinfsError::Io(ErrorKind::InvalidData));
}

#[test]
fn a_malformed_page_maps_to_rescan() {
    // Leading USN plus a record that claims more bytes than the page holds.
    let mut page = journal_page(130, &[]);
    page.extend_from_slice(&100u32.to_le_bytes());
    page.extend_from_slice(&[0u8; 4]);
    let io = FakeIo::replying(FSCTL_READ_USN_JOURNAL, page);
    let mut buffer = vec![0u8; 4096];
    let error =
        read_journal_page(&io, ReadJournalRequest::from_start(7, 100), &mut buffer).unwrap_err();
    assert!(matches!(
        error,
        WinfsError::Malformed(WalkError::RecordOverrun { offset: 8 })
    ));
    assert_eq!(
        error.source_error(),
        ops_index::SourceError::Io(ErrorKind::InvalidData)
    );
}

#[test]
fn the_start_helper_uses_the_index_reason_mask() {
    let request = ReadJournalRequest::from_start(7, 100);
    assert_eq!(request.journal_id, 7);
    assert_eq!(request.start_usn, 100);
    assert_eq!(request.reason_mask, ops_index::usn::REASON_MASK);
    assert!(!request.return_only_on_close);
    assert_eq!(request.timeout_100ns, 0);
    assert_eq!(request.bytes_to_wait_for, 0);
}

#[test]
fn a_short_buffer_is_refused_before_the_kernel_call() {
    let io = FakeIo::end_of_data(FSCTL_READ_USN_JOURNAL);
    let mut buffer = [0u8; 3];
    let error =
        read_journal_page(&io, ReadJournalRequest::from_start(7, 100), &mut buffer).unwrap_err();
    assert_eq!(error, WinfsError::Io(ErrorKind::InvalidInput));
    assert!(io.captured().is_empty());
}
