// Design informed by mustafaahci/goz (MIT).

//! Failure vocabulary of the raw FSCTL fallback.
//!
//! The variants describe what the caller has to do, not which syscall failed:
//! [`WinfsError::AccessDenied`] and [`WinfsError::Unsupported`] mean "this
//! volume cannot be served this way — fall back", [`WinfsError::Malformed`]
//! means "the page is untrustworthy — rescan, never skip and continue", and the
//! rest are diagnostics.

use ops_index::SourceError;
use ops_index::usn::WalkError;
use std::fmt;
use std::io::ErrorKind;

/// Why one raw FSCTL page could not be produced or trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinfsError {
    /// The kernel call failed with an ordinary I/O error kind.
    Io(ErrorKind),
    /// The volume handle could not be opened for lack of elevation.
    ///
    /// This is the documented non-Administrator fallback, mapped to
    /// [`SourceError::Unsupported`]: the caller keeps its own traversal.
    AccessDenied,
    /// The volume or the request cannot be served through these FSCTLs
    /// (not NTFS, not a volume root, an unsupported control code).
    Unsupported,
    /// The kernel signalled more data but wrote no bytes: the page is
    /// truncated and must not be mistaken for a clean end.
    Incomplete,
    /// Any other Win32 error code, kept verbatim for diagnostics.
    Fsctl(u32),
    /// The returned page failed record parsing in `ops-index`.
    ///
    /// The page is rejected as a whole; a partial set must never look complete.
    Malformed(WalkError),
}

impl WinfsError {
    /// Maps the failure onto the source boundary's error vocabulary.
    ///
    /// - no elevation, or a volume these FSCTLs cannot serve: `Unsupported`, so
    ///   the caller falls back to its own traversal;
    /// - a malformed page: `Io(InvalidData)`, so the caller discards the index
    ///   result and rescans;
    /// - anything else: the original I/O kind, or `Io(Other)` for a bare Win32
    ///   code.
    pub fn source_error(self) -> SourceError {
        match self {
            Self::AccessDenied | Self::Unsupported => SourceError::Unsupported,
            Self::Malformed(_) | Self::Incomplete => SourceError::Io(ErrorKind::InvalidData),
            Self::Io(kind) => SourceError::Io(kind),
            Self::Fsctl(_) => SourceError::Io(ErrorKind::Other),
        }
    }

    /// Stable, machine-readable code for diagnostics and tests.
    pub fn code(self) -> &'static str {
        match self {
            Self::Io(_) => "WINFS_IO",
            Self::AccessDenied => "WINFS_ACCESS_DENIED",
            Self::Unsupported => "WINFS_UNSUPPORTED",
            Self::Fsctl(_) => "WINFS_FSCTL",
            Self::Malformed(_) => "WINFS_MALFORMED_PAGE",
            Self::Incomplete => "WINFS_INCOMPLETE_PAGE",
        }
    }
}

impl fmt::Display for WinfsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(kind) => write!(f, "raw FSCTL failed: {kind:?}"),
            Self::AccessDenied => f.write_str("volume handle requires elevation"),
            Self::Unsupported => f.write_str("volume cannot be served through raw FSCTLs"),
            Self::Fsctl(code) => write!(f, "raw FSCTL failed with Win32 error {code}"),
            Self::Malformed(error) => write!(f, "USN page is malformed: {error}"),
            Self::Incomplete => f.write_str("USN page was truncated before it could be read"),
        }
    }
}

impl std::error::Error for WinfsError {}

#[cfg(test)]
#[path = "error_tests.rs"]
mod error_tests;
