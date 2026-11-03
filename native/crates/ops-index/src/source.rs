//! The data-source boundary between platform crates and the index.
//!
//! A platform crate (Windows USN/MFT, Linux inotify, macOS FSEvents) implements
//! [`FsDataSource`]; this crate never calls an OS API. The trait answers three
//! questions:
//!
//! 1. `state`: may a caller trust a snapshot of this root right now?
//! 2. `enumerate`: what does the root contain, within an explicit budget?
//! 3. `changes`: what happened since a snapshot, so a caller can catch up?
//!
//! Only [`SourceState::Ready`] permits an index-backed answer. `Unsupported`
//! and `Unavailable` both mean the caller must fall back to its own traversal
//! and produce exactly the output it produces today.
//!
//! [`NullSource`] is the default source and always reports `Unsupported`.
//! [`MemorySource`] is a deterministic in-memory source for tests: it injects
//! snapshots, stale entries, I/O failures and truncation without touching a
//! file system, so the same assertions run on every OS.

use crate::ids::{FileKey, SnapshotId};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Kind of a directory entry as reported by a source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EntryKind {
    /// Regular file.
    File,
    /// Directory.
    Dir,
    /// Symbolic link, junction or other reparse point.
    Link,
    /// Sockets, devices, FIFOs and anything a name index cannot describe.
    Other,
}

/// One enumerated entry, relative to the root that produced it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// Path relative to the root, in platform components.
    pub rel: PathBuf,
    /// Stable identity of the object, independent of its name.
    ///
    /// A source must fill this with the same identity a caller's no-follow
    /// metadata reports: `(st_dev, st_ino)` on POSIX and
    /// `(volume_serial_number, file_index)` on Windows — the `cap-fs-ext`
    /// mapping `ops-search` compares against. See the identity contract on
    /// [`FsDataSource`].
    pub key: FileKey,
    /// What kind of entry this is.
    pub kind: EntryKind,
    /// Size in bytes for regular files; zero when the source has no size.
    pub len: u64,
    /// Modification time in nanoseconds since the Unix epoch, when known.
    pub modified_ns: Option<i64>,
}

impl Candidate {
    /// Whether this candidate is a regular file.
    pub fn is_file(&self) -> bool {
        self.kind == EntryKind::File
    }

    /// Whether this candidate is a directory.
    pub fn is_dir(&self) -> bool {
        self.kind == EntryKind::Dir
    }
}

/// Result of one bounded enumeration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateSet {
    /// Entries in source order. Callers that need a deterministic order sort by
    /// path bytes; this crate never reorders a set on a source's behalf.
    pub entries: Vec<Candidate>,
    /// Whether the source stopped early because a budget ran out.
    ///
    /// `true` means the set is *not* complete and must not be reported as such.
    pub truncated: bool,
    /// Wall-clock milliseconds when the snapshot was known to be consistent.
    pub consistent_at_ms: i64,
}

/// Limits for one enumeration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnumBudget {
    /// Maximum number of entries to return.
    pub max_entries: usize,
    /// Maximum relative path depth, counted in path components.
    pub max_depth: usize,
    /// Absolute instant after which the source must stop.
    pub deadline: Instant,
}

impl EnumBudget {
    /// Builds a budget with an explicit deadline.
    pub fn new(max_entries: usize, max_depth: usize, deadline: Instant) -> Self {
        Self {
            max_entries,
            max_depth,
            deadline,
        }
    }

    /// Builds a budget whose deadline is `timeout` from now.
    pub fn with_timeout(max_entries: usize, max_depth: usize, timeout: Duration) -> Self {
        Self::new(max_entries, max_depth, Instant::now() + timeout)
    }

    /// Whether the deadline has passed.
    pub fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// Time left before the deadline, if any.
    pub fn remaining(&self) -> Option<Duration> {
        self.deadline.checked_duration_since(Instant::now())
    }
}

/// What a source can honestly say about a root right now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SourceState {
    /// A snapshot exists and is caught up with the live file system.
    Ready {
        /// Identifier of the snapshot.
        snapshot: SnapshotId,
        /// Wall-clock milliseconds of the last caught-up point.
        consistent_at_ms: i64,
    },
    /// This platform or volume has no index-capable source.
    #[default]
    Unsupported,
    /// A source exists but cannot serve the root at the moment.
    Unavailable,
}

