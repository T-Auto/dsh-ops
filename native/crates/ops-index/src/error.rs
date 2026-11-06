//! Decoding errors for byte buffers handed to this crate.

use std::fmt;

/// A byte-buffer parser rejected its input.
///
/// Every variant carries the absolute offset inside the buffer where decoding
/// stopped. Offsets are part of the contract: a platform crate maps them into
/// diagnostics, and tests assert them exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Error {
    /// A fixed structure or payload ran past the end of the buffer.
    Truncated {
        /// Name of the structure being decoded.
        what: &'static str,
        /// Absolute offset where decoding stopped.
        offset: usize,
        /// Bytes required to continue.
        need: usize,
        /// Bytes actually available from `offset`.
        len: usize,
    },
    /// An offset pointed outside the buffer.
    OffsetOutOfBounds {
        /// Name of the field that carried the offset.
        what: &'static str,
        /// Absolute offset that was rejected.
        offset: usize,
        /// Buffer length that the offset was compared against.
        len: usize,
    },
    /// A relative offset did not advance past its own structure.
    ///
    /// Following it again would loop forever, so the chain is rejected before
    /// the walk can hang.
    OffsetCycle {
        /// Name of the chain that failed to advance.
        what: &'static str,
        /// Absolute offset of the structure that carried the offset.
        offset: usize,
        /// Relative offset that was rejected.
        rel: u32,
        /// Smallest relative offset that would have advanced.
        min: usize,
    },
    /// A UTF-16 byte length was odd.
    OddUtf16Length {
        /// Name of the field that carried the length.
        what: &'static str,
        /// Absolute offset of the structure that carried the length.
        offset: usize,
        /// The odd byte length.
        len: u32,
    },
    /// One page asked for more decoded structures than its own size allows.
    ///
    /// Every file, name, stream and info entry costs one step, and the page
    /// grants at most one step per byte. A well-formed page never comes close:
    /// each structure occupies at least 24 bytes of the page. The budget only
    /// trips when several files share satellite chains, which multiplies the
    /// work a page can request without growing the page; the whole page is
    /// rejected rather than decoded, so such amplification cannot occupy a
    /// worker.
    PageBudgetExceeded {
        /// Name of the structure whose step ran out of budget.
        what: &'static str,
        /// Steps the page granted (its byte length).
        limit: usize,
    },
    /// One page asked for more payload bytes than its own size allows.
    ///
    /// Name payloads and stream identifiers are charged against a budget equal
    /// to the page length. A well-formed page stores every payload byte exactly
    /// once, so the budget is exact for real pages; sharing a chain between
    /// several files would decode the same bytes repeatedly and is rejected.
    PayloadBudgetExceeded {
        /// Name of the payload field that ran out of budget.
        what: &'static str,
        /// Payload bytes the page granted (its byte length).
        limit: usize,
    },
    /// A name length exceeded the contract maximum.
    NameTooLong {
        /// Name of the field that carried the length.
        what: &'static str,
        /// Absolute offset of the structure that carried the length.
        offset: usize,
        /// The rejected byte length.
        len: u32,
        /// The maximum accepted byte length.
        max: u32,
    },
}

impl Error {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Truncated { .. } => "INDEX_TRUNCATED",
            Self::OffsetOutOfBounds { .. } => "INDEX_OFFSET_OUT_OF_BOUNDS",
            Self::OffsetCycle { .. } => "INDEX_OFFSET_CYCLE",
            Self::OddUtf16Length { .. } => "INDEX_ODD_UTF16_LENGTH",
            Self::NameTooLong { .. } => "INDEX_NAME_TOO_LONG",
            Self::PageBudgetExceeded { .. } => "INDEX_LAYOUT_PAGE_BUDGET",
            Self::PayloadBudgetExceeded { .. } => "INDEX_LAYOUT_PAYLOAD_BUDGET",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated {
                what,
                offset,
                need,
                len,
            } => write!(
                f,
                "{what} truncated at offset {offset}: need {need} bytes, have {len}"
            ),
            Self::OffsetOutOfBounds { what, offset, len } => {
                write!(
                    f,
                    "{what} offset {offset} is outside the buffer of {len} bytes"
                )
            }
            Self::OffsetCycle {
                what,
                offset,
                rel,
                min,
            } => write!(
                f,
                "{what} at offset {offset} does not advance: relative offset {rel} is below {min}"
            ),
            Self::OddUtf16Length { what, offset, len } => write!(
                f,
                "{what} at offset {offset} has odd UTF-16 byte length {len}"
            ),
            Self::NameTooLong {
                what,
                offset,
                len,
                max,
            } => write!(
                f,
                "{what} at offset {offset} has byte length {len}, above the maximum of {max}"
            ),
            Self::PageBudgetExceeded { what, limit } => write!(
                f,
                "{what} exceeded the page-wide structure budget of {limit} steps"
            ),
            Self::PayloadBudgetExceeded { what, limit } => write!(
                f,
                "{what} exceeded the page-wide payload budget of {limit} bytes"
            ),
        }
    }
}

impl std::error::Error for Error {}

/// Result alias for byte-buffer decoding.
pub type Result<T> = core::result::Result<T, Error>;
#[cfg(test)]
#[path = "error_tests.rs"]
mod error_tests;
