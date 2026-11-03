// Design informed by mustafaahci/goz (MIT).
//! The Windows implementation of FsDataSource (W1: cold MFT enumeration).
//!
//! W1 can answer a cold, complete-at-one-instant MFT enumeration, but it cannot
//! yet prove that the set is caught up with the live volume: no USN journal is
//! attached and no replay exists. state therefore never answers Ready. A caller
//! that gates on state keeps using its own traversal and produces exactly
//! today's output; W2 turns a caught-up journal into Ready.
//!
//! State mapping:
//!
//! - the root is missing or not a readable directory: Unavailable;
//! - the process is not elevated, or elevation cannot be determined:
//!   Unsupported (the documented non-Administrator fallback);
//! - an elevated process with a readable root: Unavailable, because a cold
//!   source exists but it has no caught-up snapshot yet.
//!
//! changes is Unsupported until W2 wires the USN journal.

use crate::mft::cold_candidates;
use ops_index::{
    CandidateSet, Change, EnumBudget, FsDataSource, SnapshotId, SourceError, SourceState,
};
use std::fs;
use std::path::Path;

/// Windows file-name index source for one request.
///
/// Stateless: the worker is one short-lived process per call, so nothing here
/// outlives a request and there is no daemon to talk to.
#[derive(Clone, Copy, Debug, Default)]
pub struct WinFsSource;

impl WinFsSource {
    /// Builds the source.
    pub const fn new() -> Self {
        Self
    }
}

impl FsDataSource for WinFsSource {
    fn state(&self, root: &Path) -> SourceState {
        classify_state(root_is_directory(root), process_is_elevated())
    }

    fn enumerate(&self, root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
        cold_candidates(root, budget)
    }

    fn changes(&self, _root: &Path, _since: SnapshotId) -> Result<Vec<Change>, SourceError> {
        // No journal replay in W1: claiming a change set would be a lie, so the
        // caller falls back to a full traversal.
        Err(SourceError::Unsupported)
    }
}

/// Pure state mapping, kept separate so every branch is testable on Windows.
pub(crate) fn classify_state(root_is_directory: bool, elevated: bool) -> SourceState {
    if !root_is_directory {
        SourceState::Unavailable
    } else if elevated {
        // A cold source exists but is not caught up; W2 returns Ready here.
        SourceState::Unavailable
    } else {
        SourceState::Unsupported
    }
}

/// Whether the root resolves to a readable directory.
fn root_is_directory(root: &Path) -> bool {
    fs::metadata(root).is_ok_and(|metadata| metadata.is_dir())
}

/// Whether this process can open a volume handle; an unreadable token is not
/// elevated for our purposes (fail closed to the walk fallback).
fn process_is_elevated() -> bool {
    usn_journal_rs::privilege::is_elevated().unwrap_or(false)
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod source_tests;
