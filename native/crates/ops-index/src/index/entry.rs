// Design informed by mustafaahci/goz (MIT).
//! Struct-of-arrays entry table.
//!
//! One entry is one `(parent, name)` link, not one file: a hard-linked file owns
//! several entries, chained through `next_link`. Twelve columnar vectors hold
//! the fields, so a live slot costs exactly [`ENTRY_BYTES`] (57) bytes --
//! `8 + 4 + 4 + 1 + 8 + 8 + 6 * 4` -- with no per-slot padding. Slots are never
//! renumbered, so an id stays valid until the slot is tombstoned and reused;
//! while live it can never alias a different entry.
//!
//! Free slots form a LIFO stack. [`EntryTable::tombstone`] clears every chain
//! link before pushing the slot and [`EntryTable::alloc`] writes every field of
//! a reused slot, so a slot cannot inherit an edge from its previous occupant.
//! Sizes and modification times use sentinels ([SIZE_UNKNOWN], [MTIME_UNKNOWN]):
//! an `Option<u64>` column would cost eight more bytes per slot.

use crate::ids::{EntryId, NameId, RecordId};

/// Name id of a slot that owns no name (a tombstoned slot after compaction).
///
/// Compaction drops dead names and renumbers the rest, so the name column of a
/// dead slot is rewritten to this value; [`EntryTable::alloc`] overwrites it
/// before the slot becomes live again, so no live entry ever reports it.
pub const NO_NAME: NameId = NameId::new(u32::MAX);

/// Size sentinel for "not known yet".
pub const SIZE_UNKNOWN: u64 = u64::MAX;

/// Modification-time sentinel for "not known yet".
pub const MTIME_UNKNOWN: i64 = i64::MIN;

/// Per-slot storage cost of [`EntryTable`] in bytes.
pub const ENTRY_BYTES: usize = size_of::<RecordId>()
    + size_of::<EntryId>()
    + size_of::<NameId>()
    + size_of::<EntryFlags>()
    + size_of::<u64>()
    + size_of::<i64>()
    + 6 * size_of::<u32>();

const _: () = assert!(ENTRY_BYTES == 57);
const _: () = assert!(size_of::<EntryFlags>() == 1);

/// One-byte flags word of an entry.
///
/// The flags are independent: a directory can be lost-and-found, a placeholder
/// can carry a non-Unicode name, and every kind can be detached from its
/// parent's child chain.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct EntryFlags(u8);

impl EntryFlags {
    /// No flag set.
    pub const EMPTY: Self = Self(0);
    /// The entry names a directory.
    pub const DIR: Self = Self(1 << 0);
    /// The slot is dead and on the free stack.
    pub const TOMBSTONE: Self = Self(1 << 1);
    /// The entry is the synthetic lost-and-found directory.
    pub const LOST_FOUND: Self = Self(1 << 2);
    /// The entry is a synthetic orphan placeholder.
    pub const PLACEHOLDER: Self = Self(1 << 3);
    /// The name was not valid Unicode and round-tripped as WTF-8.
    pub const NON_UNICODE_NAME: Self = Self(1 << 4);
    /// The entry was severed from its parent's child chain.
    pub const CHAIN_DETACHED: Self = Self(1 << 5);

    /// Raw bits; unknown bits are preserved so a future flag can round-trip.
    pub const fn bits(self) -> u8 {
        self.0
    }

    /// Wraps raw bits.
    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    /// Whether every bit of `other` is set.
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    /// Returns `self` with every bit of `other` set to `on`.
    pub const fn with(self, other: Self, on: bool) -> Self {
        if on {
            Self(self.0 | other.0)
        } else {
            Self(self.0 & !other.0)
        }
    }
}

impl std::fmt::Debug for EntryFlags {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "EntryFlags({:#04x})", self.0)
    }
}

/// Read-only snapshot of one live entry's scalar columns.
///
/// A value, not a borrow: the query layer keeps hit ids and re-reads views per
/// page without holding the table borrowed, and a 56-byte copy is cheaper than
/// a lifetime on every candidate.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EntryView {
    record: RecordId,
    parent: EntryId,
    name: NameId,
    flags: EntryFlags,
    size: Option<u64>,
    mtime: Option<i64>,
}

