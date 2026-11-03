// Design informed by mustafaahci/goz (MIT).
//! Interned name arenas.
//!
//! Names live in two byte arenas, each a sequence of `name` + `NUL`: `raw`
//! keeps identity bytes exactly as delivered, `folded` keeps the comparison key
//! from [`crate::fold`]. A name whose raw and folded bytes are equal is stored
//! once -- its raw reference points into the folded arena -- so the common
//! lowercase-ASCII case costs one copy. The NUL terminator is why a scan for a
//! substring across the whole folded arena can never join two names: no name
//! contains NUL, so every match is bounded by one.
//!
//! The dedup table keeps only a four-byte [`NameId`] per slot (plus one control
//! byte, the same overhead a Swiss table has); the key bytes stay in the arena.
//! Interning an existing name compares bytes and bumps a refcount; it never
//! copies. A released name is removed from the table and its bytes are zeroed,
//! which is what makes dead names invisible to folded-arena scans; the id
//! itself is only reused after [`NameStore::install_compacted`] renumbers the
//! live names.
//!
//! The same-name chain head lives here because it is per name, while the links
//! live in the entry table: [`NameStore::link_same`] and
//! [`NameStore::unlink_same`] keep both sides in step.

use crate::fold::fold;
use crate::ids::{EntryId, NameId};
use crate::index::entry::{EntryTable, NO_NAME};

/// Minimum size, in arena bytes, before compaction is worth considering.
pub const COMPACT_MIN_BYTES: usize = 8192;

/// Dead bytes must exceed live bytes by this factor to trigger compaction.
pub const COMPACT_GARBAGE_FACTOR: u64 = 4;

/// Remap value marking a name that compaction dropped.
const DEAD: u32 = u32::MAX;

const SLOT_EMPTY: u8 = 0;
const SLOT_FULL: u8 = 1;
const SLOT_DEAD: u8 = 2;

const LOAD_NUMERATOR: usize = 7;
const LOAD_DENOMINATOR: usize = 8;

/// A slice of one arena: byte offset plus byte length.
///
/// Eight bytes, asserted at compile time. The high bit of `off` means "these
/// bytes are stored in the folded arena" (raw and folded were identical).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct NameRef {
    off: u32,
    len: u16,
}

impl NameRef {
    /// Tag bit of `off` for a raw reference that points into the folded arena.
    const FOLDED_TAG: u32 = 1 << 31;

    /// Largest offset either arena can address.
    const MAX_OFFSET: u32 = Self::FOLDED_TAG - 1;

    /// Reference into the raw arena.
    const fn new(off: u32, len: u16) -> Self {
        Self { off, len }
    }

    /// Reference whose bytes live in the folded arena.
    const fn shared(off: u32, len: u16) -> Self {
        Self {
            off: off | Self::FOLDED_TAG,
            len,
        }
    }

    /// Byte offset inside the arena.
    pub const fn offset(self) -> u32 {
        self.off & !Self::FOLDED_TAG
    }

    /// Length in bytes, excluding the NUL terminator.
    pub const fn len(self) -> u16 {
        self.len
    }

    /// Whether the name is zero bytes long (the root's empty name).
    pub const fn is_empty(self) -> bool {
        self.len == 0
    }

    /// Whether the bytes live in the folded arena.
    pub const fn in_folded(self) -> bool {
        self.off & Self::FOLDED_TAG != 0
    }
}

/// The raw and folded reference of one interned name.
///
/// Sixteen bytes, asserted at compile time; this is the per-name cost on top of
/// the name bytes themselves.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct NamePair {
    raw: NameRef,
    folded: NameRef,
}

impl NamePair {
    /// Identity bytes as delivered by the file system.
    pub const fn raw(self) -> NameRef {
        self.raw
    }

    /// Folded comparison key.
    pub const fn folded(self) -> NameRef {
        self.folded
    }
}

