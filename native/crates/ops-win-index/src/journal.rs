// Design informed by mustafaahci/goz (MIT).
//! USN journal tail: cursor encoding, the host cursor-store interface, and a
//! bounded catch-up loop.
//!
//! The journal is a circular buffer. ops-index's cursor module decides whether
//! a saved cursor may be replayed; this module owns the parts that need a
//! volume handle: querying the live window and reading records up to the tail.
//! It never creates a journal: a volume without an active journal answers
//! Unsupported and the caller keeps using its own traversal, so this slice
//! cannot have the side effect of starting a journal on someone else's volume.
//!
//! CursorStore is the persistence interface, not an implementation: the worker
//! is one short-lived process, so a cursor must live in the host's cache dir
//! together with the index snapshot it describes. Atomic disk writes belong to
//! the persistence slices; this module defines what is stored, how it is
//! encoded, and how a snapshot id is obtained. MemoryCursorStore is the
//! in-memory implementation for tests and for a single-call integration.

use crate::mft::map_usn_error;
use ops_index::usn::cursor::{JournalInfo, Resync, SavedCursor, validate_cursor};
use ops_index::{EnumBudget, SnapshotId, SourceError};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use usn_journal_rs::journal::{JournalIterOptions, UsnEntry};
use usn_journal_rs::{Usn, UsnError, UsnReason, volume::Volume};

/// Maximum number of journal records one replay may collect.
pub const MAX_JOURNAL_ENTRIES: usize = 1 << 20;

/// Maximum number of catch-up rounds before the journal is declared too busy.
pub const MAX_CATCH_UP_ROUNDS: usize = 8;

/// Encoded length of one persisted cursor.
pub const CURSOR_BYTES: usize = 17;

/// Version byte of the cursor encoding.
const CURSOR_VERSION: u8 = 1;

/// A per-volume journal cursor: journal instance plus the next USN to read.
///
/// This is the persisted form of ops_index::usn::cursor::SavedCursor. Keep it
/// in the same generation as the index snapshot it describes; a cursor that
/// outlives its snapshot would let an empty index claim to be caught up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JournalCursor {
    journal_id: u64,
    next_usn: i64,
}

impl JournalCursor {
    /// Builds a cursor from a journal instance and the next USN to read.
    pub const fn new(journal_id: u64, next_usn: i64) -> Self {
        Self {
            journal_id,
            next_usn,
        }
    }

    /// Journal instance identifier.
    pub const fn journal_id(self) -> u64 {
        self.journal_id
    }

    /// Next USN to read.
    pub const fn next_usn(self) -> i64 {
        self.next_usn
    }

    /// Converts to the pure validation type.
    pub const fn saved(self) -> SavedCursor {
        SavedCursor {
            journal_id: self.journal_id,
            next_usn: self.next_usn,
        }
    }

    /// Converts from the pure validation type.
    pub const fn from_saved(saved: SavedCursor) -> Self {
        Self::new(saved.journal_id, saved.next_usn)
    }

    /// Cursor at the live tail of a journal window.
    pub fn from_info(info: &JournalInfo) -> Self {
        Self::new(info.journal_id, info.next_usn)
    }

    /// Versioned little-endian encoding for the host cache.
    pub fn encode(self) -> [u8; CURSOR_BYTES] {
        let mut bytes = [0u8; CURSOR_BYTES];
        bytes[0] = CURSOR_VERSION;
        bytes[1..9].copy_from_slice(&self.journal_id.to_le_bytes());
        bytes[9..17].copy_from_slice(&self.next_usn.to_le_bytes());
        bytes
    }

    /// Decodes a cursor written by encode, or None for a foreign version or a
    /// truncated record.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != CURSOR_BYTES || bytes[0] != CURSOR_VERSION {
            return None;
        }
        let journal_id = u64::from_le_bytes(bytes[1..9].try_into().ok()?);
        let next_usn = i64::from_le_bytes(bytes[9..17].try_into().ok()?);
        Some(Self::new(journal_id, next_usn))
    }
}

/// A persisted cursor together with the moment its snapshot was built.
///
/// consistent_at_ms travels with the cursor so state can report the snapshot's
/// own timestamp instead of the moment state happens to be asked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StoredCursor {
    /// Cursor to replay from.
    pub cursor: JournalCursor,
    /// Snapshot build time, milliseconds since the Unix epoch.
    pub consistent_at_ms: i64,
}

/// Host-provided cursor storage, keyed by root and by snapshot id.
pub trait CursorStore: Send + Sync {
    /// Latest cursor saved for root, with the snapshot id that describes it.
    fn load_for_root(&self, root: &Path) -> Option<(SnapshotId, StoredCursor)>;

    /// Cursor belonging to a snapshot id, but only when it belongs to root.
    fn load_for_snapshot(&self, root: &Path, snapshot: SnapshotId) -> Option<StoredCursor>;

    /// Stores the cursor for root and returns the snapshot id the host assigned.
    ///
    /// The persistence layer owns atomicity: it must publish the snapshot, the
    /// snapshot time, and the cursor in one generation, never the cursor alone.
    fn save(&self, root: &Path, stored: StoredCursor) -> Option<SnapshotId>;
}

/// In-memory CursorStore for tests and single-call integration.
#[derive(Default)]
pub struct MemoryCursorStore {
    state: Mutex<MemoryState>,
    next_snapshot: AtomicU64,
}

