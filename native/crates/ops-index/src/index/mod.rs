// Design informed by mustafaahci/goz (MIT).
//! In-memory storage and policy for the file-name index.
//!
//! The index is a pure data structure: it performs no IO, takes no locks, names
//! no operating-system API, and fails only on caller bugs (an id from a
//! different index, a release while a chain is still linked), never on input
//! bytes. The caller builds it from a platform source, then queries it; an
//! entry id is stable for as long as the slot is live, and [`volume::VolumeIndex`]
//! re-checks the full record id before returning an entry to a paged result.
//!
//! Modules:
//!
//! - [`name`]: interned raw/folded arenas, refcounts, same-name chains, and
//!   compaction renumbering.
//! - [`entry`]: the twelve-column struct-of-arrays entry table with free-slot
//!   reuse and tombstones, 57 bytes per live slot.
//! - [`record_map`]: dense or sparse map from a record number to an entry.
//! - [`volume`]: the per-volume policy - bootstrap, USN apply, hard links,
//!   orphans, and the record-map/child-chain/same-name invariants.
//! - [`path`]: on-demand path reconstruction and read access.
//! - [`scope`]: the persistent directory scope index and subtree walk.
//! - [`storage`]: folded-name order/rank and compaction plan/apply.

pub mod entry;
pub mod name;
pub mod path;
pub mod record_map;
pub mod scope;
pub mod storage;
pub mod volume;

pub use entry::{
    ENTRY_BYTES, EntryFlags, EntryTable, EntryView, MTIME_UNKNOWN, NO_NAME, SIZE_UNKNOWN,
};
pub use name::{
    ArenaSpan, COMPACT_GARBAGE_FACTOR, COMPACT_MIN_BYTES, CompactPlan, NameChain, NamePair,
    NameRef, NameStore,
};
pub use path::{MAX_PATH_HOPS, PathStatus};
pub use record_map::RecordMap;
pub use scope::SubtreeWalk;
pub use storage::{NameOrder, UNRANKED};
pub use volume::{
    Anomaly, ApplyOutcome, IndexStats, LOST_FOUND_NAME, LOST_FOUND_RECORD, LinkTarget,
    MAX_NAME_BYTES, PLACEHOLDER_NAME, VolumeIndex, WtfName,
};

#[cfg(test)]
#[path = "invariants_tests.rs"]
pub(crate) mod invariants_tests;

#[cfg(test)]
#[path = "mod_tests.rs"]
mod mod_tests;
