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
//! | Phase | `SourceState` | `changes` | Caller behaviour |
//! | --- | --- | --- | --- |
//! | [`Phase::Unwatched`] | `Unsupported` | `Unsupported` | fall back to the walk (L1) |
//! | [`Phase::CatchingUp`] | `Unavailable` (Offline) | `NotReady` | fall back until caught up (L2) |
//! | [`Phase::Live`] | `Ready` | `Unsupported` until L2 has a replay buffer | index-backed answers allowed once the buffer exists (L2) |
//!
//! `Unsupported` and `Unavailable` are both safe: the caller produces exactly
//! the output it produces without an index. The dangerous state would be
//! `Ready` without a caught-up watcher, and the type makes that unconstructible
//! outside this crate.
//!
//! L3 adds one override ABOVE the phase: a root on an unsupported file system
//! ([`crate::fs`]) is `Unavailable` whatever the phase says. That is why a
//! `Live` watcher on NFS/procfs/sysfs/FUSE never produces `Ready`.

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

    /// A source in an explicit phase, for the watcher slice and its tests.
    ///
    /// Deliberately crate-private: a caller outside this crate cannot construct
    /// `Live` and cannot make an unwatched source look caught up. L2's watcher
    /// is the first production caller; until then only tests use it, hence the
    /// dead-code allowance.
    #[allow(dead_code)]
    pub(crate) fn with_phase(phase: Phase) -> Self {
        Self { phase }
    }

    /// The current phase.
    pub fn phase(&self) -> Phase {
        self.phase
    }
}

impl FsDataSource for LinuxSource {
    fn state(&self, root: &Path) -> SourceState {
        // A remote or kernel pseudo file system is Offline regardless of the
        // watcher phase: no local event source can keep its snapshot
        // consistent, so an index-backed answer would be a correctness bug.
        // The caller falls back to the existing walk, exactly as for
        // `Unsupported`.
        if crate::fs::classify_root(root).is_ok_and(|classification| classification.is_offline()) {
            return SourceState::Unavailable;
        }
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
        match self.phase {
            // L2 maps "temporarily not caught up" to NotReady.
            Phase::CatchingUp => Err(SourceError::NotReady),
            // L1 has no event stream at all, and even a `Live` phase has no
            // replay buffer until L2. Returning an empty list would claim
            // "nothing changed"; Unsupported makes the caller fall back.
            Phase::Unwatched | Phase::Live { .. } => Err(SourceError::Unsupported),
        }
    }
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod source_tests;
