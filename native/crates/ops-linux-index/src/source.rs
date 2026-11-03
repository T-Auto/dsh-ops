// Design informed by mustafaahci/goz (MIT).
//! Freshness state and the [`FsDataSource`] implementation for Linux.
//!
//! A cold enumeration alone cannot prove that a snapshot is caught up: the
//! file system can change between the last `read_dir` and the query. Only a
//! watcher that started before the walk and drained the events after it lets
//! the source claim `Ready`, which is why L1 has no `Ready` production path.
//!
//! [`Phase`] is the extension point the later slices fill:
//!
//! | Phase | `SourceState` | Caller behaviour |
//! | --- | --- | --- |
//! | [`Phase::Unwatched`] | `Unsupported` | fall back to the walk (L1) |
//! | [`Phase::CatchingUp`] | `Unavailable` (Offline) | fall back until caught up (L2) |
//! | [`Phase::Live`] | `Ready` | index-backed answers allowed (L2) |
//!
//! `Unsupported` and `Unavailable` are both safe: the caller produces exactly
//! the output it produces without an index. The dangerous state would be
//! `Ready` without a caught-up watcher, and the type makes that unconstructible
//! except through [`LinuxSource::with_phase`].

use ops_index::source::{CandidateSet, Change, EnumBudget, FsDataSource};
use ops_index::{SnapshotId, SourceError, SourceState};
use std::path::Path;

/// What the source knows about a root's freshness.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    /// No incremental watcher exists. Cold enumeration is available, but the
    /// snapshot cannot be proven caught up, so the state is `Unsupported` and
    /// every caller falls back to the existing walk.
    #[default]
    Unwatched,
    /// A watcher exists but has not caught up since the cold enumeration.
    /// The state is `Unavailable` (Offline) until it does.
    CatchingUp,
    /// A watcher caught up to the live file system: the state is `Ready`.
    ///
    /// Only the watcher slice constructs this; a cold snapshot alone must never
    /// claim it.
    Live {
        /// Snapshot identifier assigned to the cold enumeration.
        snapshot: SnapshotId,
        /// Wall-clock milliseconds when the watcher caught up.
        consistent_at_ms: i64,
    },
}

/// Linux implementation of [`FsDataSource`].
#[derive(Clone, Copy, Debug, Default)]
pub struct LinuxSource {
    phase: Phase,
}

impl LinuxSource {
    /// A source with no watcher: cold enumeration only (L1's production state).
    pub fn new() -> Self {
        Self::default()
    }

    /// A source in an explicit phase.
    ///
    /// L2/L3 construct `CatchingUp` and `Live` here; tests use it to pin the
    /// state mapping without a real watcher.
    pub fn with_phase(phase: Phase) -> Self {
        Self { phase }
    }

    /// The current phase.
    pub fn phase(&self) -> Phase {
        self.phase
    }
}

impl FsDataSource for LinuxSource {
    fn state(&self, _root: &Path) -> SourceState {
        match self.phase {
            Phase::Unwatched => SourceState::Unsupported,
            Phase::CatchingUp => SourceState::Unavailable,
            Phase::Live {
                snapshot,
                consistent_at_ms,
            } => SourceState::Ready {
                snapshot,
                consistent_at_ms,
            },
        }
    }

    fn enumerate(&self, root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
        crate::walk::enumerate(root, budget)
    }

    fn changes(&self, _root: &Path, _since: SnapshotId) -> Result<Vec<Change>, SourceError> {
        // L1 has no event stream. Returning an empty list would claim "nothing
        // changed", which is exactly the dishonest answer the boundary forbids;
        // NotReady makes the caller fall back to the walk.
        Err(SourceError::NotReady)
    }
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod source_tests;