impl EntryView {
    /// File-system record this entry belongs to.
    pub const fn record(self) -> RecordId {
        self.record
    }

    /// Parent entry, or [`EntryId::NIL`] at the top of the tree.
    pub const fn parent(self) -> EntryId {
        self.parent
    }

    /// Interned name of the entry.
    pub const fn name_id(self) -> NameId {
        self.name
    }

    /// Flags word of the entry.
    pub const fn flags(self) -> EntryFlags {
        self.flags
    }

    /// Size in bytes, or `None` while unknown.
    pub const fn size(self) -> Option<u64> {
        self.size
    }

    /// Modification time in nanoseconds since the Unix epoch, or `None`.
    pub const fn mtime(self) -> Option<i64> {
        self.mtime
    }

    /// Whether the entry names a directory.
    pub const fn is_dir(self) -> bool {
        self.flags.contains(EntryFlags::DIR)
    }

    /// Whether the entry is synthetic: a lost-and-found directory or an orphan
    /// placeholder. (The root's identity is the policy layer's, not a flag.)
    pub const fn is_synthetic(self) -> bool {
        self.flags.contains(EntryFlags::PLACEHOLDER) || self.flags.contains(EntryFlags::LOST_FOUND)
    }

    /// Whether the entry may appear as a normal query hit: it is live, not
    /// synthetic, and still attached to its parent's child chain.
    pub const fn is_presentable(self) -> bool {
        !self.flags.contains(EntryFlags::TOMBSTONE)
            && !self.is_synthetic()
            && !self.flags.contains(EntryFlags::CHAIN_DETACHED)
    }
}

/// Struct-of-arrays table of index entries.
#[derive(Default)]
pub struct EntryTable {
    record: Vec<RecordId>,
    parent: Vec<EntryId>,
    name: Vec<NameId>,
    flags: Vec<EntryFlags>,
    size: Vec<u64>,
    mtime: Vec<i64>,
    next_link: Vec<EntryId>,
    next_same: Vec<EntryId>,
    prev_same: Vec<EntryId>,
    first_child: Vec<EntryId>,
    next_child: Vec<EntryId>,
    prev_child: Vec<EntryId>,
    free: Vec<EntryId>,
    live: usize,
}

impl EntryTable {
    /// Builds an empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of live entries.
    pub fn len(&self) -> usize {
        self.live
    }

    /// Whether no entry is live.
    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    /// Number of slots ever allocated, live or tombstoned.
    pub fn allocated(&self) -> usize {
        self.record.len()
    }

    /// Number of slots waiting on the free stack.
    pub fn free_slots(&self) -> usize {
        self.free.len()
    }