const _: () = assert!(size_of::<NameRef>() == 8);
const _: () = assert!(size_of::<NamePair>() == 16);

/// Byte range of one name inside the raw or folded arena.
///
/// The query layer scans the contiguous folded haystack and needs the byte
/// range of each name to map a hit offset back to a [`NameId`]; exposing the
/// span keeps the arena layout private while making that map possible.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ArenaSpan {
    offset: u32,
    len: u16,
    in_folded: bool,
}

impl ArenaSpan {
    /// Byte offset inside the arena.
    pub const fn offset(self) -> usize {
        self.offset as usize
    }

    /// Length in bytes, excluding the NUL terminator.
    pub const fn len(self) -> usize {
        self.len as usize
    }

    /// Whether the span is zero bytes long.
    pub const fn is_empty(self) -> bool {
        self.len == 0
    }

    /// Whether the bytes live in the folded arena (raw bytes that equal their
    /// folded form are stored there once).
    pub const fn in_folded(self) -> bool {
        self.in_folded
    }

    /// Byte range, ready to index the arena.
    pub const fn range(self) -> core::ops::Range<usize> {
        self.offset as usize..(self.offset as usize + self.len as usize)
    }
}

/// Iterator over the live entries sharing one interned name.
pub struct NameChain<'a> {
    table: &'a EntryTable,
    current: EntryId,
}

impl Iterator for NameChain<'_> {
    type Item = EntryId;

    fn next(&mut self) -> Option<EntryId> {
        let entry = self.current;
        if entry.is_nil() {
            return None;
        }
        self.current = self.table.next_same(entry);
        Some(entry)
    }
}

/// Open-addressing table mapping name bytes to [`NameId`].
///
/// Linear probing over parallel control and id arrays. A slot costs five bytes:
/// one control byte plus the four-byte id; the key is never stored twice. A
/// tombstone keeps probe chains intact; a probe stops only at an empty slot, so
/// lookups after release are still exact.
struct NameTable {
    control: Vec<u8>,
    slots: Vec<u32>,
    len: usize,
    used: usize,
}

impl NameTable {
    const INITIAL_SLOTS: usize = 16;

    /// Builds a table with at least `min_slots` slots and a power-of-two size.
    fn with_min_slots(min_slots: usize) -> Self {
        let slots = min_slots.max(Self::INITIAL_SLOTS).next_power_of_two();
        Self {
            control: vec![SLOT_EMPTY; slots],
            slots: vec![0; slots],
            len: 0,
            used: 0,
        }
    }

    /// FNV-1a over the name bytes; a hash, not an identity.
    fn hash(bytes: &[u8]) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        for &byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }
}

impl Default for NameTable {
    fn default() -> Self {
        Self::with_min_slots(0)
    }
}

/// Interned names plus their same-name chain heads.
#[derive(Default)]
pub struct NameStore {
    raw: Vec<u8>,
    folded: Vec<u8>,
    pairs: Vec<NamePair>,
    refcount: Vec<u32>,
    head: Vec<EntryId>,
    table: NameTable,
    garbage: u64,
    live_names: usize,
}

impl NameStore {
    /// Builds an empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Interns `bytes`, returning the existing id when the exact raw bytes are
    /// already present and incrementing its refcount.
    ///
    /// The name is matched by raw bytes, so `README` and `readme` are two ids
    /// with two refcounts that share one folded key.
    ///
    /// # Panics
    ///
    /// Panics when `bytes` contains NUL (no file system allows it and the arena
    /// format depends on it) or when one arena would exceed 2 GiB.
    pub fn intern(&mut self, bytes: &[u8]) -> NameId {
        debug_assert!(!bytes.contains(&0), "names cannot contain NUL");
        assert!(
            bytes.len() <= usize::from(u16::MAX),
            "name is longer than 65535 bytes"
        );
        if let Some(id) = self.find(bytes) {
            self.refcount[id.index()] += 1;
            return id;
        }
        let folded = fold(bytes);
        let folded_off = Self::append(&mut self.folded, &folded);
        let raw = if folded == bytes {
            NameRef::shared(folded_off, bytes.len() as u16)
        } else {
            NameRef::new(Self::append(&mut self.raw, bytes), bytes.len() as u16)
        };
        let index = u32::try_from(self.pairs.len()).expect("name id exceeds 32 bits");
        let id = NameId::new(index);
        self.pairs.push(NamePair {
            raw,
            folded: NameRef::new(folded_off, folded.len() as u16),
        });
        self.refcount.push(1);
        self.head.push(EntryId::NIL);
        self.live_names += 1;
        let hash = NameTable::hash(bytes);
        self.insert_unique(hash, id);
        id
    }

