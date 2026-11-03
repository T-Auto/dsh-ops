// Design informed by mustafaahci/goz (MIT).

//! The safe half of the FSEvents integration: one stream, many roots,
//! replay-from-an-id, and a bounded batch drain.
//!
//! ## One stream, many roots
//!
//! `FSEventStreamCreate` accepts an array of paths, so every root of one request
//! shares a single kernel stream. Nothing here creates a stream per root, and
//! [`EventStream::watched_roots`] reports what the kernel actually accepted,
//! which is what the M2 spike asserts on a real system.
//!
//! ## Replay from a persisted event id
//!
//! FSEvents ids are exclusive and monotonic per volume. A caller that saw
//! everything up to id `n` stores `n` as a plain `u64` — [`EventId::raw`] — and
//! on the next process passes [`EventId::from_raw(n)`] to [`EventStream::open`];
//! the kernel then replays what happened in between. There is no daemon and no
//! in-memory state that has to survive, which is exactly the worker model from
//! #584: persistence is the caller's snapshot, not this crate's job.
//!
//! ## What a batch promises
//!
//! [`EventStream::drain`] runs the calling thread's run loop for a bounded
//! slice and returns what arrived. The batch honestly reports three things
//! beyond the events: the highest id seen (so the caller can persist it), whether
//! the historical replay reached its end (`HistoryDone`), and whether the
//! kernel signalled lost events. A dropped batch must never be reported as a
//! complete answer; deciding what to re-scan is the caller's policy (M3).
//!
//! ## Threading
//!
//! A stream belongs to the thread that opened it, because that thread's run
//! loop is what delivers events. The handle is not `Send`, so this cannot be
//! violated by accident.

use crate::ffi;
use ops_index::SourceError;
use std::fmt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Upper bound of one run-loop slice inside [`EventStream::drain`].
///
/// Draining in slices keeps the loop responsive to the deadline and lets a
/// finished replay return early instead of waiting out the whole timeout.
const MAX_DRAIN_SLICE: Duration = Duration::from_millis(250);

/// Lower bound of one run-loop slice; zero-length run-loop runs are not useful.
const MIN_DRAIN_SLICE: Duration = Duration::from_millis(10);

/// Event id from the FSEvents journal.
///
/// Exclusive and monotonically increasing per volume, so storing the highest
/// id of one batch and replaying from it cannot miss or duplicate an event
/// (ids are assigned once and are never reused). The value is a plain `u64` on
/// the wire; [`EventId::from_raw`] accepts any value a previous process stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EventId(u64);

impl EventId {
    /// Replay nothing but live events from now on.
    ///
    /// This is the kernel's `kFSEventStreamEventIdSinceNow` sentinel and must
    /// never be persisted as "the last id seen".
    pub const SINCE_NOW: Self = Self(u64::MAX);

    /// Wraps an id read from a previous batch.
    pub const fn from_raw(raw: u64) -> Self {
        Self(raw)
    }

    /// The id as a `u64` for persistence.
    pub const fn raw(self) -> u64 {
        self.0
    }

    /// Whether this is the [`EventId::SINCE_NOW`] sentinel.
    pub const fn is_since_now(self) -> bool {
        self.0 == u64::MAX
    }
}

/// The flags the kernel attaches to one event.
///
/// A thin wrapper rather than `bitflags`: the crate takes no bitflags
/// dependency for one type, and keeping the raw `u32` observable means a macOS
/// that adds a bit does not get silently truncated here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EventFlags(u32);

