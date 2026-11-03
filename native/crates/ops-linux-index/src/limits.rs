// Design informed by mustafaahci/goz (MIT).
//! inotify limits and the degradation policy for a Linux watch session.
//!
//! The kernel bounds how many directories one user may watch. Adding one watch
//! past that bound fails with ENOSPC; running out of instances or of process
//! file descriptors fails with EMFILE/ENFILE. None of those failures may be
//! treated as "no events happened": the session must degrade to polling and
//! say so, because a watcher that quietly stops delivering events is exactly
//! the stale-index failure the ownership boundary forbids.
//!
//! The values live in procfs:
//!
//! - `/proc/sys/fs/inotify/max_user_watches`
//! - `/proc/sys/fs/inotify/max_user_instances`
//! - `/proc/sys/fs/inotify/max_queued_events`
//!
//! Reading them through a path parameter keeps the parser testable without a
//! kernel mount, and the classifier takes an [`io::Error`] so the watcher can
//! map a notify error onto the same three cases.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Where the live inotify limits are exposed.
pub const PROC_INOTIFY_DIR: &str = "/proc/sys/fs/inotify";

/// Linux `ENOSPC`: the user's inotify watch budget is exhausted.
const ENOSPC: i32 = 28;
/// Linux `ENFILE`: the system-wide file descriptor table is full.
const ENFILE: i32 = 23;
/// Linux `EMFILE`: this process' file descriptor table is full.
const EMFILE: i32 = 24;

/// Kernel inotify limits for the current user namespace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatchLimits {
    /// Maximum number of inotify watches a user may hold
    /// (`max_user_watches`).
    pub max_user_watches: u64,
    /// Maximum number of inotify instances a user may create
    /// (`max_user_instances`).
    pub max_user_instances: u64,
    /// Maximum number of queued events before the kernel drops the oldest
    /// (`max_queued_events`).
    pub max_queued_events: u64,
}

impl WatchLimits {
    /// Reads the three limits from `dir` (normally [`PROC_INOTIFY_DIR`]).
    pub fn read_from(dir: &Path) -> Result<Self, io::Error> {
        Ok(Self {
            max_user_watches: read_limit(dir, "max_user_watches")?,
            max_user_instances: read_limit(dir, "max_user_instances")?,
            max_queued_events: read_limit(dir, "max_queued_events")?,
        })
    }

    /// Reads the live limits from procfs.
    pub fn read_live() -> Result<Self, io::Error> {
        Self::read_from(Path::new(PROC_INOTIFY_DIR))
    }

    /// Whether a watcher can be created at all.
    ///
    /// A zero watch or instance budget means the session must start in polling
    /// mode; it must not try to watch and then treat the first failure as
    /// "nothing changed".
    pub fn can_watch(&self) -> bool {
        self.max_user_watches > 0 && self.max_user_instances > 0
    }

    /// The event-buffer capacity a session should request, with the kernel's
    /// default when the value is missing or absurdly small.
    pub fn queue_capacity(&self) -> usize {
        usize::try_from(self.max_queued_events)
            .unwrap_or(usize::MAX)
            .max(MIN_QUEUE_CAPACITY)
    }
}

/// Lower bound for the session's own event buffer.
///
/// The kernel default is 16,384; a smaller configured value is legal but a
/// session still needs a usable buffer before it can claim it is caught up.
pub const MIN_QUEUE_CAPACITY: usize = 1024;

/// Why a watch could not be maintained.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DegradeReason {
    /// ENOSPC: the user's watch or instance budget is exhausted.
    WatchLimitExhausted,
    /// ENFILE/EMFILE: the system or process ran out of file descriptors.
    FdExhausted,
    /// Any other I/O failure.
    Io(io::ErrorKind),
}

impl DegradeReason {
    /// Classifies one I/O failure from watcher creation or event delivery.
    pub fn classify(error: &io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::StorageFull => Self::WatchLimitExhausted,
            _ => match error.raw_os_error() {
                Some(ENOSPC) => Self::WatchLimitExhausted,
                Some(ENFILE | EMFILE) => Self::FdExhausted,
                Some(_) => Self::Io(error.kind()),
                None => Self::Io(error.kind()),
            },
        }
    }

    /// Whether the session should continue in polling mode.
    ///
    /// Resource exhaustion is recoverable by polling; other I/O failures may
    /// be, and the caller decides after a bounded retry. This method only says
    /// which reasons have a defined polling fallback.
    pub fn needs_polling(self) -> bool {
        matches!(self, Self::WatchLimitExhausted | Self::FdExhausted)
    }

    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::WatchLimitExhausted => "INDEX_WATCH_LIMIT_EXHAUSTED",
            Self::FdExhausted => "INDEX_WATCH_FDS_EXHAUSTED",
            Self::Io(_) => "INDEX_WATCH_IO",
        }
    }
}

/// Reads one decimal limit file.
fn read_limit(dir: &Path, name: &str) -> Result<u64, io::Error> {
    let path = limit_path(dir, name);
    let text = fs::read_to_string(&path)?;
    parse_limit(&text).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("malformed inotify limit in {}", path.display()),
        )
    })
}

fn limit_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(name)
}

/// Parses a decimal limit file body.
///
/// procfs writes a trailing newline and nothing else; surrounding whitespace is
/// tolerated, an empty or non-decimal body is not.
fn parse_limit(text: &str) -> Option<u64> {
    text.trim().parse::<u64>().ok()
}

#[cfg(test)]
#[path = "limits_tests.rs"]
mod limits_tests;
