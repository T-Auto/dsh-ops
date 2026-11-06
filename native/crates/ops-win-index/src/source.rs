// Design informed by mustafaahci/goz (MIT).
//! The Windows implementation of FsDataSource (W2: cold MFT plus journal tail).
//!
//! W2 can prove a caught-up snapshot inside one call. enumerate captures the
//! journal tail cursor, runs the cold MFT enumeration, and replays every journal
//! record that landed after the capture before returning, so the candidate set
//! is consistent at a single instant. It also reports key = (volume serial,
//! full nFileIndex), byte-identical to cap-fs-ext's (dev, ino).
//!
//! state never guesses. It reports Ready only when the host supplied a
//! CursorStore whose saved cursor still validates against the live journal
//! window (same journal id, not purged, not from the future). Without a store,
//! or after a journal id change or purge, it reports Unavailable and the caller
//! rebuilds with its own traversal. changes replays from the stored cursor to
//! the tail and returns ops_index::Change rows plus an honest skipped count.
//!
//! A volume without an active USN journal answers Unsupported: this crate never
//! creates a journal as a side effect, and without one it cannot claim the set
//! is caught up.

use crate::changes::{ChangeReport, apply_entries, changes_for_entries};
use crate::journal::{CursorStore, JournalCursor, StoredCursor, catch_up, info, is_replayable};
use crate::mft::{assemble, collect_nodes, now_ms, open_for_root, subtree_paths};
use ops_index::{
    Candidate, CandidateSet, Change, EnumBudget, FileKey, FsDataSource, SnapshotId, SourceError,
    SourceState,
};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Default bound for one changes replay; the worker's index path uses 20 s.
pub const CHANGES_TIMEOUT: Duration = Duration::from_secs(20);

/// Windows file-name index source for one request.
#[derive(Clone, Default)]
pub struct WinFsSource {
    store: Option<Arc<dyn CursorStore>>,
}

impl WinFsSource {
    /// Builds a source without a cursor store: state stays Unavailable.
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds a source whose state can prove a snapshot through the store.
    pub fn with_cursor_store(store: Arc<dyn CursorStore>) -> Self {
        Self { store: Some(store) }
    }

    /// Captures the current journal tail cursor for a recovery snapshot.
    ///
    /// Prefer enumerate_with_cursor for the normal path: it returns the cursor
    /// that belongs to the set it just built. A cursor captured after a separate
    /// enumerate can be newer than that set and would silently skip records it
    /// did not include.
    pub fn capture_cursor(&self, root: &Path) -> Result<JournalCursor, SourceError> {
        let opened = open_for_root(root)?;
        crate::journal::current_cursor(&opened.volume)
    }

    /// Changes since a snapshot, with the skip count and the cursor to persist.
    pub fn changes_report(
        &self,
        root: &Path,
        since: SnapshotId,
    ) -> Result<ChangeReport, SourceError> {
        let store = self.store.as_ref().ok_or(SourceError::NotReady)?;
        let stored: StoredCursor = store
            .load_for_snapshot(root, since)
            .ok_or(SourceError::NotReady)?;
        let cursor = stored.cursor;
        let opened = open_for_root(root)?;
        let live = info(&opened.volume)?;
        if !is_replayable(cursor, &live) {
            return Err(SourceError::NotReady);
        }
        let budget = changes_budget();
        let nodes = collect_nodes(&opened.volume, &budget)?;
        let seed = subtree_paths(&nodes, opened.root_fid)?;
        let (entries, end_cursor) = catch_up(&opened.volume, cursor, &budget)?;
        changes_for_entries(&seed, &entries, opened.volume_serial, end_cursor)
    }

    fn probe_state(&self, root: &Path) -> Result<SourceState, SourceError> {
        // Without a store there is no snapshot to validate and no cursor to
        // replay. Check that before opening the volume or issuing a journal
        // FSCTL: a configured indexCache with no store must not pay the
        // volume/journal probe (the startup path keeps Unavailable).
        let Some(store) = self.store.as_ref() else {
            return Ok(SourceState::Unavailable);
        };
        let opened = open_for_root(root)?;
        let live = info(&opened.volume)?;
        let Some((snapshot, stored)) = store.load_for_root(root) else {
            return Ok(SourceState::Unavailable);
        };
        if is_replayable(stored.cursor, &live) {
            Ok(SourceState::Ready {
                snapshot,
                consistent_at_ms: stored.consistent_at_ms,
            })
        } else {
            Ok(SourceState::Unavailable)
        }
    }
}

impl FsDataSource for WinFsSource {
    fn state(&self, root: &Path) -> SourceState {
        if !root_is_directory(root) {
            return SourceState::Unavailable;
        }
        match self.probe_state(root) {
            Ok(state) => state,
            Err(SourceError::Unsupported) => SourceState::Unsupported,
            Err(_) => SourceState::Unavailable,
        }
    }

    fn enumerate(&self, root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
        Ok(self.enumerate_with_cursor(root, budget)?.0)
    }

    fn changes(&self, root: &Path, since: SnapshotId) -> Result<Vec<Change>, SourceError> {
        Ok(self.changes_report(root, since)?.changes)
    }
}

impl WinFsSource {
    /// Cold enumeration plus the tail cursor that describes it.
    ///
    /// Call this first, then persist `StoredCursor { cursor, consistent_at_ms:
    /// set.consistent_at_ms }` through the host store. The returned cursor is
    /// the journal boundary the set was caught up to; using a cursor captured
    /// after a separate enumerate would skip records that set never saw.
    pub fn enumerate_with_cursor(
        &self,
        root: &Path,
        budget: EnumBudget,
    ) -> Result<(CandidateSet, JournalCursor), SourceError> {
        if budget.expired() {
            return Err(SourceError::Budget);
        }
        let opened = open_for_root(root)?;
        let live = info(&opened.volume)?;
        let start = JournalCursor::from_info(&live);
        let nodes = collect_nodes(&opened.volume, &budget)?;
        let batch = assemble(&nodes, opened.root_fid, opened.volume_serial, &budget)?;
        let seed = subtree_paths(&nodes, opened.root_fid)?;
        let (entries, tail) = catch_up(&opened.volume, start, &budget)?;
        let mut candidates: HashMap<FileKey, Candidate> =
            HashMap::with_capacity(batch.entries.len());
        for candidate in batch.entries {
            candidates.insert(candidate.key, candidate);
        }
        let skipped = apply_entries(&seed, &mut candidates, &entries, opened.volume_serial)?;
        let mut collected: Vec<Candidate> = candidates.into_values().collect();
        collected.sort_by(|left, right| left.rel.cmp(&right.rel));
        let mut truncated = batch.truncated || skipped > 0;
        if collected.len() > budget.max_entries {
            truncated = true;
            collected.truncate(budget.max_entries);
        }
        Ok((
            CandidateSet {
                entries: collected,
                truncated,
                consistent_at_ms: now_ms(),
            },
            tail,
        ))
    }
}

/// Budget for one changes replay: bounded by time and the node cap.
fn changes_budget() -> EnumBudget {
    EnumBudget::new(usize::MAX, usize::MAX, Instant::now() + CHANGES_TIMEOUT)
}

fn root_is_directory(root: &Path) -> bool {
    fs::metadata(root).is_ok_and(|metadata| metadata.is_dir())
}

#[cfg(test)]
#[path = "source_tests.rs"]
mod source_tests;