impl SourceState {
    /// Whether an index-backed answer may be produced.
    pub fn is_ready(self) -> bool {
        matches!(self, Self::Ready { .. })
    }

    /// Snapshot identifier when ready.
    pub fn snapshot(self) -> Option<SnapshotId> {
        match self {
            Self::Ready { snapshot, .. } => Some(snapshot),
            Self::Unsupported | Self::Unavailable => None,
        }
    }

    /// Consistency timestamp when ready.
    pub fn consistent_at_ms(self) -> Option<i64> {
        match self {
            Self::Ready {
                consistent_at_ms, ..
            } => Some(consistent_at_ms),
            Self::Unsupported | Self::Unavailable => None,
        }
    }
}

/// Why a source could not serve a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SourceError {
    /// No source exists for this platform or volume.
    Unsupported,
    /// A source exists but has no caught-up snapshot yet.
    NotReady,
    /// An enumeration budget (entries, depth or deadline) was exhausted.
    Budget,
    /// The underlying call failed with this I/O kind.
    Io(std::io::ErrorKind),
}

impl SourceError {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "INDEX_SOURCE_UNSUPPORTED",
            Self::NotReady => "INDEX_SOURCE_NOT_READY",
            Self::Budget => "INDEX_SOURCE_BUDGET",
            Self::Io(_) => "INDEX_SOURCE_IO",
        }
    }
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => f.write_str("no index-capable source for this root"),
            Self::NotReady => f.write_str("the index source is not caught up"),
            Self::Budget => f.write_str("the enumeration budget was exhausted"),
            Self::Io(kind) => write!(f, "the index source failed with {kind:?}"),
        }
    }
}

impl std::error::Error for SourceError {}

/// Kind of change between two snapshots.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChangeAction {
    /// The entry appeared.
    Added,
    /// The entry disappeared.
    Removed,
    /// The entry kept its identity under a new path.
    Renamed,
    /// The entry kept its path but its metadata changed.
    Modified,
}

/// One change between two snapshots.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    /// Path relative to the root after the change.
    pub rel: PathBuf,
    /// Identity of the object that changed.
    pub key: FileKey,
    /// What happened to it.
    pub action: ChangeAction,
}

/// A platform-specific producer of index snapshots.
///
/// Implementations are stateless with respect to this crate: they may read
/// kernel journals, but they must not call back into the index. The trait is
/// object safe so callers can hold a `&dyn FsDataSource` chosen once per
/// request.
///
/// # Identity contract
///
/// [`Candidate::key`] is only useful if it names the *same* object the caller
/// will look at. `ops-search` revalidates every candidate by comparing `key`
/// with a live no-follow `symlink_metadata` taken through a directory handle,
/// where the live identity comes from `cap-fs-ext`:
///
/// - POSIX: `(st_dev, st_ino)`;
/// - Windows: `(volume_serial_number, file_index)`.
///
/// A source that numbers objects differently (an FRN without a volume
/// component, a ReFS 128-bit id, a path hash) makes every comparison look
/// drifted: the caller then discards the whole batch and walks instead. That
/// is safe but makes the source useless, so a source that cannot honour this
/// contract must report `Unsupported` instead of handing out keys.
pub trait FsDataSource {
    /// Current consistency state of `root`.
    fn state(&self, root: &Path) -> SourceState;

    /// Bounded enumeration of `root`.
    ///
    /// Returning `Err` is never fatal: the caller discards the index result and
    /// falls back to its own traversal. A returned set with
    /// [`CandidateSet::truncated`] is likewise unusable as a complete answer.
    fn enumerate(&self, root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError>;

    /// Changes since `since`, so a caller can catch up within one call.
    fn changes(&self, root: &Path, since: SnapshotId) -> Result<Vec<Change>, SourceError>;
}

/// The default source: always `Unsupported`.
///
/// This is what a non-Windows platform, a non-NTFS volume, or a host that has
/// not wired a source yet gets. Every answer falls back to the existing walk,
/// so output is byte-identical to today's behaviour.
#[derive(Clone, Copy, Debug, Default)]
pub struct NullSource;

impl FsDataSource for NullSource {
    fn state(&self, _root: &Path) -> SourceState {
        SourceState::Unsupported
    }