    /// Number of name slots, live or released.
    pub fn slot_count(&self) -> usize {
        self.pairs.len()
    }

    /// Number of names with a nonzero refcount.
    pub fn live_names(&self) -> usize {
        self.live_names
    }

    /// Refcount of a name slot.
    pub fn refcount(&self, id: NameId) -> u32 {
        self.refcount[id.index()]
    }

    /// Whether the slot holds a name.
    pub fn is_live(&self, id: NameId) -> bool {
        self.refcount[id.index()] > 0
    }

    /// Raw and folded references of a name slot.
    pub fn pair(&self, id: NameId) -> NamePair {
        self.pairs[id.index()]
    }

    /// Identity bytes of a name slot.
    pub fn raw_bytes(&self, id: NameId) -> &[u8] {
        let raw = self.pairs[id.index()].raw;
        let arena = if raw.in_folded() {
            &self.folded
        } else {
            &self.raw
        };
        Self::slice(arena, raw)
    }

    /// Folded comparison key of a name slot.
    pub fn folded_bytes(&self, id: NameId) -> &[u8] {
        let folded = self.pairs[id.index()].folded;
        Self::slice(&self.folded, folded)
    }

    /// Byte range of the raw identity bytes of a name.
    pub fn raw_span(&self, id: NameId) -> ArenaSpan {
        let raw = self.pairs[id.index()].raw;
        ArenaSpan {
            offset: raw.offset(),
            len: raw.len(),
            in_folded: raw.in_folded(),
        }
    }

    /// Byte range of the folded comparison key of a name.
    pub fn folded_span(&self, id: NameId) -> ArenaSpan {
        let folded = self.pairs[id.index()].folded;
        ArenaSpan {
            offset: folded.offset(),
            len: folded.len(),
            in_folded: true,
        }
    }

    /// Bytes a span points at.
    pub fn span_bytes(&self, span: ArenaSpan) -> &[u8] {
        let arena = if span.in_folded {
            &self.folded
        } else {
            &self.raw
        };
        &arena[span.range()]
    }

    /// Every name slot in id order, live or released.
    ///
    /// Folded spans ascend with the id because names are appended in intern
    /// order and compaction preserves that order.
    pub fn name_ids(&self) -> impl Iterator<Item = NameId> {
        (0..self.pairs.len())
            .map(|index| NameId::new(u32::try_from(index).expect("name id exceeds 32 bits")))
    }

    /// Name whose folded span contains `offset`, if it is live.
    ///
    /// Binary searches the ascending folded spans so a whole-arena scan can
    /// map each hit back to its name without a linear walk. A released name
    /// reports `None`: its bytes are zeroed and no scan can match them.
    pub fn folded_name_at(&self, offset: usize) -> Option<NameId> {
        let mut low = 0usize;
        let mut high = self.pairs.len();
        while low < high {
            let middle = (low + high) / 2;
            if self.pairs[middle].folded.offset() as usize <= offset {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        let index = low.checked_sub(1)?;
        if self.refcount[index] == 0 {
            return None;
        }
        let span = self.pairs[index].folded;
        let start = span.offset() as usize;
        if offset < start + span.len() as usize {
            Some(NameId::new(
                u32::try_from(index).expect("name id exceeds 32 bits"),
            ))
        } else {
            None
        }
    }

    /// Iterates the live entries sharing `id`, in same-name chain order.
    pub fn name_chain<'a>(&self, id: NameId, table: &'a EntryTable) -> NameChain<'a> {
        NameChain {
            table,
            current: self.head[id.index()],
        }
    }