    /// Every live entry id, in slot order.
    ///
    /// Includes the root, lost-and-found, and placeholders; callers filter with
    /// [`EntryView::is_presentable`] or the policy layer's synthetic test.
    pub fn live_entries(&self) -> impl Iterator<Item = EntryId> + '_ {
        (0..self.record.len())
            .map(|index| EntryId::new(u32::try_from(index).expect("entry id exceeds 32 bits")))
            .filter(|entry| self.is_live(*entry))
    }

    /// Reads one live entry, or `None` for a tombstone or an out-of-range id.
    ///
    /// Unlike [`Self::record`] and friends this never panics on a stale id,
    /// which is what a query result holding ids across compaction needs.
    pub fn get(&self, entry: EntryId) -> Option<EntryView> {
        let index = entry.index();
        if index >= self.record.len() || self.is_tombstone(entry) {
            return None;
        }
        Some(EntryView {
            record: self.record[index],
            parent: self.parent[index],
            name: self.name[index],
            flags: self.flags[index],
            size: self.size(entry),
            mtime: self.mtime(entry),
        })
    }

    /// Allocates a slot, reusing the most recently freed one when possible.
    ///
    /// The caller passes every field that is not a chain link; links are always
    /// reset to [`EntryId::NIL`].
    ///
    /// # Panics
    ///
    /// Panics when `flags` contain [`EntryFlags::TOMBSTONE`]: allocation and
    /// tombstoning are separate operations, and the check holds in every
    /// profile (a release build would otherwise create a live slot with the
    /// tombstone bit set).
    pub fn alloc(
        &mut self,
        record: RecordId,
        parent: EntryId,
        name: NameId,
        flags: EntryFlags,
    ) -> EntryId {
        assert!(
            !flags.contains(EntryFlags::TOMBSTONE),
            "alloc cannot create a tombstoned entry"
        );
        let entry = match self.free.pop() {
            Some(entry) => {
                let index = entry.index();
                debug_assert!(self.is_tombstone(entry));
                self.record[index] = record;
                self.parent[index] = parent;
                self.name[index] = name;
                self.flags[index] = flags;
                self.size[index] = SIZE_UNKNOWN;
                self.mtime[index] = MTIME_UNKNOWN;
                self.next_link[index] = EntryId::NIL;
                self.next_same[index] = EntryId::NIL;
                self.prev_same[index] = EntryId::NIL;
                self.first_child[index] = EntryId::NIL;
                self.next_child[index] = EntryId::NIL;
                self.prev_child[index] = EntryId::NIL;
                entry
            }
            None => {
                let index = self.record.len();
                let entry = EntryId::new(
                    u32::try_from(index).expect("entry table index exceeds a 32-bit entry id"),
                );
                self.record.push(record);
                self.parent.push(parent);
                self.name.push(name);
                self.flags.push(flags);
                self.size.push(SIZE_UNKNOWN);
                self.mtime.push(MTIME_UNKNOWN);
                self.next_link.push(EntryId::NIL);
                self.next_same.push(EntryId::NIL);
                self.prev_same.push(EntryId::NIL);
                self.first_child.push(EntryId::NIL);
                self.next_child.push(EntryId::NIL);
                self.prev_child.push(EntryId::NIL);
                entry
            }
        };
        self.live += 1;
        entry
    }

    /// Kills a slot: sets the tombstone flag, clears its links, and frees it.
    ///
    /// Ties to the name, parent, and sibling entries must already be removed;
    /// only the slot itself is cleared here.
    ///
    /// # Panics
    ///
    /// Panics when the slot is already a tombstone or still has a live child
    /// chain. Both are caller bugs; the checks hold in every profile because a
    /// release build that freed a directory with live children would sever them
    /// silently.
    pub fn tombstone(&mut self, entry: EntryId) {
        let index = entry.index();
        assert!(
            !self.is_tombstone(entry),
            "entry {entry:?} was already tombstoned"
        );
        assert!(
            self.first_child[index].is_nil(),
            "a directory with live children cannot be tombstoned"
        );
        self.flags[index] = self.flags[index].with(EntryFlags::TOMBSTONE, true);
        self.next_link[index] = EntryId::NIL;
        self.next_same[index] = EntryId::NIL;
        self.prev_same[index] = EntryId::NIL;
        self.first_child[index] = EntryId::NIL;
        self.next_child[index] = EntryId::NIL;
        self.prev_child[index] = EntryId::NIL;
        self.live -= 1;
        self.free.push(entry);
    }

    /// File-system record this entry belongs to.
    pub fn record(&self, entry: EntryId) -> RecordId {
        self.record[entry.index()]
    }

    /// Parent entry, or [`EntryId::NIL`] for the root and lost-and-found.
    pub fn parent(&self, entry: EntryId) -> EntryId {
        self.parent[entry.index()]
    }

    /// Re-parents an entry; the caller moves it between child chains.
    pub fn set_parent(&mut self, entry: EntryId, parent: EntryId) {
        self.parent[entry.index()] = parent;
    }

    /// Interned name of the entry.
    pub fn name_id(&self, entry: EntryId) -> NameId {
        self.name[entry.index()]
    }

    /// Replaces the interned name; the caller moves it between same-name chains.
    pub fn set_name(&mut self, entry: EntryId, name: NameId) {
        self.name[entry.index()] = name;
    }

    /// Flags word of the entry.
    pub fn flags(&self, entry: EntryId) -> EntryFlags {
        self.flags[entry.index()]
    }

    /// Replaces the flags word.
    pub fn set_flags(&mut self, entry: EntryId, flags: EntryFlags) {
        self.flags[entry.index()] = flags;
    }

    /// Whether the slot is dead.
    pub fn is_tombstone(&self, entry: EntryId) -> bool {
        self.flags[entry.index()].contains(EntryFlags::TOMBSTONE)
    }

    /// Whether the slot is live (the inverse of [`Self::is_tombstone`]).
    pub fn is_live(&self, entry: EntryId) -> bool {
        !self.is_tombstone(entry)
    }

    /// Size in bytes, or `None` while unknown.
    pub fn size(&self, entry: EntryId) -> Option<u64> {
        let raw = self.size[entry.index()];
        (raw != SIZE_UNKNOWN).then_some(raw)
    }

    /// Stores a size, mapping `None` back to the sentinel.
    pub fn set_size(&mut self, entry: EntryId, size: Option<u64>) {
        self.size[entry.index()] = size.unwrap_or(SIZE_UNKNOWN);
    }

    /// Modification time in nanoseconds since the Unix epoch, or `None` while
    /// unknown.
    pub fn mtime(&self, entry: EntryId) -> Option<i64> {
        let raw = self.mtime[entry.index()];
        (raw != MTIME_UNKNOWN).then_some(raw)
    }

    /// Stores a modification time, mapping `None` back to the sentinel.
    pub fn set_mtime(&mut self, entry: EntryId, mtime: Option<i64>) {
        self.mtime[entry.index()] = mtime.unwrap_or(MTIME_UNKNOWN);
    }

    /// Next link of the same record's hard-link chain.
    pub fn next_link(&self, entry: EntryId) -> EntryId {
        self.next_link[entry.index()]
    }

    /// Sets the next hard-link pointer.
    pub fn set_next_link(&mut self, entry: EntryId, next: EntryId) {
        self.next_link[entry.index()] = next;
    }

    /// Next entry with the same interned name.
    pub fn next_same(&self, entry: EntryId) -> EntryId {
        self.next_same[entry.index()]
    }

    /// Previous entry with the same interned name.
    pub fn prev_same(&self, entry: EntryId) -> EntryId {
        self.prev_same[entry.index()]
    }

    /// Sets both same-name links at once.
    pub fn set_same_links(&mut self, entry: EntryId, next: EntryId, prev: EntryId) {
        self.next_same[entry.index()] = next;
        self.prev_same[entry.index()] = prev;
    }

    /// Sets the previous same-name pointer alone.
    pub fn set_prev_same(&mut self, entry: EntryId, prev: EntryId) {
        self.prev_same[entry.index()] = prev;
    }

    /// Sets the next same-name pointer alone.
    pub fn set_next_same(&mut self, entry: EntryId, next: EntryId) {
        self.next_same[entry.index()] = next;
    }

    /// First child in the directory's child chain.
    pub fn first_child(&self, entry: EntryId) -> EntryId {
        self.first_child[entry.index()]
    }

    /// Sets the first child pointer.
    pub fn set_first_child(&mut self, entry: EntryId, child: EntryId) {
        self.first_child[entry.index()] = child;
    }

    /// Next sibling in the parent's child chain.
    pub fn next_child(&self, entry: EntryId) -> EntryId {
        self.next_child[entry.index()]
    }

    /// Sets the next-sibling pointer.
    pub fn set_next_child(&mut self, entry: EntryId, next: EntryId) {
        self.next_child[entry.index()] = next;
    }

    /// Previous sibling in the parent's child chain.
    pub fn prev_child(&self, entry: EntryId) -> EntryId {
        self.prev_child[entry.index()]
    }

    /// Sets the previous-sibling pointer.
    pub fn set_prev_child(&mut self, entry: EntryId, prev: EntryId) {
        self.prev_child[entry.index()] = prev;
    }
}

#[cfg(test)]
#[path = "entry_tests.rs"]
mod entry_tests;