macro_rules! event_flags {
    ($($(#[$meta:meta])* $name:ident = $value:expr;)*) => {
        impl EventFlags {
            $($(#[$meta])* pub const $name: Self = Self($value);)*
        }
    };
}

event_flags! {
    /// No flag set.
    NONE = 0x0000_0000;
    /// The kernel lost events below this path; treat it as a subtree rescan.
    MUST_SCAN_SUBDIRS = 0x0000_0001;
    /// Events were dropped in user space (the callback could not keep up).
    USER_DROPPED = 0x0000_0002;
    /// Events were dropped in the kernel.
    KERNEL_DROPPED = 0x0000_0004;
    /// Event ids wrapped around; a persisted id from before is meaningless.
    EVENT_IDS_WRAPPED = 0x0000_0008;
    /// End of the historical replay requested by a `since` id.
    HISTORY_DONE = 0x0000_0010;
    /// The watched root itself changed.
    ROOT_CHANGED = 0x0000_0020;
    /// A volume was mounted below the root.
    MOUNT = 0x0000_0040;
    /// A volume was unmounted below the root.
    UNMOUNT = 0x0000_0080;
    /// An entry was created.
    ITEM_CREATED = 0x0000_0100;
    /// An entry was removed.
    ITEM_REMOVED = 0x0000_0200;
    /// An entry's inode metadata changed.
    ITEM_INODE_META_MOD = 0x0000_0400;
    /// An entry was renamed; the event carries one of the two names.
    ITEM_RENAMED = 0x0000_0800;
    /// An entry's data changed.
    ITEM_MODIFIED = 0x0000_1000;
    /// Finder info changed.
    ITEM_FINDER_INFO_MOD = 0x0000_2000;
    /// Ownership changed.
    ITEM_CHANGE_OWNER = 0x0000_4000;
    /// Extended attributes changed.
    ITEM_XATTR_MOD = 0x0000_8000;
    /// The path is a regular file.
    ITEM_IS_FILE = 0x0001_0000;
    /// The path is a directory.
    ITEM_IS_DIR = 0x0002_0000;
    /// The path is a symbolic link.
    ITEM_IS_SYMLINK = 0x0004_0000;
    /// This process caused the event.
    OWN_EVENT = 0x0008_0000;
    /// The path is a hard link.
    ITEM_IS_HARDLINK = 0x0010_0000;
    /// This was the last hard link to the inode.
    ITEM_IS_LAST_HARDLINK = 0x0020_0000;
    /// The entry was cloned (copy-on-write).
    ITEM_CLONED = 0x0040_0000;
}

impl EventFlags {
    /// Wraps raw kernel bits, unknown bits included.
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    /// Raw kernel bits.
    pub const fn raw(self) -> u32 {
        self.0
    }

    /// Whether every bit of `other` is set.
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    /// Whether any bit of `other` is set.
    pub const fn intersects(self, other: Self) -> bool {
        self.0 & other.0 != 0
    }

    /// Whether the kernel says events were lost below this path.
    ///
    /// Such a batch is not a complete answer: the caller has to rescan the
    /// subtree instead of applying only what arrived.
    pub const fn signals_dropped(self) -> bool {
        self.intersects(Self::MUST_SCAN_SUBDIRS)
            || self.intersects(Self::USER_DROPPED)
            || self.intersects(Self::KERNEL_DROPPED)
    }

    /// Whether this is the end-of-replay sentinel.
    pub const fn is_history_done(self) -> bool {
        self.contains(Self::HISTORY_DONE)
    }
}

/// One change the kernel reported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    /// Journal id; exclusive and monotonic per volume.
    pub id: EventId,
    /// Raw flags, decoded through [`EventFlags`].
    pub flags: EventFlags,
    /// Absolute path the event refers to.
    pub path: PathBuf,
    /// File id from the extended data, when the kernel reports it. A rename can
    /// be paired by this id without a second `stat`.
    pub file_id: Option<u64>,
}

impl Event {
    /// Path relative to the longest root that contains it.
    ///
    /// Returns `None` when the event is outside every root, and an empty path
    /// when the event is the root itself.
    pub fn relative_to(&self, roots: &[PathBuf]) -> Option<PathBuf> {
        relative_path(roots, &self.path)
    }
}

/// Everything one bounded drain produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    /// Events in delivery order, with the replay-end sentinel removed.
    pub events: Vec<Event>,
    /// Highest id seen; persist this and replay from it next time. Equals the
    /// id the stream was opened with when nothing new arrived.
    pub latest: EventId,
    /// Whether the historical replay reached its end.
    pub history_done: bool,
    /// Whether any event in the batch signalled lost events.
    ///
    /// `true` means the batch is incomplete by the kernel's own admission.
    pub dropped: bool,
}

impl Batch {
    /// Whether the batch carries no events.
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

/// Why a stream could not be opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventError {
    /// No roots were passed; a stream without paths would watch nothing.
    EmptyRoots,
    /// A root is not valid UTF-8, so it cannot be a CoreFoundation path.
    NonUtf8Root(PathBuf),
    /// A root is not a readable directory.
    RootNotDirectory(PathBuf),
    /// FSEvents refused to create the stream.
    CreationFailed,
    /// The calling thread has no run loop to schedule the stream on.
    ScheduleFailed,
    /// The stream exists but could not be started.
    StartFailed,
}

impl EventError {
    /// Maps the failure onto the source boundary's error vocabulary.
    ///
    /// Every variant means "no stream", so the caller falls back to its own
    /// traversal; only bad input is reported as `InvalidInput`, everything else
    /// as a generic I/O failure (no partial index is ever implied).
    pub fn source_error(&self) -> SourceError {
        match self {
            Self::EmptyRoots | Self::NonUtf8Root(_) | Self::RootNotDirectory(_) => {
                SourceError::Io(ErrorKind::InvalidInput)
            }
            Self::CreationFailed | Self::ScheduleFailed | Self::StartFailed => {
                SourceError::Io(ErrorKind::Other)
            }
        }
    }
}

impl fmt::Display for EventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRoots => f.write_str("no roots to watch"),
            Self::NonUtf8Root(path) => write!(f, "root {path:?} is not valid UTF-8"),
            Self::RootNotDirectory(path) => write!(f, "root {path:?} is not a directory"),
            Self::CreationFailed => f.write_str("FSEvents refused to create the stream"),
            Self::ScheduleFailed => f.write_str("the calling thread has no run loop"),
            Self::StartFailed => f.write_str("FSEvents could not start the stream"),
        }
    }
}