    /// Contiguous folded arena: unique names separated by NUL.
    ///
    /// Dead names are zeroed, so scanning this haystack cannot match them and
    /// cannot join two neighbours.
    pub fn folded(&self) -> &[u8] {
        &self.folded
    }

    /// Contiguous raw arena, valid only for names whose raw form differs.
    pub fn raw_arena(&self) -> &[u8] {
        &self.raw
    }

    /// Bytes of released names that compaction could reclaim.
    pub fn garbage_bytes(&self) -> u64 {
        self.garbage
    }

    /// Head of the same-name chain of `id`, or [`EntryId::NIL`].
    pub fn same_head(&self, id: NameId) -> EntryId {
        self.head[id.index()]
    }

    /// Pushes `entry` in front of the same-name chain of `id`.
    pub fn link_same(&mut self, id: NameId, entry: EntryId, table: &mut EntryTable) {
        let head = self.head[id.index()];
        table.set_same_links(entry, head, EntryId::NIL);
        if !head.is_nil() {
            table.set_prev_same(head, entry);
        }
        self.head[id.index()] = entry;
    }

    /// Removes `entry` from the same-name chain of `id`.
    pub fn unlink_same(&mut self, id: NameId, entry: EntryId, table: &mut EntryTable) {
        let next = table.next_same(entry);
        let prev = table.prev_same(entry);
        if prev.is_nil() {
            debug_assert_eq!(
                self.head[id.index()],
                entry,
                "unlinking the head of a same-name chain must see that head"
            );
            self.head[id.index()] = next;
        } else {
            table.set_next_same(prev, next);
        }
        if !next.is_nil() {
            table.set_prev_same(next, prev);
        }
        table.set_same_links(entry, EntryId::NIL, EntryId::NIL);
    }

    /// Drops one reference; when the last one goes, the name is removed from the
    /// dedup table and its bytes are zeroed.
    ///
    /// Returns `true` when the name died. The same-name chain must be empty
    /// first: releasing a name that an entry still points at would leave a
    /// dangling name id.
    ///
    /// # Panics
    ///
    /// Panics when releasing a name that is not live (a bug in the caller),
    /// and in debug builds when the same-name chain is not empty.
    pub fn release(&mut self, id: NameId) -> bool {
        let refcount = &mut self.refcount[id.index()];
        assert!(*refcount > 0, "release of a name that is not live");
        *refcount -= 1;
        if *refcount != 0 {
            return false;
        }
        debug_assert!(
            self.head[id.index()].is_nil(),
            "same-name chain must be unlinked before its name is released"
        );
        self.live_names -= 1;
        self.remove(id);
        self.clear_name(id);
        true
    }

    /// Whether the arenas carry enough garbage to make compaction pay off.
    pub fn should_compact(&self) -> bool {
        let total = self.raw.len() + self.folded.len();
        total > COMPACT_MIN_BYTES && self.garbage * COMPACT_GARBAGE_FACTOR > total as u64
    }

