//! Kernel-owned shell ranges. Callers supply trusted, host-confined argv;
//! this layer never resolves authority, modifies argv, or publishes sessions.
use std::{ffi::OsString, io, path::PathBuf};

pub struct Launch {
    pub argv: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: Vec<(OsString, OsString)>,
    pub output_cap: usize,
}
#[derive(Default, Debug)]
pub struct Capture {
    pub bytes: Vec<u8>,
    pub observed: u64,
    pub truncated: bool,
}
#[cfg(any(windows, test))]
impl Capture {
    pub(crate) fn append(&mut self, bytes: &[u8], cap: usize) {
        self.observed = self.observed.saturating_add(bytes.len() as u64);
        self.truncated |= bytes.len() > cap.saturating_sub(self.bytes.len());
        let keep = bytes.len().min(cap.saturating_sub(self.bytes.len()));
        self.bytes.extend_from_slice(&bytes[..keep]);
    }
}
#[cfg(any(windows, test))]
pub(crate) fn budget(cap: usize) -> io::Result<()> {
    if (1..=128 * 1024).contains(&cap) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "capture cap must be 1..128 KiB",
        ))
    }
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{Channel, ChannelSnapshot, Range, signal_console_and_exit};

/// POSIX group creation would escape the public host's PGID fallback owner.
/// No reduced ownership implementation is silently substituted here.
#[cfg(not(windows))]
pub fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "owned shell ranges require Windows Jobs; POSIX containment is not established",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_keeps_a_bounded_prefix_and_counts_every_observed_byte() {
        let mut capture = Capture::default();
        capture.append(b"abc", 4);
        capture.append(b"defghi", 4);
        assert_eq!(capture.bytes, b"abcd");
        assert_eq!(capture.observed, 9);
        assert!(capture.truncated);
        assert!(budget(0).is_err());
        assert!(budget(128 * 1024 + 1).is_err());
        assert!(budget(128 * 1024).is_ok());
    }
    #[cfg(not(windows))]
    #[test]
    fn posix_does_not_substitute_an_unowned_process_group() {
        assert_eq!(unsupported().kind(), io::ErrorKind::Unsupported);
    }
}
