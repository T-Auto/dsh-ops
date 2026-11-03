// Design informed by mustafaahci/goz (MIT).
//! Replayable source cursors and the rescan decision.
//!
//! A snapshot is only reusable when the source can prove it has caught up from
//! the cursor saved with it. That decision is a pure function here:
//! [`validate_cursor`] takes the saved cursor and the live source state and
//! returns `InSync` or `FullRescan(reason)`.
//!
//! The USN truth table is **not** duplicated: the `Cursor::Usn` branch converts
//! to [`crate::usn::cursor`] and delegates to its `validate_cursor`, then maps the
//! three USN reasons into this module's vocabulary. There is exactly one place
//! that decides journal-id change, purge and restamp, so the two layers cannot
//! drift.
//!
//! Two source shapes need their own rules:
//!
//! - FSEvents: an event id. `InSync` here means only that the id is
//!   *replayable*, not that replay is complete: the FSEvents log can be rotated
//!   or purged, which the platform stream reports as
//!   `kFSEventStreamEventFlagMustScanSubDirs`. The macOS source crate (M2/M3)
//!   must turn that flag into a full rescan; this pure function cannot see it
//!   from an event id.
//! - Unreplayable: Linux watch descriptors have no replay log, so no cursor can
//!   prove anything; the answer is always a full rescan.
//!
//! The caller persists a cursor next to the snapshot and must only reuse them
//! together; a saved cursor without its snapshot would let an empty index claim
//! to be current.

use crate::usn::cursor;

/// Saved cursor of the source that produced a snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cursor {
    /// USN journal position; validated by [`crate::usn::cursor`].
    Usn(cursor::SavedCursor),
    /// FSEvents event id.
    Fsevents {
        /// Last event id that was applied. `InSync` only promises replayability;
        /// a `MustScanSubDirs` replay result still forces a full rescan.
        event_id: u64,
    },
    /// The source has no replay log (Linux watch descriptors).
    Unreplayable,
}

/// Live state of the source, used to validate a saved cursor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Replay {
    /// A USN journal is live with this state.
    Usn(cursor::JournalInfo),
    /// An FSEvents log is live up to this event id.
    Fsevents {
        /// Latest event id the source can hand out.
        latest_event_id: u64,
    },
    /// The source has no replay log.
    Unreplayable,
}

/// Whether a saved cursor may be trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resync {
    /// The snapshot may be used after replaying from the saved cursor.
    InSync,
    /// The snapshot must be discarded and rebuilt.
    FullRescan(RescanReason),
}

impl Resync {
    /// Whether the snapshot may be used.
    pub fn is_in_sync(self) -> bool {
        matches!(self, Self::InSync)
    }
}

/// Why a saved cursor forced a full rescan.
///
/// The three USN reasons are produced by [`crate::usn::cursor`] and mapped by
/// [`validate_cursor`]; `SourceChanged` and `Unreplayable` are decided here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RescanReason {
    /// The journal was recreated and has a new identity.
    JournalIdChanged,
    /// The saved position fell below the first readable USN (journal wrapped).
    CursorPurged,
    /// The journal was restamped: the saved position is below the valid range or
    /// in the future.
    RestampDiscontinuity,
    /// The saved cursor describes a different kind of source.
    SourceChanged,
    /// The source has no replay log.
    Unreplayable,
}

impl RescanReason {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::JournalIdChanged => "INDEX_CURSOR_JOURNAL_ID_CHANGED",
            Self::CursorPurged => "INDEX_CURSOR_PURGED",
            Self::RestampDiscontinuity => "INDEX_CURSOR_RESTAMP",
            Self::SourceChanged => "INDEX_CURSOR_SOURCE_CHANGED",
            Self::Unreplayable => "INDEX_CURSOR_UNREPLAYABLE",
        }
    }
}

/// Decides whether a saved cursor may be trusted against the live source.
///
/// Total and pure: no I/O, no clock, no panics. Order:
///
/// 1. either side unreplayable -> `Unreplayable`;
/// 2. the USN branch delegates to [`crate::usn::cursor::validate_cursor`] and
///    maps its reason (journal id, purge, restamp);
/// 3. FSEvents: a cursor ahead of the latest id is a restamp, otherwise the id
///    is replayable (`InSync`);
/// 4. a cursor for another source kind -> `SourceChanged`.
pub fn validate_cursor(saved: &Cursor, live: &Replay) -> Resync {
    if matches!(saved, Cursor::Unreplayable) || matches!(live, Replay::Unreplayable) {
        return Resync::FullRescan(RescanReason::Unreplayable);
    }
    match (saved, live) {
        (Cursor::Usn(saved), Replay::Usn(info)) => match cursor::validate_cursor(saved, info) {
            cursor::Resync::InSync => Resync::InSync,
            cursor::Resync::FullRescan(reason) => Resync::FullRescan(from_usn_reason(reason)),
        },
        (Cursor::Fsevents { event_id }, Replay::Fsevents { latest_event_id }) => {
            if *event_id > *latest_event_id {
                return Resync::FullRescan(RescanReason::RestampDiscontinuity);
            }
            Resync::InSync
        }
        _ => Resync::FullRescan(RescanReason::SourceChanged),
    }
}

/// Maps the USN vocabulary into the persistence vocabulary.
///
/// The USN enum is exhaustive inside this crate, so a new USN reason becomes a
/// compile error here instead of silently mapping to a full rescan.
fn from_usn_reason(reason: cursor::RescanReason) -> RescanReason {
    match reason {
        cursor::RescanReason::JournalIdChanged => RescanReason::JournalIdChanged,
        cursor::RescanReason::CursorPurged => RescanReason::CursorPurged,
        cursor::RescanReason::RestampDiscontinuity => RescanReason::RestampDiscontinuity,
    }
}

#[cfg(test)]
#[path = "cursor_tests.rs"]
mod cursor_tests;
