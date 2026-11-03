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
//! moved, a directory appears, or the file system cannot even classify the
//! event, later event paths can no longer be matched to the snapshot's paths.
//! Replaying them would silently corrupt the index, so the state reports that a
//! rescan is required instead.
//!
//! Until the caller adopts the snapshot's directories the baseline is not
//! ready, and every structural event conservatively requires a rescan: without
//! the directory set nothing can be attributed.

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
    /// The tracked directory tree changed in a way events cannot describe:
    /// a tracked directory (or an ancestor) was removed or moved, a directory
    /// appeared, or a rename could not be classified.
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
    /// Every tracked directory **and all of its ancestors**, plus the root.
    /// Closed under `parent()`, so one `contains` decides attribution.
    tracked_prefixes: HashSet<PathBuf>,
    baseline_ready: bool,
    mode: WatchMode,
    invalidated: Option<InvalidationReason>,
}

impl SessionCore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            tracked_prefixes: HashSet::new(),
            baseline_ready: false,
            mode: WatchMode::Native,
            invalidated: None,
        }
    }

    pub(crate) fn adopt_directories(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.rebuild_prefixes(dirs);
        self.baseline_ready = true;
    }

    pub(crate) fn resync_baseline(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.rebuild_prefixes(dirs);
        self.baseline_ready = true;
        self.invalidated = None;
    }

    pub(crate) fn mode(&self) -> WatchMode {
        self.mode
    }

    pub(crate) fn set_mode(&mut self, mode: WatchMode) {
        self.mode = mode;
    }

    pub(crate) fn invalidated(&self) -> Option<InvalidationReason> {
        self.invalidated
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Turns an unbounded event gap into a rescan requirement.
    pub(crate) fn note_queue_overflow(&mut self) {
        self.invalidate(InvalidationReason::QueueOverflow);
    }

    /// A structural change events cannot be replayed against the snapshot:
    /// a tracked directory (or ancestor) removed/moved, a directory appeared,
    /// or an event the file system could not classify.
    pub(crate) fn note_structure_changed(&mut self) {
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

    /// The channel closed: no backend can deliver events any more.
    pub(crate) fn on_backend_disconnected(&mut self) {
        self.invalidate(InvalidationReason::BackendLost);
    }

    /// Whether `rel` is the root, a tracked directory, or an ancestor of one.
    ///
    /// Before the baseline is adopted nothing is attributable, so every path
    /// conservatively reports tracked.
    pub(crate) fn tracks(&self, rel: &Path) -> bool {
        !self.baseline_ready || self.tracked_prefixes.contains(rel)
    }

    /// Replaces the tracked set with the directories and all their ancestors.
    fn rebuild_prefixes(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.tracked_prefixes.clear();
        // The root itself is always attributed; `Path::new("")` is the empty
        // relative path the mapping uses for it.
        self.tracked_prefixes.insert(PathBuf::new());
        for dir in dirs {
            let mut current = dir;
            loop {
                let parent = current.parent().map(Path::to_path_buf);
                self.tracked_prefixes.insert(current);
                match parent {
                    Some(parent) if !parent.as_os_str().is_empty() => current = parent,
                    _ => break,
                }
            }
        }
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