    /// Copies live names into a dense renumbering without touching the store.
    ///
    /// The caller applies the plan with [`NameStore::install_compacted`] while
    /// it holds the only writer; between the two calls the store must not be
    /// mutated.
    pub fn plan_compact(&self) -> CompactPlan {
        let mut plan = CompactPlan {
            raw: Vec::with_capacity(self.raw.len()),
            folded: Vec::with_capacity(self.folded.len()),
            pairs: Vec::with_capacity(self.live_names),
            refcount: Vec::with_capacity(self.live_names),
            head: Vec::with_capacity(self.live_names),
            remap: vec![DEAD; self.pairs.len()],
        };
        for (index, pair) in self.pairs.iter().copied().enumerate() {
            if self.refcount[index] == 0 {
                continue;
            }
            let new_id =
                u32::try_from(plan.pairs.len()).expect("compacted name id exceeds 32 bits");
            let folded = Self::slice(&self.folded, pair.folded);
            let folded_off = Self::append(&mut plan.folded, folded);
            let raw = if pair.raw.in_folded() {
                NameRef::shared(folded_off, pair.raw.len())
            } else {
                let raw_off = Self::append(&mut plan.raw, Self::slice(&self.raw, pair.raw));
                NameRef::new(raw_off, pair.raw.len())
            };
            plan.pairs.push(NamePair {
                raw,
                folded: NameRef::new(folded_off, pair.folded.len()),
            });
            plan.refcount.push(self.refcount[index]);
            plan.head.push(self.head[index]);
            plan.remap[index] = new_id;
        }
        plan
    }

    /// Installs a compaction plan and renumbers the entry table's name column.
    ///
    /// Tombstoned slots own no name any more, so their name column becomes
    /// [`NO_NAME`]; [`EntryTable::alloc`] rewrites it on reuse.
    pub fn install_compacted(&mut self, plan: CompactPlan, table: &mut EntryTable) {
        let CompactPlan {
            raw,
            folded,
            pairs,
            refcount,
            head,
            remap,
        } = plan;
        self.raw = raw;
        self.folded = folded;
        self.pairs = pairs;
        self.refcount = refcount;
        self.head = head;
        self.garbage = 0;
        self.live_names = self.refcount.len();
        self.table =
            NameTable::with_min_slots((self.live_names * LOAD_DENOMINATOR / LOAD_NUMERATOR).max(1));
        for index in 0..self.pairs.len() {
            let id = NameId::new(u32::try_from(index).expect("name id exceeds 32 bits"));
            let hash = NameTable::hash(self.raw_bytes(id));
            self.insert_unique(hash, id);
        }
        for slot in 0..table.allocated() {
            let entry = EntryId::new(u32::try_from(slot).expect("entry id exceeds 32 bits"));
            if table.is_tombstone(entry) {
                table.set_name(entry, NO_NAME);
                continue;
            }
            let old = table.name_id(entry);
            let new = remap[old.index()];
            debug_assert_ne!(new, DEAD, "live entry points at a released name");
            table.set_name(entry, NameId::new(new));
        }
    }

    /// Appends one NUL-terminated name to `arena` and returns its offset.
    fn append(arena: &mut Vec<u8>, bytes: &[u8]) -> u32 {
        let offset = arena.len();
        assert!(
            offset <= NameRef::MAX_OFFSET as usize,
            "name arena exceeds 2 GiB"
        );
        arena.extend_from_slice(bytes);
        arena.push(0);
        offset as u32
    }

    /// Slices one arena by reference.
    fn slice(arena: &[u8], name: NameRef) -> &[u8] {
        let start = name.offset() as usize;
        &arena[start..start + name.len() as usize]
    }

    /// Finds an existing name by raw bytes.
    fn find(&self, bytes: &[u8]) -> Option<NameId> {
        let hash = NameTable::hash(bytes);
        let mask = self.table.control.len() - 1;
        let mut index = hash as usize & mask;
        loop {
            match self.table.control[index] {
                SLOT_EMPTY => return None,
                SLOT_FULL => {
                    let id = NameId::new(self.table.slots[index]);
                    if self.raw_bytes(id) == bytes {
                        return Some(id);
                    }
                }
                _ => {}
            }
            index = (index + 1) & mask;
        }
    }

