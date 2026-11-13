//! Platform boundary for inherited control and kernel-owned, one-request execution leaves.
#![deny(unsafe_op_in_unsafe_fn)]
pub mod leaf;
pub mod shell;
use std::io::{self, BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
#[path = "unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "windows.rs"]
mod platform;

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
static TAKEN: AtomicBool = AtomicBool::new(false);
pub struct ControlPipe(platform::Pipe);

impl ControlPipe {
    /// Take the provider's fd 7 once, at executable startup before other I/O or threads.
    /// The marker is launch metadata, not authority. Future children must exclude it.
    pub fn inherited() -> io::Result<Self> {
        if std::env::var_os("DSH_SUBPROCESS_CONTROL").as_deref()
            != Some(std::ffi::OsStr::new("pipe"))
            || TAKEN.swap(true, Ordering::AcqRel)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "control pipe was not inherited or was already taken",
            ));
        }
        platform::inherited().map(Self)
    }
    pub fn try_clone(&self) -> io::Result<Self> {
        self.0.try_clone().map(Self)
    }
    /// End both directions on every clone, including pending I/O and future writes.
    pub fn shutdown(&self) -> io::Result<()> {
        platform::shutdown(&self.0)
    }
}

#[cfg(test)]
mod control_tests;
impl Read for ControlPipe {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.read(bytes)
    }
}
impl Write for ControlPipe {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

/// Bounded newline framing; a partial final frame is a protocol failure, not EOF.
pub fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    read_frame_limit(reader, MAX_FRAME_BYTES)
}
/// The caller selects its protocol's total frame cap, including the newline.
pub fn read_frame_limit(
    reader: &mut impl BufRead,
    max_bytes: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    reader
        .take(max_bytes.saturating_add(1) as u64)
        .read_until(b'\n', &mut frame)?;
    if frame.is_empty() {
        return Ok(None);
    }
    if frame.len() > max_bytes || frame.last() != Some(&b'\n') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "oversized or incomplete control frame",
        ));
    }
    Ok(Some(frame))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_are_bounded_and_eof_is_not_a_receipt() {
        let mut input = &b"{}\n{\"id\":2}\n"[..];
        assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"{}\n");
        assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"{\"id\":2}\n");
        assert!(read_frame(&mut input).unwrap().is_none());
        assert!(read_frame(&mut &b"{}"[..]).is_err());
        let mut exact = vec![b' '; MAX_FRAME_BYTES];
        exact[MAX_FRAME_BYTES - 1] = b'\n';
        assert_eq!(
            read_frame(&mut exact.as_slice()).unwrap().unwrap().len(),
            MAX_FRAME_BYTES
        );
        let mut large = vec![b' '; MAX_FRAME_BYTES + 1];
        large[MAX_FRAME_BYTES] = b'\n';
        assert!(read_frame(&mut large.as_slice()).is_err());
        assert!(read_frame_limit(&mut &b"{}\n"[..], 2).is_err());
        assert_eq!(
            read_frame_limit(&mut &b"{}\n"[..], 3).unwrap().unwrap(),
            b"{}\n"
        );
    }
}
