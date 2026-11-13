//! Bounded raw stream storage shared by private channels and process stdio.
use std::{
    io,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Retention {
    Prefix,
    Tail,
}

#[derive(Clone, Default, Debug)]
pub struct Capture {
    pub bytes: Vec<u8>,
    pub observed: u64,
    pub truncated: bool,
}
impl Capture {
    #[cfg(any(windows, test))]
    pub(crate) fn append(&mut self, bytes: &[u8], cap: usize) {
        self.append_with(bytes, cap, Retention::Prefix);
    }
    #[cfg(any(windows, test))]
    fn append_with(&mut self, bytes: &[u8], cap: usize, retention: Retention) {
        self.observed = self.observed.saturating_add(bytes.len() as u64);
        self.truncated |= bytes.len() > cap.saturating_sub(self.bytes.len());
        match retention {
            Retention::Prefix => {
                let keep = bytes.len().min(cap.saturating_sub(self.bytes.len()));
                self.bytes.extend_from_slice(&bytes[..keep]);
            }
            Retention::Tail => {
                if bytes.len() >= cap {
                    self.bytes.clear();
                    self.bytes.extend_from_slice(&bytes[bytes.len() - cap..]);
                } else {
                    let discard = bytes.len().saturating_sub(cap - self.bytes.len());
                    self.bytes.drain(..discard);
                    self.bytes.extend_from_slice(bytes);
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct SpillSnapshot {
    pub path: PathBuf,
    pub pid: u32,
    pub sealed: bool,
}
#[derive(Clone, Debug)]
pub struct CaptureSnapshot {
    pub bytes: Vec<u8>,
    pub observed: u64,
    pub retained_offset: u64,
    pub truncated: bool,
    /// True only after the reader observed EOF. It does not certify range exit.
    pub eof: bool,
    pub error: Option<String>,
    pub spill: Option<SpillSnapshot>,
    pub spill_error: Option<String>,
    pub cleanup_unconfirmed: bool,
}
#[derive(Debug)]
pub struct CaptureRead {
    pub bytes: Vec<u8>,
    pub offset: u64,
    /// Whole-stream byte coordinate; callers keep independent cursors.
    pub next_offset: u64,
    pub lossy: bool,
    pub eof: bool,
    pub error: Option<String>,
    pub spill: Option<SpillSnapshot>,
    pub spill_error: Option<String>,
}

struct State {
    capture: Capture,
    #[cfg(any(windows, test))]
    cap: usize,
    retention: Retention,
    eof: bool,
    error: Option<String>,
    spill: Option<SpillSnapshot>,
    spill_error: Option<String>,
    cleanup_unconfirmed: bool,
}
/// Cloning a view shares a bounded buffer, never a consuming reader cursor.
#[derive(Clone)]
pub struct CaptureView(Arc<Mutex<State>>);
impl CaptureView {
    #[cfg(any(windows, test))]
    pub(crate) fn new(cap: usize, retention: Retention) -> io::Result<Self> {
        super::budget(cap)?;
        Ok(Self(Arc::new(Mutex::new(State {
            capture: Capture::default(),
            cap,
            retention,
            eof: false,
            error: None,
            spill: None,
            spill_error: None,
            cleanup_unconfirmed: false,
        }))))
    }
    pub fn snapshot(&self) -> CaptureSnapshot {
        let state = self.0.lock().unwrap();
        CaptureSnapshot {
            bytes: state.capture.bytes.clone(),
            observed: state.capture.observed,
            retained_offset: match state.retention {
                Retention::Prefix => 0,
                Retention::Tail => state.capture.observed - state.capture.bytes.len() as u64,
            },
            truncated: state.capture.truncated,
            eof: state.eof,
            error: state.error.clone(),
            spill: state.spill.clone(),
            spill_error: state.spill_error.clone(),
            cleanup_unconfirmed: state.cleanup_unconfirmed,
        }
    }
    pub fn read_from(&self, offset: u64) -> io::Result<CaptureRead> {
        let snapshot = self.snapshot();
        if offset > snapshot.observed {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "output cursor exceeds observed bytes",
            ));
        }
        let end = snapshot.retained_offset + snapshot.bytes.len() as u64;
        let start = offset.max(snapshot.retained_offset);
        let bytes = snapshot.bytes[(start.min(end) - snapshot.retained_offset) as usize..].to_vec();
        Ok(CaptureRead {
            bytes,
            offset: start,
            next_offset: snapshot.observed,
            lossy: offset < snapshot.retained_offset
                || (end < snapshot.observed && offset < snapshot.observed),
            eof: snapshot.eof,
            error: snapshot.error,
            spill: snapshot.spill,
            spill_error: snapshot.spill_error,
        })
    }
    #[cfg(test)]
    pub(crate) fn append(&self, bytes: &[u8]) -> u64 {
        self.commit(bytes, None, None)
    }
    #[cfg(any(windows, test))]
    pub(crate) fn commit(
        &self,
        bytes: &[u8],
        spill: Option<SpillSnapshot>,
        spill_error: Option<String>,
    ) -> u64 {
        let mut state = self.0.lock().unwrap();
        let (cap, retention) = (state.cap, state.retention);
        state.capture.append_with(bytes, cap, retention);
        state.spill = spill;
        state.spill_error = spill_error;
        state.capture.observed
    }
    #[cfg(windows)]
    pub(crate) fn poison(&self, error: String) {
        let mut state = self.0.lock().unwrap();
        state.spill = None;
        state.spill_error = Some(error);
        state.cleanup_unconfirmed = true;
    }
    #[cfg(any(windows, test))]
    pub(crate) fn finish(&self, result: &io::Result<()>) -> Capture {
        let mut state = self.0.lock().unwrap();
        state.eof = result.is_ok();
        state.error = result.as_ref().err().map(ToString::to_string);
        state.capture.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_cursors_are_independent_and_empty_live_reads_are_not_eof() {
        let view = CaptureView::new(4, Retention::Tail).unwrap();
        let second = view.clone();
        assert!(!view.read_from(0).unwrap().eof);
        view.append(b"abc");
        assert_eq!(view.read_from(1).unwrap().bytes, b"bc");
        view.append(b"def");
        let read = second.read_from(0).unwrap();
        assert_eq!((read.offset, read.next_offset, read.lossy), (2, 6, true));
        assert_eq!(read.bytes, b"cdef");
        assert_eq!(view.read_from(3).unwrap().bytes, b"def");
        let empty = view.read_from(6).unwrap();
        assert!(empty.bytes.is_empty());
        assert!(!empty.eof);
        assert!(!empty.lossy);
        view.append(b"0123456789");
        assert_eq!(view.snapshot().bytes, b"6789");
        assert_eq!(view.snapshot().retained_offset, 12);
        view.finish(&Ok(()));
        assert!(view.read_from(16).unwrap().eof);
        assert!(view.read_from(17).is_err());
    }

    #[test]
    fn prefix_retention_reports_unrecoverable_suffix_and_read_error_is_not_eof() {
        let view = CaptureView::new(4, Retention::Prefix).unwrap();
        view.append(b"abcdef");
        let read = view.read_from(0).unwrap();
        assert_eq!(read.bytes, b"abcd");
        assert_eq!((read.offset, read.next_offset, read.lossy), (0, 6, true));
        let end = view.read_from(6).unwrap();
        assert_eq!(end.offset, 6);
        assert!(!end.lossy);
        let failure = Err(io::Error::other("reader failed"));
        view.finish(&failure);
        let snapshot = view.snapshot();
        assert_eq!(snapshot.error.as_deref(), Some("reader failed"));
        assert!(!snapshot.eof);
        assert_eq!(snapshot.observed, 6);
    }

    #[test]
    fn cursors_are_raw_bytes_even_inside_utf8_units() {
        let view = CaptureView::new(4, Retention::Tail).unwrap();
        view.append("中文".as_bytes());
        let read = view.read_from(0).unwrap();
        assert_eq!(read.bytes, &"中文".as_bytes()[2..]);
        assert_eq!((read.offset, read.next_offset), (2, 6));
        assert_eq!(view.read_from(3).unwrap().bytes, "文".as_bytes());
        assert!(!view.read_from(3).unwrap().lossy);
    }
}