    /// Inserts a name that is not in the table yet, growing or rehashing first
    /// when the load factor or tombstone count demands it.
    fn insert_unique(&mut self, hash: u64, id: NameId) {
        if (self.table.used + 1) * LOAD_DENOMINATOR > self.table.control.len() * LOAD_NUMERATOR {
            let min_slots = if (self.table.len + 1) * LOAD_DENOMINATOR
                <= self.table.control.len() * LOAD_NUMERATOR
            {
                self.table.control.len()
            } else {
                self.table.control.len() * 2
            };
            self.rehash(min_slots);
        }
        let mask = self.table.control.len() - 1;
        let mut index = hash as usize & mask;
        let mut reused = usize::MAX;
        while self.table.control[index] != SLOT_EMPTY {
            if self.table.control[index] == SLOT_DEAD && reused == usize::MAX {
                reused = index;
            }
            index = (index + 1) & mask;
        }
        let slot = if reused == usize::MAX {
            self.table.used += 1;
            index
        } else {
            reused
        };
        self.table.control[slot] = SLOT_FULL;
        self.table.slots[slot] = id.get();
        self.table.len += 1;
    }

    /// Rebuilds the dedup table at no fewer than `min_slots` slots.
    fn rehash(&mut self, min_slots: usize) {
        let mut table = NameTable::with_min_slots(min_slots);
        let mask = table.control.len() - 1;
        for index in 0..self.table.control.len() {
            if self.table.control[index] != SLOT_FULL {
                continue;
            }
            let id = NameId::new(self.table.slots[index]);
            let hash = NameTable::hash(self.raw_bytes(id));
            let mut slot = hash as usize & mask;
            while table.control[slot] != SLOT_EMPTY {
                slot = (slot + 1) & mask;
            }
            table.control[slot] = SLOT_FULL;
            table.slots[slot] = id.get();
            table.len += 1;
            table.used += 1;
        }
        self.table = table;
    }

    /// Removes a name from the dedup table, leaving a tombstone.
    fn remove(&mut self, id: NameId) {
        let hash = NameTable::hash(self.raw_bytes(id));
        let mask = self.table.control.len() - 1;
        let mut index = hash as usize & mask;
        loop {
            match self.table.control[index] {
                SLOT_EMPTY => {
                    debug_assert!(false, "released name is missing from the dedup table");
                    return;
                }
                SLOT_FULL if self.table.slots[index] == id.get() => {
                    self.table.control[index] = SLOT_DEAD;
                    self.table.len -= 1;
                    return;
                }
                _ => {}
            }
            index = (index + 1) & mask;
        }
    }

    /// Zeroes the bytes of a dead name and accounts for them.
    fn clear_name(&mut self, id: NameId) {
        let pair = self.pairs[id.index()];
        let folded = pair.folded;
        let start = folded.offset() as usize;
        self.folded[start..start + folded.len() as usize].fill(0);
        self.garbage += u64::from(folded.len()) + 1;
        if !pair.raw.in_folded() {
            let raw = pair.raw;
            let start = raw.offset() as usize;
            self.raw[start..start + raw.len() as usize].fill(0);
            self.garbage += u64::from(raw.len()) + 1;
        }
    }
}

/// A dense renumbering of the live names, ready to install.
pub struct CompactPlan {
    raw: Vec<u8>,
    folded: Vec<u8>,
    pairs: Vec<NamePair>,
    refcount: Vec<u32>,
    head: Vec<EntryId>,
    remap: Vec<u32>,
}

impl CompactPlan {
    /// Number of names the compacted store will hold.
    pub fn compacted_names(&self) -> usize {
        self.pairs.len()
    }

    /// Raw arena of the compacted store.
    pub fn raw_arena(&self) -> &[u8] {
        &self.raw
    }

    /// Folded arena of the compacted store.
    pub fn folded_arena(&self) -> &[u8] {
        &self.folded
    }

    /// New id of an old id, or `None` when compaction dropped the name.
    pub fn remap(&self, old: NameId) -> Option<NameId> {
        match self.remap.get(old.index()).copied() {
            Some(new) if new != DEAD => Some(NameId::new(new)),
            _ => None,
        }
    }
}
