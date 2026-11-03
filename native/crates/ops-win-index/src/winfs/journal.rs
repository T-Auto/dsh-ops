// Design informed by mustafaahci/goz (MIT).

//! `FSCTL_READ_USN_JOURNAL` pages: the fallback journal replay.
//!
//! The request exposes what usn-journal-rs keeps private: the reason mask, the
//! `ReturnOnlyOnClose` shortcut, the wait hint, and the exact journal id the
//! cursor was taken from. A caller replays from [`ReadJournalRequest::start_usn`]
//! and advances by [`JournalPage::next_usn`], which is the leading value of the
//! buffer and the only cursor `ops-index` persists.
//!
//! Record parsing stays in `ops_index::usn::walk_journal_buffer`; a malformed
//! page maps to [`WinfsError::Malformed`] and means rescan.

use crate::winfs::FSCTL_READ_USN_JOURNAL;
use crate::winfs::error::WinfsError;
use crate::winfs::sys::{PageOutcome, VolumeIo};
use ops_index::usn::{
    LEADING_VALUE_LEN, ParsedUsnRecord, REASON_MASK, SkipCounts, walk_journal_buffer,
};
use std::io::ErrorKind;

/// Size of the encoded `READ_USN_JOURNAL_DATA_V0` request.
pub const READ_JOURNAL_REQUEST_LEN: usize = 40;

/// One `FSCTL_READ_USN_JOURNAL` request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadJournalRequest {
    /// Journal instance the cursor belongs to.
    pub journal_id: u64,
    /// `StartUsn`: replay records at or after this journal offset.
    pub start_usn: i64,
    /// Reasons to include; [`REASON_MASK`] keeps everything the index maps.
    pub reason_mask: u32,
    /// Whether to return only records accumulated up to a close.
    pub return_only_on_close: bool,
    /// Relative wait in 100 ns ticks; zero does not wait.
    pub timeout_100ns: u64,
    /// Bytes to wait for before returning; zero returns what is available.
    pub bytes_to_wait_for: u64,
}

impl ReadJournalRequest {
    /// Replays everything from `start_usn` with the index's reason mask.
    pub const fn from_start(journal_id: u64, start_usn: i64) -> Self {
        Self {
            journal_id,
            start_usn,
            reason_mask: REASON_MASK,
            return_only_on_close: false,
            timeout_100ns: 0,
            bytes_to_wait_for: 0,
        }
    }

    /// The little-endian `READ_USN_JOURNAL_DATA_V0` bytes.
    pub(crate) fn encode(&self) -> [u8; READ_JOURNAL_REQUEST_LEN] {
        let mut bytes = [0u8; READ_JOURNAL_REQUEST_LEN];
        bytes[0..8].copy_from_slice(&self.start_usn.to_le_bytes());
        bytes[8..12].copy_from_slice(&self.reason_mask.to_le_bytes());
        bytes[12..16].copy_from_slice(&u32::from(self.return_only_on_close).to_le_bytes());
        bytes[16..24].copy_from_slice(&self.timeout_100ns.to_le_bytes());
        bytes[24..32].copy_from_slice(&self.bytes_to_wait_for.to_le_bytes());
        bytes[32..40].copy_from_slice(&self.journal_id.to_le_bytes());
        bytes
    }
}

/// One decoded journal page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalPage {
    /// Next USN to request; the leading value of the kernel's buffer.
    pub next_usn: i64,
    /// Records in journal order.
    pub records: Vec<ParsedUsnRecord>,
    /// Records skipped by version.
    pub skipped: SkipCounts,
    /// Whether any record arrived.
    pub more: bool,
    /// Output bytes the kernel claims to have written.
    pub bytes: usize,
}

/// Reads one journal page into `buffer`.
///
/// An empty page keeps `next_usn` at the requested start, so a caller that
/// polls in a loop does not lose its place.
///
/// # Errors
///
/// - [`WinfsError::Malformed`] when the page fails record parsing (rescan);
/// - [`WinfsError::Io`] / [`WinfsError::AccessDenied`] /
///   [`WinfsError::Unsupported`] / [`WinfsError::Fsctl`] from the kernel call.
pub fn read_journal_page(
    io: &impl VolumeIo,
    request: ReadJournalRequest,
    buffer: &mut [u8],
) -> Result<JournalPage, WinfsError> {
    if buffer.len() < LEADING_VALUE_LEN {
        return Err(WinfsError::Io(ErrorKind::InvalidInput));
    }
    let input = request.encode();
    let written = match io.device_io_control(FSCTL_READ_USN_JOURNAL, &input, buffer)? {
        PageOutcome::EndOfData => {
            return Ok(JournalPage {
                next_usn: request.start_usn,
                records: Vec::new(),
                skipped: SkipCounts::default(),
                more: false,
                bytes: 0,
            });
        }
        // The kernel had more data but wrote none: truncated, not complete.
        PageOutcome::Wrote(0) => return Err(WinfsError::Incomplete),
        PageOutcome::Wrote(written) => written,
    };
    if written > buffer.len() {
        return Err(WinfsError::Io(ErrorKind::InvalidData));
    }
    let page = &buffer[..written];
    let walk = walk_journal_buffer(page).map_err(WinfsError::Malformed)?;
    let more = !walk.records.is_empty();
    Ok(JournalPage {
        next_usn: walk.next_usn,
        records: walk.records,
        skipped: walk.skipped,
        more,
        bytes: written,
    })
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod journal_tests;
