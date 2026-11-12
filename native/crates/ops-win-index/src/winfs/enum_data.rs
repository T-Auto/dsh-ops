// Design informed by mustafaahci/goz (MIT).

//! `FSCTL_ENUM_USN_DATA` pages: the fallback cold enumeration.
//!
//! The request is the V0 layout the kernel accepts: a start file reference
//! number and the USN interval to include. The caller owns the page buffer and
//! loops until [`EnumPage::more`] is false, which is what makes the scan
//! resumable and bounded without a second enumeration API.
//!
//! Record parsing is not repeated here: the page is handed to
//! `ops_index::usn::walk_enum_buffer`, which validates every record and rejects
//! the whole page on the first structural defect. A malformed page maps to
//! [`WinfsError::Malformed`], i.e. "rescan", never "skip and continue".

use crate::winfs::FSCTL_ENUM_USN_DATA;
use crate::winfs::error::WinfsError;
use crate::winfs::sys::{PageOutcome, VolumeIo};
use ops_index::usn::ParsedUsnRecord;
use ops_index::usn::{LEADING_VALUE_LEN, SkipCounts, walk_enum_buffer};
use std::io::ErrorKind;

/// Size of the encoded `MFT_ENUM_DATA_V0` request.
pub const ENUM_REQUEST_LEN: usize = 24;

/// One `FSCTL_ENUM_USN_DATA` request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnumRequest {
    /// `StartFileReferenceNumber`: continue after this file reference.
    pub start: u64,
    /// `LowUsn`: only records at or above this journal offset.
    pub low_usn: i64,
    /// `HighUsn`: only records below this journal offset.
    pub high_usn: i64,
}

impl EnumRequest {
    /// Every record in the journal window, from the first file reference.
    pub const fn from_start(start: u64) -> Self {
        Self {
            start,
            low_usn: 0,
            high_usn: i64::MAX,
        }
    }

    /// The little-endian `MFT_ENUM_DATA_V0` bytes `DeviceIoControl` expects.
    pub(crate) fn encode(&self) -> [u8; ENUM_REQUEST_LEN] {
        let mut bytes = [0u8; ENUM_REQUEST_LEN];
        bytes[0..8].copy_from_slice(&self.start.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.low_usn.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.high_usn.to_le_bytes());
        bytes
    }
}

/// One decoded enumeration page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnumPage {
    /// Next `StartFileReferenceNumber`; zero means the enumeration is done.
    pub next_start: u64,
    /// Records in kernel order; no sorting and no deduplication.
    pub records: Vec<ParsedUsnRecord>,
    /// Records skipped by version.
    pub skipped: SkipCounts,
    /// Whether the caller should request another page.
    pub more: bool,
    /// Output bytes the kernel claims to have written.
    pub bytes: usize,
}

/// Reads one enumeration page into `buffer`.
///
/// `buffer` must hold at least [`LEADING_VALUE_LEN`] bytes so a non-empty page
/// can be parsed; smaller buffers are `InvalidInput` rather than an endless
/// loop of empty pages.
///
/// # Errors
///
/// - [`WinfsError::Malformed`] when the kernel's page fails record parsing
///   (the caller must rescan);
/// - [`WinfsError::Io`] / [`WinfsError::AccessDenied`] /
///   [`WinfsError::Unsupported`] / [`WinfsError::Fsctl`] from the kernel call.
pub fn read_enum_page(
    io: &impl VolumeIo,
    request: EnumRequest,
    buffer: &mut [u8],
) -> Result<EnumPage, WinfsError> {
    if buffer.len() < LEADING_VALUE_LEN {
        return Err(WinfsError::Io(ErrorKind::InvalidInput));
    }
    let input = request.encode();
    let written = match io.device_io_control(FSCTL_ENUM_USN_DATA, &input, buffer)? {
        // ERROR_HANDLE_EOF: the enumeration is complete.
        PageOutcome::EndOfData => {
            return Ok(EnumPage {
                next_start: 0,
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
    let walk = walk_enum_buffer(page).map_err(WinfsError::Malformed)?;
    Ok(EnumPage {
        next_start: walk.next_start,
        records: walk.records,
        skipped: walk.skipped,
        more: walk.next_start != 0,
        bytes: written,
    })
}

#[cfg(test)]
#[path = "enum_tests.rs"]
mod enum_tests;
