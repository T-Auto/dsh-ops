// Design informed by mustafaahci/goz (MIT).
//! In-memory storage for the file-name index.
//!
//! The index is a pure data structure: it performs no IO, takes no locks, names
//! no operating-system API, and fails only on caller bugs (an id from a
//! different index, a release while a chain is still linked), never on input
//! bytes. The caller builds it from a platform source, then queries it; the
//! entry id is stable for as long as the slot is live, so query results can hold
//! ids while the index is read.
//!
//! Modules:
//!
//! - [`name`]: interned raw/folded arenas, refcounts, same-name chains, and
//!   compaction renumbering.
//! - [`entry`]: the twelve-column struct-of-arrays entry table with free-slot
//!   reuse and tombstones, 57 bytes per live slot.
//! - [`record_map`]: dense or sparse map from a record number to an entry.
//!
//! The policy layer (apply, rename, paths, scopes) is built on these types; this
//! module deliberately holds no file-system state and no snapshot logic.

pub mod entry;
pub mod name;
pub mod record_map;

pub use entry::{
    ENTRY_BYTES, EntryFlags, EntryTable, EntryView, MTIME_UNKNOWN, NO_NAME, SIZE_UNKNOWN,
};
pub use name::{
    ArenaSpan, COMPACT_GARBAGE_FACTOR, COMPACT_MIN_BYTES, CompactPlan, NameChain, NamePair,
    NameRef, NameStore,
};
pub use record_map::RecordMap;

#[cfg(test)]
#[path = "mod_tests.rs"]
mod mod_tests;