impl std::error::Error for EventError {}

/// One started FSEvents stream watching every root of a request.
pub struct EventStream {
    inner: ffi::Stream,
    since: EventId,
    latest: EventId,
}

impl fmt::Debug for EventStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EventStream")
            .field("since", &self.since)
            .field("latest", &self.latest)
            .finish_non_exhaustive()
    }
}

impl EventStream {
    /// Opens one stream over all `roots`, replaying from `since`.
    ///
    /// Must be called on the thread that will run [`EventStream::drain`]: the
    /// stream is scheduled on that thread's run loop.
    ///
    /// # Errors
    ///
    /// - [`EventError::EmptyRoots`], [`EventError::NonUtf8Root`],
    ///   [`EventError::RootNotDirectory`] for input this source cannot use.
    /// - [`EventError::CreationFailed`], [`EventError::ScheduleFailed`],
    ///   [`EventError::StartFailed`] when the system refuses the stream.
    pub fn open(roots: &[PathBuf], since: EventId, latency: Duration) -> Result<Self, EventError> {
        if roots.is_empty() {
            return Err(EventError::EmptyRoots);
        }
        for root in roots {
            if root.to_str().is_none() {
                return Err(EventError::NonUtf8Root(root.clone()));
            }
            if !fs::metadata(root).is_ok_and(|metadata| metadata.is_dir()) {
                return Err(EventError::RootNotDirectory(root.clone()));
            }
        }
        let inner = ffi::Stream::create(roots, since, latency)?;
        Ok(Self {
            inner,
            since,
            latest: since,
        })
    }

    /// The id the stream was opened with.
    pub fn since(&self) -> EventId {
        self.since
    }

    /// Paths the kernel reports as watched; one stream covers all of them.
    pub fn watched_roots(&self) -> Vec<PathBuf> {
        self.inner.watched_paths()
    }

    /// Highest id seen so far, including replay.
    pub fn latest_event_id(&self) -> EventId {
        std::cmp::max(self.latest, self.inner.latest_event_id())
    }

    /// Runs the run loop for at most `timeout` and returns what arrived.
    ///
    /// Returns early once the historical replay is known to be finished and at
    /// least one event has arrived; otherwise it waits out the timeout, so a
    /// live stream can be polled without busy-waiting.
    pub fn drain(&mut self, timeout: Duration) -> Batch {
        let deadline = Instant::now() + timeout;
        let mut events = Vec::new();
        let mut history_done = false;
        let mut dropped = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let slice = remaining.clamp(MIN_DRAIN_SLICE, MAX_DRAIN_SLICE);
            ffi::run_current_run_loop(slice.as_secs_f64());
            for raw in self.inner.take_events() {
                let flags = EventFlags::from_raw(raw.flags);
                if flags.is_history_done() {
                    history_done = true;
                    continue;
                }
                dropped |= flags.signals_dropped();
                let event = Event {
                    id: EventId::from_raw(raw.id),
                    flags,
                    path: PathBuf::from(raw.path),
                    file_id: raw.file_id,
                };
                self.latest = self.latest.max(event.id);
                events.push(event);
            }
            if history_done && !events.is_empty() {
                // The replay caught up and delivered what it had; waiting for
                // more would only delay the caller.
                break;
            }
        }
        Batch {
            events,
            latest: self.latest,
            history_done,
            dropped,
        }
    }

    /// Stops the stream and returns the highest id seen.
    pub fn close(self) -> EventId {
        let latest = self.latest_event_id();
        drop(self);
        latest
    }

    /// The latest event id the system has assigned, for opening a live stream.
    pub fn current_event_id() -> EventId {
        ffi::current_event_id()
    }
}

/// Path relative to the longest root that contains `path`.
///
/// Roots are compared as path prefixes, so `/a/b` wins over `/a` for a path
/// below it. The root itself yields an empty path.
pub fn relative_path(roots: &[PathBuf], path: &Path) -> Option<PathBuf> {
    let mut best: Option<&PathBuf> = None;
    for root in roots {
        if !path.starts_with(root) {
            continue;
        }
        let longer =
            best.is_none_or(|current| root.components().count() > current.components().count());
        if longer {
            best = Some(root);
        }
    }
    best.map(|root| {
        path.strip_prefix(root)
            .map(Path::to_path_buf)
            .unwrap_or_default()
    })
}

#[cfg(test)]
#[path = "fsevents_tests.rs"]
mod fsevents_tests;