    fn enumerate(&self, _root: &Path, _budget: EnumBudget) -> Result<CandidateSet, SourceError> {
        Err(SourceError::Unsupported)
    }

    fn changes(&self, _root: &Path, _since: SnapshotId) -> Result<Vec<Change>, SourceError> {
        Err(SourceError::Unsupported)
    }
}

/// A deterministic in-memory source for tests.
///
/// It applies the same budget rules a real source must apply, and it can be
/// configured to report a state, return injected entries, mark the set
/// truncated, or fail with any [`SourceError`]. That is how stale, missing,
/// permission-denied and truncated cases become assertable on every OS.
#[derive(Clone, Debug, Default)]
pub struct MemorySource {
    state: SourceState,
    entries: Vec<Candidate>,
    changes: Vec<Change>,
    truncated: bool,
    consistent_at_ms: i64,
    enumerate_error: Option<SourceError>,
    changes_error: Option<SourceError>,
}

impl MemorySource {
    /// A source that reports `Unsupported`.
    pub fn unsupported() -> Self {
        Self::default()
    }

    /// A ready source holding `entries`.
    pub fn ready(snapshot: SnapshotId, entries: Vec<Candidate>) -> Self {
        let mut source = Self {
            state: SourceState::Ready {
                snapshot,
                consistent_at_ms: 0,
            },
            ..Self::default()
        };
        source.entries = entries;
        source
    }

    /// A source that exists but is not caught up.
    pub fn unavailable() -> Self {
        Self {
            state: SourceState::Unavailable,
            ..Self::default()
        }
    }

    /// Sets the consistency timestamp reported by [`SourceState::Ready`].
    pub fn with_consistent_at(mut self, consistent_at_ms: i64) -> Self {
        self.consistent_at_ms = consistent_at_ms;
        if let SourceState::Ready {
            consistent_at_ms: at,
            ..
        } = &mut self.state
        {
            *at = consistent_at_ms;
        }
        self
    }

    /// Adds one entry.
    pub fn with_entry(mut self, entry: Candidate) -> Self {
        self.entries.push(entry);
        self
    }

    /// Marks the enumerated set as truncated.
    pub fn with_truncated(mut self, truncated: bool) -> Self {
        self.truncated = truncated;
        self
    }

    /// Makes [`FsDataSource::enumerate`] fail with `error`.
    pub fn with_enumerate_error(mut self, error: SourceError) -> Self {
        self.enumerate_error = Some(error);
        self
    }

    /// Makes [`FsDataSource::changes`] fail with `error`.
    pub fn with_changes_error(mut self, error: SourceError) -> Self {
        self.changes_error = Some(error);
        self
    }

    /// Adds one change to replay.
    pub fn with_change(mut self, change: Change) -> Self {
        self.changes.push(change);
        self
    }

    /// Entries this source was built with.
    pub fn entries(&self) -> &[Candidate] {
        &self.entries
    }
}

impl FsDataSource for MemorySource {
    fn state(&self, _root: &Path) -> SourceState {
        self.state
    }

    fn enumerate(&self, _root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
        if let Some(error) = self.enumerate_error {
            return Err(error);
        }
        match self.state {
            SourceState::Unsupported => return Err(SourceError::Unsupported),
            SourceState::Unavailable => return Err(SourceError::NotReady),
            SourceState::Ready { .. } => {}
        }
        if budget.expired() {
            return Err(SourceError::Budget);
        }
        let mut entries = Vec::with_capacity(self.entries.len().min(budget.max_entries));
        let mut truncated = self.truncated;
        for entry in &self.entries {
            if entries.len() >= budget.max_entries {
                truncated = true;
                break;
            }
            if entry.rel.components().count() > budget.max_depth {
                truncated = true;
                continue;
            }
            entries.push(entry.clone());
        }
        Ok(CandidateSet {
            entries,
            truncated,
            consistent_at_ms: self.consistent_at_ms,
        })
    }

    fn changes(&self, _root: &Path, _since: SnapshotId) -> Result<Vec<Change>, SourceError> {
        if let Some(error) = self.changes_error {
            return Err(error);
        }
        match self.state {
            SourceState::Unsupported => Err(SourceError::Unsupported),
            SourceState::Unavailable => Err(SourceError::NotReady),
            SourceState::Ready { .. } => Ok(self.changes.clone()),
        }
    }
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod source_tests;