#[derive(Default)]
struct MemoryState {
    by_root: HashMap<PathBuf, (SnapshotId, StoredCursor)>,
    by_snapshot: HashMap<u64, (PathBuf, StoredCursor)>,
}

impl MemoryCursorStore {
    /// Creates an empty store whose first snapshot id is 1.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(MemoryState::default()),
            next_snapshot: AtomicU64::new(1),
        }
    }
}

impl CursorStore for MemoryCursorStore {
    fn load_for_root(&self, root: &Path) -> Option<(SnapshotId, StoredCursor)> {
        self.state.lock().ok()?.by_root.get(root).copied()
    }

    fn load_for_snapshot(&self, root: &Path, snapshot: SnapshotId) -> Option<StoredCursor> {
        let state = self.state.lock().ok()?;
        let (stored_root, stored) = state.by_snapshot.get(&snapshot.get())?;
        (stored_root == root).then_some(*stored)
    }

    fn save(&self, root: &Path, stored: StoredCursor) -> Option<SnapshotId> {
        let mut state = self.state.lock().ok()?;
        let snapshot = SnapshotId::new(self.next_snapshot.fetch_add(1, Ordering::Relaxed));
        state.by_root.insert(root.to_path_buf(), (snapshot, stored));
        state
            .by_snapshot
            .insert(snapshot.get(), (root.to_path_buf(), stored));
        Some(snapshot)
    }
}

/// Queries the live journal window; no journal is an Unsupported source.
pub(crate) fn info(volume: &Volume) -> Result<JournalInfo, SourceError> {
    let data = match volume.journal().query() {
        Ok(data) => data,
        Err(UsnError::JournalNotActive) => return Err(SourceError::Unsupported),
        Err(error) => return Err(map_usn_error(error)),
    };
    Ok(JournalInfo {
        journal_id: data.journal_id,
        first_usn: data.first_usn.get(),
        next_usn: data.next_usn.get(),
        lowest_valid_usn: data.lowest_valid_usn.get(),
        max_usn: data.max_usn.get(),
    })
}

/// Current tail cursor of the volume's journal.
pub(crate) fn current_cursor(volume: &Volume) -> Result<JournalCursor, SourceError> {
    Ok(JournalCursor::from_info(&info(volume)?))
}

/// Whether a saved cursor may be replayed against the live window.
pub(crate) fn is_replayable(cursor: JournalCursor, live: &JournalInfo) -> bool {
    matches!(validate_cursor(&cursor.saved(), live), Resync::InSync)
}

/// Reads every record from cursor to the current tail without waiting.
fn read_from(
    volume: &Volume,
    cursor: JournalCursor,
    budget: &EnumBudget,
) -> Result<Vec<UsnEntry>, SourceError> {
    let options = JournalIterOptions::builder()
        .start_usn(Usn::new(cursor.next_usn))
        .reason_mask(UsnReason::from_bits_retain(ops_index::usn::REASON_MASK))
        .wait_for_more(false)
        .build()
        .map_err(|_| SourceError::Io(ErrorKind::InvalidInput))?;
    let iter = volume
        .journal()
        .try_iter_with_options(options)
        .map_err(map_usn_error)?;
    let mut entries = Vec::new();
    for item in iter {
        if budget.expired() {
            return Err(SourceError::Budget);
        }
        entries.push(item.map_err(map_usn_error)?);
        if entries.len() >= MAX_JOURNAL_ENTRIES {
            return Err(SourceError::Budget);
        }
    }
    Ok(entries)
}

/// Replays journal records until the cursor reaches a quiescent tail.
///
/// Returns every record read, in journal order, plus the cursor that can be
/// persisted once the caller has applied them. If writes keep arriving during
/// the read, the loop retries from the first unread USN; MAX_CATCH_UP_ROUNDS
/// bounds that retry, and hitting the bound is NotReady (the caller rescans).
pub(crate) fn catch_up(
    volume: &Volume,
    start: JournalCursor,
    budget: &EnumBudget,
) -> Result<(Vec<UsnEntry>, JournalCursor), SourceError> {
    let mut cursor = start;
    let mut entries = Vec::new();
    for _ in 0..MAX_CATCH_UP_ROUNDS {
        if budget.expired() {
            return Err(SourceError::Budget);
        }
        let before = info(volume)?;
        if !is_replayable(cursor, &before) {
            return Err(SourceError::NotReady);
        }
        if before.next_usn <= cursor.next_usn {
            return Ok((entries, JournalCursor::from_info(&before)));
        }
        let round = read_from(volume, cursor, budget)?;
        if entries.len().saturating_add(round.len()) > MAX_JOURNAL_ENTRIES {
            return Err(SourceError::Budget);
        }
        entries.extend(round);
        let after = info(volume)?;
        if after.journal_id != cursor.journal_id {
            return Err(SourceError::NotReady);
        }
        if after.next_usn <= before.next_usn {
            return Ok((
                entries,
                JournalCursor::new(after.journal_id, after.next_usn),
            ));
        }
        // Writes landed while reading. The reason mask may have filtered every
        // record out of this read, so advance by the queried boundary, not by
        // the last matching record, and read the new tail next round.
        cursor = JournalCursor::new(after.journal_id, before.next_usn);
    }
    Err(SourceError::NotReady)
}

#[cfg(test)]
#[path = "journal_tests.rs"]
mod journal_tests;
