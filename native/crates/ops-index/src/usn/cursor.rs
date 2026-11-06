// Design informed by mustafaahci/goz (MIT).
//! Cursor validation: replay from a saved USN, or rebuild the volume index.
//!
//! [`validate_cursor`] holds the entire wrap/purge/restamp decision. It is a
//! pure, total function: no IO, no clock, no panic. That keeps the boundaries
//! (equality included) exhaustively unit-testable and leaves reads, retries and
//! error mapping with the caller.
//!
//! A saved cursor is only meaningful together with the index snapshot it
//! describes. Persist the two atomically and in one generation: a cursor that
//! outlives its index would let a freshly empty index claim to be current, and
//! every query would serve a complete-but-empty volume as in sync. This module
//! therefore defines the types and the decision, never any storage.

/// A per-volume cursor: the journal identity and next USN a caller persists in
/// order to replay instead of rescan.
///
/// Persist it with the index snapshot it belongs to, never alone; see the
/// module docs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SavedCursor {
    /// `UsnJournalID` of the journal the cursor was taken from.
    pub journal_id: u64,
    /// Next USN to read: the leading value of the last processed buffer.
    pub next_usn: i64,
}

/// Live journal state, decoded from `USN_JOURNAL_DATA_V*`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JournalInfo {
    /// `UsnJournalID`: the journal instance identifier. It changes when the
    /// journal is deleted and recreated (or restamped).
    pub journal_id: u64,
    /// `FirstUsn`: the oldest record still readable. Everything below it has
    /// been purged from the front (the wrap).
    pub first_usn: i64,
    /// `NextUsn`: the USN the next written record will get.
    pub next_usn: i64,
    /// `LowestValidUsn`: USNs below it predate the current journal stamping, so
    /// a cursor below it means a discontinuity.
    pub lowest_valid_usn: i64,
    /// `MaxUsn`: hard ceiling. The journal must be recreated as `NextUsn`
    /// approaches it, but that is an operational concern, not a staleness one,
    /// so [`validate_cursor`] never reads this field.
    pub max_usn: i64,
}

/// Outcome of cursor validation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resync {
    /// The saved cursor is valid: replay the journal from `saved.next_usn`.
    InSync,
    /// Changes were (or may have been) missed: rebuild the volume index.
    FullRescan(RescanReason),
}

/// Why a full rescan was decided.
///
/// Only these three causes come from [`validate_cursor`]. Runtime causes (read
/// errors, parser aborts, a detached volume) are the caller's to map; the enum
/// is `#[non_exhaustive]` so callers can keep one telemetry vocabulary without
/// this crate knowing any platform concept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RescanReason {
    /// The saved `UsnJournalID` differs from the live one: the journal was
    /// deleted and recreated while it was not being followed.
    JournalIdChanged,
    /// `saved.next_usn < FirstUsn`: the journal wrapped past the cursor and the
    /// records in between were purged from the front.
    CursorPurged,
    /// The cursor is outside the journal's valid USN window without a purge
    /// explaining it: below `LowestValidUsn`, or ahead of the live `NextUsn`
    /// (a cursor from the future means the journal was restamped).
    RestampDiscontinuity,
}

/// Decides whether a saved cursor can be replayed against the live journal or
/// the volume needs a full rescan.
///
/// Truth table, first match wins:
///
/// | Condition | Result |
/// | --- | --- |
/// | `saved.journal_id != live.journal_id` | `FullRescan(JournalIdChanged)` |
/// | `saved.next_usn < live.first_usn` | `FullRescan(CursorPurged)` (the wrap) |
/// | `saved.next_usn < live.lowest_valid_usn` | `FullRescan(RestampDiscontinuity)` |
/// | `saved.next_usn > live.next_usn` | `FullRescan(RestampDiscontinuity)` (cursor from the future) |
/// | otherwise | `InSync` |
///
/// Boundaries are inclusive on the valid side: a cursor at `FirstUsn` can still
/// read the record there, a cursor at `LowestValidUsn` is the oldest valid
/// stamping, and a cursor at `NextUsn` is fully caught up. A journal-id change
/// outranks a purge, and a purge outranks a restamp.
///
/// The function takes no time and no record count: freshness is decided only by
/// the four USN values. An empty journal (`first_usn == next_usn`) accepts only
/// a cursor equal to both; anything lower is purged, anything higher is from the
/// future.
pub fn validate_cursor(saved: &SavedCursor, live: &JournalInfo) -> Resync {
    if saved.journal_id != live.journal_id {
        return Resync::FullRescan(RescanReason::JournalIdChanged);
    }
    if saved.next_usn < live.first_usn {
        return Resync::FullRescan(RescanReason::CursorPurged);
    }
    if saved.next_usn < live.lowest_valid_usn {
        return Resync::FullRescan(RescanReason::RestampDiscontinuity);
    }
    if saved.next_usn > live.next_usn {
        return Resync::FullRescan(RescanReason::RestampDiscontinuity);
    }
    Resync::InSync
}

#[cfg(test)]
#[path = "cursor_tests.rs"]
mod cursor_tests;
