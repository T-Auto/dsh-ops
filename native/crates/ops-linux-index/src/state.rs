// Design informed by mustafaahci/goz (MIT).
//! Watch-state machine: freshness phases, normalized changes, and the
//! conditions under which a live snapshot must be discarded.
//!
//! This module is deliberately free of the notify dependency and of I/O. The
//! backend in [`crate::watch`] feeds it backend events, and the tests drive it
//! directly, so every invalidation rule is testable without a kernel watcher.
//!
//! The rule behind invalidation is attribution: an inotify watch belongs to an
//! inode. Once a tracked directory (or one of its ancestors) is removed or
//! moved, or a directory is moved into the tree, later event paths can no
//! longer be matched to the snapshot's paths. Replaying them would silently
//! corrupt the index, so the state reports that a rescan is required instead.

use ops_index::ChangeAction;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Which backend is delivering events.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchMode {
    /// The kernel event backend (`inotify` through notify's
    /// `RecommendedWatcher`).
    Native,
    /// notify's `PollWatcher`, used when a native watcher cannot be
    /// established or maintained.
    Polling,
}

/// Why incremental tracking gave up and the caller must rescan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidationReason {
    /// The kernel reported a queue overflow: notifications were dropped.
    QueueOverflow,
    /// A tracked directory (or one of its ancestors) was removed or moved, or a
    /// directory was moved into the tree.
    WatchedTreeMoved,
    /// The native watcher failed and the session degraded to polling; events
    /// between the failure and the polling baseline may be missing.
    DegradedToPolling,
    /// No backend is delivering events any more.
    BackendLost,
}

impl InvalidationReason {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::QueueOverflow => "INDEX_WATCH_QUEUE_OVERFLOW",
            Self::WatchedTreeMoved => "INDEX_WATCH_TREE_MOVED",
            Self::DegradedToPolling => "INDEX_WATCH_DEGRADED",
            Self::BackendLost => "INDEX_WATCH_BACKEND_LOST",
        }
    }
}

/// One normalized change, relative to the watch root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchEvent {
    /// Path relative to the watch root; empty for the root itself.
    pub rel: PathBuf,
    /// What happened to it.
    pub action: ChangeAction,
}

/// One poll result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchUpdate {
    /// Events in delivery order. Empty when `invalidated` is set: a rescan
    /// makes individual changes irrelevant.
    pub events: Vec<WatchEvent>,
    /// Backend currently in use.
    pub mode: WatchMode,
    /// Set when the snapshot must be rebuilt; sticky until
    /// [`crate::watch::WatchSession::resync_baseline`].
    pub invalidated: Option<InvalidationReason>,
}

/// Backend-independent decision state.
pub(crate) struct SessionCore {
    root: PathBuf,
    known_dirs: HashSet<PathBuf>,
    mode: WatchMode,
    invalidated: Option<InvalidationReason>,
}

impl SessionCore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            known_dirs: HashSet::new(),
            mode: WatchMode::Native,
            invalidated: None,
        }
    }

    pub(crate) fn adopt_directories(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.known_dirs.extend(dirs);
    }

    pub(crate) fn resync_baseline(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.known_dirs.clear();
        self.known_dirs.extend(dirs);
        self.invalidated = None;
    }

    pub(crate) fn set_mode(&mut self, mode: WatchMode) {
        self.mode = mode;
    }

    pub(crate) fn mode(&self) -> WatchMode {
        self.mode
    }

    pub(crate) fn invalidated(&self) -> Option<InvalidationReason> {
        self.invalidated
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// The channel closed: no backend can deliver events any more.
    pub(crate) fn on_backend_disconnected(&mut self) {
        self.invalidate(InvalidationReason::BackendLost);
    }

    /// Turns an unbounded event gap into a rescan requirement.
    pub(crate) fn note_queue_overflow(&mut self) {
        self.invalidate(InvalidationReason::QueueOverflow);
    }

    /// A tracked directory or one of its ancestors disappeared.
    pub(crate) fn note_tracked_tree_moved(&mut self) {
        self.invalidate(InvalidationReason::WatchedTreeMoved);
    }

    /// A directory was moved into the tree: its existing children emitted no
    /// creation events, so the snapshot is incomplete.
    pub(crate) fn note_directory_moved_in(&mut self) {
        self.invalidate(InvalidationReason::WatchedTreeMoved);
    }

    /// Returns whether the caller should try to switch to the polling backend.
    pub(crate) fn on_backend_error(&mut self) -> bool {
        match self.mode {
            WatchMode::Native => {
                self.mode = WatchMode::Polling;
                self.invalidate(InvalidationReason::DegradedToPolling);
                true
            }
            WatchMode::Polling => {
                self.invalidate(InvalidationReason::BackendLost);
                false
            }
        }
    }

    /// Whether `rel` is a tracked directory or an ancestor of one.
    pub(crate) fn tracks(&self, rel: &Path) -> bool {
        self.known_dirs.contains(rel) || self.known_dirs.iter().any(|dir| dir.starts_with(rel))
    }

    fn invalidate(&mut self, reason: InvalidationReason) {
        if self.invalidated.is_none() {
            self.invalidated = Some(reason);
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod state_tests;
