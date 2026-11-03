// Design informed by mustafaahci/goz (MIT).

//! Test-only USN builders and a fake kernel.
//!
//! The buffers are assembled byte by byte from the documented V2 layout, so a
//! page test asserts the same bytes a real kernel would hand back without
//! needing NTFS or elevation. [`FakeIo`] records the encoded request and
//! replays a prepared page, which is what makes request layout, page decoding
//! and failure mapping unit-testable.

use crate::winfs::error::WinfsError;
use crate::winfs::sys::VolumeIo;
use std::cell::RefCell;

/// One V2 USN record with the given fields, packed without padding.
pub fn v2_record(
    record: u64,
    parent: u64,
    usn: i64,
    reason: u32,
    attributes: u32,
    name: &str,
) -> Vec<u8> {
    let units: Vec<u16> = name.encode_utf16().collect();
    let name_len = units.len() * 2;
    let length = 60 + name_len;
    let mut bytes = vec![0u8; length];
    bytes[0..4].copy_from_slice(&(length as u32).to_le_bytes());
    bytes[4..6].copy_from_slice(&2u16.to_le_bytes());
    bytes[6..8].copy_from_slice(&0u16.to_le_bytes());
    bytes[8..16].copy_from_slice(&record.to_le_bytes());
    bytes[16..24].copy_from_slice(&parent.to_le_bytes());
    bytes[24..32].copy_from_slice(&usn.to_le_bytes());
    bytes[56..58].copy_from_slice(&(name_len as u16).to_le_bytes());
    bytes[58..60].copy_from_slice(&60u16.to_le_bytes());
    bytes[40..44].copy_from_slice(&reason.to_le_bytes());
    bytes[52..56].copy_from_slice(&attributes.to_le_bytes());
    for (index, unit) in units.iter().enumerate() {
        let at = 60 + index * 2;
        bytes[at..at + 2].copy_from_slice(&unit.to_le_bytes());
    }
    bytes
}

/// An enumeration page: the leading next-start value and its records.
pub fn enum_page(next_start: u64, records: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&next_start.to_le_bytes());
    for record in records {
        bytes.extend_from_slice(record);
    }
    bytes
}

/// A journal page: the leading next USN and its records.
pub fn journal_page(next_usn: i64, records: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&next_usn.to_le_bytes());
    for record in records {
        bytes.extend_from_slice(record);
    }
    bytes
}

/// A kernel that replays one prepared page, or one prepared failure.
#[derive(Debug)]
pub struct FakeIo {
    code: u32,
    output: Vec<u8>,
    written: Option<usize>,
    failure: Option<WinfsError>,
    captured: RefCell<Vec<u8>>,
}

impl FakeIo {
    /// Replies to `code` with `output`.
    pub fn replying(code: u32, output: Vec<u8>) -> Self {
        Self {
            code,
            output,
            written: None,
            failure: None,
            captured: RefCell::new(Vec::new()),
        }
    }

    /// Replies to `code` with `written` output bytes, without a page.
    pub fn writing(code: u32, written: usize) -> Self {
        Self {
            code,
            output: Vec::new(),
            written: Some(written),
            failure: None,
            captured: RefCell::new(Vec::new()),
        }
    }

    /// Fails the call with `error`.
    pub fn failing(code: u32, error: WinfsError) -> Self {
        Self {
            code,
            output: Vec::new(),
            written: None,
            failure: Some(error),
            captured: RefCell::new(Vec::new()),
        }
    }

    /// The request bytes the page function encoded.
    pub fn captured(&self) -> Vec<u8> {
        self.captured.borrow().clone()
    }
}

impl VolumeIo for FakeIo {
    fn device_io_control(
        &self,
        code: u32,
        input: &[u8],
        output: &mut [u8],
    ) -> Result<usize, WinfsError> {
        assert_eq!(code, self.code, "wrong control code");
        *self.captured.borrow_mut() = input.to_vec();
        if let Some(error) = self.failure {
            return Err(error);
        }
        let written = self.written.unwrap_or(self.output.len()).min(output.len());
        output[..written].copy_from_slice(&self.output[..written]);
        Ok(written)
    }
}
