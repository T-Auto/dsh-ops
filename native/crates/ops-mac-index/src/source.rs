// Design informed by mustafaahci/goz (MIT).

//! The macOS implementation of [`FsDataSource`].
//!
//! M1 delivers the cold half. [`FsDataSource::enumerate`] is a bounded walk of
//! the root; [`FsDataSource::state`] still answers [`SourceState::Unsupported`]
//! for a readable directory because no FSEvents stream exists yet to make the
//! set caught up, and [`FsDataSource::changes`] reports the same. M2 wires the
//! stream and turns `state` into [`SourceState::Ready`] once replay has caught
//! up; M3 handles coalescing, `MustScanSubDirs` and Time Machine volumes.
//!
//! The source never decides that a caller may trust an index: it only says
//! whether a snapshot is caught up. `ops-search` still re-verifies every
//! candidate through its own no-follow handles.

use crate::walk::walk_root;
use ops_index::{
    CandidateSet, Change, EnumBudget, FsDataSource, SnapshotId, SourceError, SourceState,
};
use std::fs;
use std::path::Path;

/// macOS file-name index source for one request.
///
/// Stateless: the worker is one short-lived process per call, so nothing here
/// outlives a request and there is no daemon to talk to. A cold enumeration is
/// requested explicitly through [`FsDataSource::enumerate`]; callers must gate
/// it on [`FsDataSource::state`].
#[derive(Clone, Copy, Debug, Default)]
pub struct MacFsSource;

impl MacFsSource {
    /// Builds the source.
    pub const fn new() -> Self {
        Self
    }
}

impl FsDataSource for MacFsSource {
    fn state(&self, root: &Path) -> SourceState {
        // A root that cannot be read as a directory is "exists but cannot serve
        // right now"; a readable one still has no caught-up snapshot in M1
        // because the FSEvents stream (M2) does not exist yet.
        if is_directory(root) {
            SourceState::Unsupported
        } else {
            SourceState::Unavailable
        }
    }

    fn enumerate(&self, root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
        walk_root(root, budget)
    }

    fn changes(&self, _root: &Path, _since: SnapshotId) -> Result<Vec<Change>, SourceError> {
        // No journal exists on macOS and the event stream is M2's work: without
        // it there is nothing to replay, so claiming any change set would be a
        // lie. The caller falls back to a full traversal.
        Err(SourceError::Unsupported)
    }
}

/// Whether `root` resolves (through a final symlink) to a readable directory.
fn is_directory(root: &Path) -> bool {
    fs::metadata(root).is_ok_and(|metadata| metadata.is_dir())
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod source_tests;
