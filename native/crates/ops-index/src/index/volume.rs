// Design informed by mustafaahci/goz (MIT).
//! The per-volume index and the rules that mutate it.
//!
//! [`VolumeIndex`] owns the entry table, the interned names, the record map and
//! the name order, and applies USN operations and FILE_LAYOUT enrichment to
//! them. The invariants:
//!
//! - **Paths are never stored.** They are rebuilt from parent links, which is
//!   what makes a directory rename O(1) and every descendant path correct on
//!   the next reconstruction.
//! - **Every operation is idempotent.** USN reason bits accumulate per
//!   open/close window, so applying a batch twice equals applying it once.
//! - **Orphans are never dropped.** An unknown parent becomes a placeholder
//!   under lost-and-found, filled in by the parent's real record when it
//!   arrives.
//! - **Slot reuse can never alias.** The record map is keyed by record number
//!   and every hit is re-checked against the full record id (generation
//!   included); a mismatched chain is reclaimed before anything overwrites it.
//!
//! The reference implementation reached a stale chain through `enrich` without
//! reclaiming it (the map was overwritten, the old chain stayed live and
//! matchable). Here every entry point that may see a stale record number goes
//! through [`VolumeIndex::reclaim_if_stale`] first.
//!
//! No IO, no locks, no platform calls: a platform source hands in parsed
//! records and the caller serializes writers. Memory accounting and storage
//! shrinking are deliberately not part of this slice (they only observe the
//! structure; a later storage slice can add them without changing these rules).

use crate::ids::{EntryId, NameId, RecordId};
use crate::index::entry::{EntryFlags, EntryTable};
use crate::index::name::NameStore;
use crate::index::record_map::RecordMap;
use crate::index::storage::NameOrder;
use crate::layout::LayoutFile;
use crate::usn::{ParsedUsnRecord, UsnOp, ops_for};

use std::collections::HashMap;

/// Record id of the synthetic lost-and-found directory (never a USN target).
pub const LOST_FOUND_RECORD: RecordId = RecordId::new(u64::MAX);

/// Synthetic name of the lost-and-found root.
pub const LOST_FOUND_NAME: &[u8] = b"$LostFound";

/// Synthetic name a placeholder carries until its real record fills it in.
pub const PLACEHOLDER_NAME: &[u8] = b"$Placeholder";

/// Largest name this index accepts, in bytes.
///
/// Every file system this crate targets bounds one component far below this
/// (NTFS: 255 UTF-16 units, at most 510 WTF-8 bytes); the bound exists so a
/// corrupt page can never reach `NameStore::intern`, which rejects names whose
/// folded form would not fit its 16-bit length.
pub const MAX_NAME_BYTES: usize = 510;

const _: () = assert!(MAX_NAME_BYTES as u32 == crate::layout::MAX_NAME_BYTES);

/// A name plus whether it required WTF-8 (contained unpaired surrogates).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WtfName {
    /// Name bytes as WTF-8.
    pub bytes: Vec<u8>,
    /// The name contained unpaired UTF-16 surrogates.
    pub lossy: bool,
}

impl WtfName {
    /// Builds a name from its bytes and lossiness flag.
    pub fn new(bytes: Vec<u8>, lossy: bool) -> Self {
        Self { bytes, lossy }
    }
}

/// One resolved hard link: the containing directory plus the link name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkTarget {
    /// Directory entry that holds the link.
    pub parent: EntryId,
    /// Link name.
    pub name: WtfName,
}

/// A non-fatal irregularity observed during apply, counted for diagnostics.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Anomaly {
    /// A delete arrived for a record not in the index.
    DeleteOfUnknown {
        /// Dead record.
        record: RecordId,
    },
    /// An upsert carried a name above [`MAX_NAME_BYTES`]: the page is corrupt.
    OversizedName {
        /// Record the name belonged to.
        record: RecordId,
        /// Byte length of the rejected name.
        len: u64,
    },
}

/// Running counters for observability.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IndexStats {
    /// Placeholders synthesized for a parent that was not indexed yet.
    pub placeholders_created: u64,
    /// Deletes of a record not in the index.
    pub delete_of_unknown: u64,
    /// RENAME_OLD_NAME records without a matching NEW/CREATE/DELETE.
    pub rename_old_seen: u64,
    /// Record numbers reclaimed because a new generation took the slot.
    pub stale_slots: u64,
    /// Hard-link reconciles the caller reported as impossible.
    pub link_reconciles_dropped: u64,
    /// Names above [`MAX_NAME_BYTES`] rejected during bootstrap or apply.
    pub oversized_names: u64,
}

/// Side effects a batch produced that the caller must service out of band.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ApplyOutcome {
    /// Records whose size/mtime changed and need an external stat.
    pub needs_stat: Vec<RecordId>,
    /// Records whose hard links changed and need an external link-set walk.
    pub needs_link_reconcile: Vec<RecordId>,
    /// Irregularities worth logging.
    pub anomalies: Vec<Anomaly>,
    /// The name arenas are dirty enough to be worth compacting.
    pub wants_compact: bool,
}

enum UpsertResult {
    Ok,
    NeedsReconcile,
}

/// One indexed volume.
pub struct VolumeIndex {
    pub(crate) entries: EntryTable,
    pub(crate) names: NameStore,
    pub(crate) order: NameOrder,
    pub(crate) by_record: RecordMap,
    pub(crate) dir_children: HashMap<(EntryId, u64), Vec<EntryId>>,
    pub(crate) root: EntryId,
    pub(crate) lost_found: EntryId,
    /// Placeholders currently alive; zero means every entry reconstructs to a
    /// real path.
    pub(crate) live_placeholders: u64,
    pub(crate) generation: u64,
    pub(crate) stats: IndexStats,
    /// Structural mutations since the last `take_write_count`.
    pub(crate) dirty: u64,
}

impl VolumeIndex {
    /// Builds an empty index with a root (identified by `root_record`) and a
    /// synthetic lost-and-found directory.
    pub fn new(root_record: RecordId, mut by_record: RecordMap) -> Self {
        let mut entries = EntryTable::new();
        let mut names = NameStore::new();
        let mut order = NameOrder::new();

        let root_name = names.intern(b"");
        order.push_unranked(root_name);
        let root = entries.alloc(root_record, EntryId::NIL, root_name, EntryFlags::DIR);
        by_record.set(root_record.record_number(), root);

        let lost_found_name = names.intern(LOST_FOUND_NAME);
        order.push_unranked(lost_found_name);
        let lost_found = entries.alloc(
            LOST_FOUND_RECORD,
            EntryId::NIL,
            lost_found_name,
            EntryFlags::DIR.with(EntryFlags::LOST_FOUND, true),
        );

        let mut index = Self {
            entries,
            names,
            order,
            by_record,
            dir_children: HashMap::new(),
            root,
            lost_found,
            live_placeholders: 0,
            generation: 0,
            stats: IndexStats::default(),
            dirty: 0,
        };
        index.link_same_name(root, root_name);
        index.link_same_name(lost_found, lost_found_name);
        index
    }

    /// Whether any entry could fail to reconstruct to a real path.
    pub fn has_orphans(&self) -> bool {
        self.live_placeholders > 0
    }

    /// Root entry.
    pub fn root(&self) -> EntryId {
        self.root
    }

    /// Lost-and-found entry.
    pub fn lost_found(&self) -> EntryId {
        self.lost_found
    }

    /// Batch generation counter (increments once per [`Self::apply_batch`]).
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Counters.
    pub fn stats(&self) -> &IndexStats {
        &self.stats
    }

    /// Live entry count (root and lost-and-found included).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the index has no entry beyond the two synthetic roots.
    pub fn is_empty(&self) -> bool {
        self.len() <= 2
    }

    /// Allocated entry slots (live plus reusable tombstones).
    pub fn allocated(&self) -> usize {
        self.entries.allocated()
    }

    /// Structural mutations since the previous call (the directory-rename test
    /// asserts exactly one).
    pub fn take_write_count(&mut self) -> u64 {
        core::mem::take(&mut self.dirty)
    }

    /// Read access to the interned names (query layer, P7).
    pub fn names(&self) -> &NameStore {
        &self.names
    }

    /// Read access to the entry table (query layer, P7).
    pub fn entries(&self) -> &EntryTable {
        &self.entries
    }

    /// Test-only: mutable entry table so a test can force a corrupt shape.
    #[cfg(test)]
    pub fn entries_mut(&mut self) -> &mut EntryTable {
        &mut self.entries
    }

    /// Contiguous folded-name haystack for a whole-arena scan.
    pub fn folded_bytes(&self) -> &[u8] {
        self.names.folded()
    }

    // -- bootstrap ingestion ----------------------------------------------

    /// Ingests one `FSCTL_ENUM_USN_DATA` record (bootstrap). Idempotent.
    ///
    /// A name above [`MAX_NAME_BYTES`] is skipped: the caller validated the page,
    /// so this is defensive only (and must not reach the interner's panic).
    pub fn insert_enum(&mut self, record: &ParsedUsnRecord) {
        if record.name.len() > MAX_NAME_BYTES {
            self.stats.oversized_names += 1;
            return;
        }
        self.upsert_link(
            record.record,
            record.parent,
            &record.name,
            record.name_lossy,
            record.is_dir(),
        );
    }

    /// Applies FILE_LAYOUT enrichment: sets size/mtime and reconciles the
    /// file's hard-link names (dropping 8.3 DOS-only aliases).
    ///
    /// Add-only by contract: an existing entry is never tombstoned or replaced.
    /// During the bootstrap race a directory's current name may differ from the
    /// LAYOUT snapshot because a rename landed between the ENUM and LAYOUT
    /// passes; replacing it would orphan every child pointing at its slot.
    pub fn enrich(&mut self, file: &LayoutFile) {
        // The reference skipped this reclaim: a stale chain for the record
        // number stayed live after the map was overwritten, so its names kept
        // matching queries and its slots never returned to the free list.
        self.reclaim_if_stale(file.reference);

        let is_dir = file.is_dir();
        if self.head_of(file.reference).is_none() {
            let desired: Vec<LinkTarget> = file
                .names
                .iter()
                .filter(|name| !name.dos_only && name.name.len() <= MAX_NAME_BYTES)
                .map(|name| LinkTarget {
                    parent: self.resolve_or_placeholder_parent(name.parent),
                    name: WtfName::new(name.name.clone(), name.name_lossy),
                })
                .collect();
            if desired.is_empty() {
                return;
            }
            self.set_chain_links(file.reference, is_dir, &desired);
        }

        if !is_dir {
            for name in file
                .names
                .iter()
                .filter(|name| !name.dos_only && name.name.len() <= MAX_NAME_BYTES)
            {
                let parent = self.resolve_or_placeholder_parent(name.parent);
                if !self.chain_has_link(file.reference, parent, &name.name) {
                    self.add_link(file.reference, parent, &name.name, name.name_lossy);
                }
            }
        }

        // Set size/mtime on EVERY link: a query may return any of a file's
        // names and they describe the same bytes. Directories keep no size.
        if let Some(head) = self.head_of(file.reference) {
            let mut current = head;
            while !current.is_nil() {
                if !is_dir && let Some(size) = file.size {
                    self.entries.set_size(current, Some(size));
                }
                if let Some(mtime) = file.mtime_ft {
                    self.entries.set_mtime(current, Some(mtime));
                }
                current = self.entries.next_link(current);
            }
        }
    }

    /// Ingests one FILE_LAYOUT record when FILE_LAYOUT is the only bootstrap
    /// pass: the first real (non-8.3) name stands in for the ENUM record, so a
    /// directory an earlier child left as a placeholder gets its real name,
    /// then [`Self::enrich`] adds the other links, size and mtime. Idempotent.
    ///
    /// The root's own record names the root as its parent; taking that name
    /// would make the root its own parent and leave every entry pathless, so
    /// the root is only enriched.
    pub fn insert_layout(&mut self, file: &LayoutFile) {
        let is_dir = file.is_dir();
        if let Some(name) = file
            .names
            .iter()
            .find(|name| !name.dos_only && name.name.len() <= MAX_NAME_BYTES)
            .filter(|name| name.parent != file.reference)
        {
            self.upsert_link(
                file.reference,
                name.parent,
                &name.name,
                name.name_lossy,
                is_dir,
            );
        }
        self.enrich(file);
    }

    // -- live apply -------------------------------------------------------

    /// Applies a batch of journal records, returning the side effects the
    /// caller must service. Bumps the generation once per batch.
    pub fn apply_batch(&mut self, records: &[ParsedUsnRecord]) -> ApplyOutcome {
        let mut outcome = ApplyOutcome::default();
        for record in records {
            for op in ops_for(record) {
                match op {
                    UsnOp::Upsert {
                        record,
                        parent,
                        name,
                        name_lossy,
                        is_dir,
                    } => {
                        if name.len() > MAX_NAME_BYTES {
                            self.stats.oversized_names += 1;
                            outcome.anomalies.push(Anomaly::OversizedName {
                                record,
                                len: name.len() as u64,
                            });
                            continue;
                        }
                        if matches!(
                            self.upsert_link(record, parent, name, name_lossy, is_dir),
                            UpsertResult::NeedsReconcile
                        ) {
                            outcome.needs_link_reconcile.push(record);
                        }
                    }
                    UsnOp::Delete { record } => {
                        if !self.delete_record(record) {
                            self.stats.delete_of_unknown += 1;
                            outcome.anomalies.push(Anomaly::DeleteOfUnknown { record });
                        }
                    }
                    UsnOp::LinkDirty { record } => outcome.needs_link_reconcile.push(record),
                    UsnOp::StatDirty { record } => outcome.needs_stat.push(record),
                    UsnOp::RenameOldSeen { .. } => self.stats.rename_old_seen += 1,
                }
            }
        }
        if self.order.wants_merge() {
            self.order.merge_unranked(&self.names);
        }
        self.generation += 1;
        // Compaction is reported, never done inline: the caller plans it off
        // the write lock and applies it under it.
        outcome.wants_compact = self.names.should_compact();
        outcome
    }

    /// Records that `count` hard-link walks could not complete.
    pub fn note_link_reconciles_dropped(&mut self, count: u64) {
        self.stats.link_reconciles_dropped += count;
    }

    /// Reconciles the hard-link set of `record` to exactly `actual`. An empty
    /// `actual` deletes the file.
    pub fn reconcile_links(&mut self, record: RecordId, actual: &[LinkTarget]) {
        if actual.is_empty() {
            self.delete_record(record);
            return;
        }
        let is_dir = self
            .head_of(record)
            .map(|head| self.entries.flags(head).contains(EntryFlags::DIR))
            .unwrap_or(false);
        self.set_chain_links(record, is_dir, actual);
    }

    /// Sets a file's fresh size/mtime on every entry in its link chain.
    /// Directories keep unknown size (mtime only). A no-op for unknown records.
    pub fn set_stat(&mut self, record: RecordId, size: u64, mtime: i64) {
        let Some(head) = self.head_of(record) else {
            return;
        };
        let is_dir = self.entries.flags(head).contains(EntryFlags::DIR);
        let mut current = head;
        while !current.is_nil() {
            if !is_dir {
                self.entries.set_size(current, Some(size));
            }
            self.entries.set_mtime(current, Some(mtime));
            current = self.entries.next_link(current);
        }
    }

    // -- internals --------------------------------------------------------

    /// Interns `bytes` and registers a new id in the name order.
    fn intern_name(&mut self, bytes: &[u8]) -> NameId {
        let before = self.names.slot_count();
        let id = self.names.intern(bytes);
        if self.names.slot_count() > before {
            self.order.push_unranked(id);
        }
        id
    }

    /// Releases one name reference, noting the death for the merge trigger.
    fn release_name(&mut self, id: NameId) {
        self.order.note_released(id);
        self.names.release(id);
    }

    /// Pushes `entry` onto the front of `id`'s same-name chain.
    fn link_same_name(&mut self, entry: EntryId, id: NameId) {
        self.names.link_same(id, entry, &mut self.entries);
    }

    /// Removes `entry` from its same-name chain. Must run before its name id is
    /// overwritten or its slot tombstoned.
    fn unlink_same_name(&mut self, entry: EntryId) {
        let id = self.entries.name_id(entry);
        self.names.unlink_same(id, entry, &mut self.entries);
    }

    /// Pushes `entry` onto the front of its parent's child chain.
    fn link_child(&mut self, entry: EntryId) {
        let parent = self.entries.parent(entry);
        if parent.is_nil() {
            return;
        }
        let old_head = self.entries.first_child(parent);
        self.entries.set_next_child(entry, old_head);
        self.entries.set_prev_child(entry, EntryId::NIL);
        if !old_head.is_nil() {
            self.entries.set_prev_child(old_head, entry);
        }
        self.entries.set_first_child(parent, entry);
        let flags = self.entries.flags(entry);
        if flags.contains(EntryFlags::CHAIN_DETACHED) {
            self.entries
                .set_flags(entry, flags.with(EntryFlags::CHAIN_DETACHED, false));
        }
    }

    /// O(1) removal from the parent's child chain.
    fn unlink_child(&mut self, entry: EntryId) {
        let parent = self.entries.parent(entry);
        if parent.is_nil() {
            return;
        }
        if self
            .entries
            .flags(entry)
            .contains(EntryFlags::CHAIN_DETACHED)
        {
            return;
        }
        let previous = self.entries.prev_child(entry);
        let next = self.entries.next_child(entry);
        if previous.is_nil() {
            self.entries.set_first_child(parent, next);
        } else {
            self.entries.set_next_child(previous, next);
        }
        if !next.is_nil() {
            self.entries.set_prev_child(next, previous);
        }
        self.entries.set_next_child(entry, EntryId::NIL);
        self.entries.set_prev_child(entry, EntryId::NIL);
    }

    /// Detaches every chained child of a directory that is about to be
    /// tombstoned with children still live (a missed delete followed by slot
    /// reuse). The children keep their dangling parent pointer but leave the
    /// chain world, so no later mutation can cross-link a reused slot.
    fn sever_children(&mut self, directory: EntryId) {
        let mut current = self.entries.first_child(directory);
        while !current.is_nil() {
            let next = self.entries.next_child(current);
            self.entries.set_next_child(current, EntryId::NIL);
            self.entries.set_prev_child(current, EntryId::NIL);
            let flags = self.entries.flags(current);
            self.entries
                .set_flags(current, flags.with(EntryFlags::CHAIN_DETACHED, true));
            current = next;
        }
        self.entries.set_first_child(directory, EntryId::NIL);
    }

    /// Reclaims a record number whose live chain belongs to another generation.
    fn reclaim_stale_slot(&mut self, record: RecordId, head: EntryId) {
        self.tombstone_chain(head);
        self.by_record.remove(record.record_number());
        self.stats.stale_slots += 1;
    }

    /// Reclaims the record's chain when the map holds a different generation.
    ///
    /// Every entry point that may find a live map entry must call this before
    /// overwriting the map; it exists as one function so the sites cannot
    /// drift apart.
    fn reclaim_if_stale(&mut self, record: RecordId) {
        let existing = self.by_record.get(record.record_number());
        if let Some(head) = existing
            && self.entries.record(head) != record
        {
            self.reclaim_stale_slot(record, head);
        }
    }

    fn upsert_link(
        &mut self,
        record: RecordId,
        parent: RecordId,
        name: &[u8],
        name_lossy: bool,
        is_dir: bool,
    ) -> UpsertResult {
        self.reclaim_if_stale(record);
        let parent = self.resolve_or_placeholder_parent(parent);

        let existing = self.by_record.get(record.record_number());
        if let Some(head) = existing.filter(|&head| self.entries.record(head) == record) {
            if self.entries.next_link(head).is_nil() {
                self.rewrite_entry(head, parent, name, name_lossy, is_dir);
                return UpsertResult::Ok;
            }
            return UpsertResult::NeedsReconcile;
        }

        let id = self.intern_name(name);
        let flags = EntryFlags::EMPTY
            .with(EntryFlags::DIR, is_dir)
            .with(EntryFlags::NON_UNICODE_NAME, name_lossy);
        let entry = self.entries.alloc(record, parent, id, flags);
        self.link_same_name(entry, id);
        self.link_child(entry);
        self.by_record.set(record.record_number(), entry);
        self.dir_index_insert(entry);
        self.dirty += 1;
        UpsertResult::Ok
    }

    fn rewrite_entry(
        &mut self,
        entry: EntryId,
        parent: EntryId,
        name: &[u8],
        name_lossy: bool,
        is_dir: bool,
    ) {
        self.dir_index_remove(entry);
        self.unlink_same_name(entry);
        self.release_name(self.entries.name_id(entry));
        let id = self.intern_name(name);
        self.entries.set_name(entry, id);
        self.link_same_name(entry, id);
        self.unlink_child(entry);
        self.entries.set_parent(entry, parent);
        self.link_child(entry);
        let was_placeholder = self.entries.flags(entry).contains(EntryFlags::PLACEHOLDER);
        let flags = self
            .entries
            .flags(entry)
            .with(EntryFlags::DIR, is_dir)
            .with(EntryFlags::NON_UNICODE_NAME, name_lossy)
            .with(EntryFlags::PLACEHOLDER, false);
        self.entries.set_flags(entry, flags);
        if was_placeholder {
            self.live_placeholders = self.live_placeholders.saturating_sub(1);
        }
        self.dir_index_insert(entry);
        self.dirty += 1;
    }

    /// Resolves a parent record to its entry, synthesizing a placeholder under
    /// lost-and-found if the parent has not been seen yet.
    fn resolve_or_placeholder_parent(&mut self, parent: RecordId) -> EntryId {
        let existing = self.by_record.get(parent.record_number());
        if let Some(entry) = existing.filter(|&entry| self.entries.record(entry) == parent) {
            return entry;
        }
        self.reclaim_if_stale(parent);
        let id = self.intern_name(PLACEHOLDER_NAME);
        let entry = self.entries.alloc(
            parent,
            self.lost_found,
            id,
            EntryFlags::DIR.with(EntryFlags::PLACEHOLDER, true),
        );
        self.link_same_name(entry, id);
        self.link_child(entry);
        self.by_record.set(parent.record_number(), entry);
        self.stats.placeholders_created += 1;
        self.live_placeholders += 1;
        self.dirty += 1;
        entry
    }

    fn delete_record(&mut self, record: RecordId) -> bool {
        let existing = self.by_record.get(record.record_number());
        let Some(head) = existing else {
            return false;
        };
        if self.entries.record(head) != record {
            return false;
        }
        self.tombstone_chain(head);
        self.by_record.remove(record.record_number());
        true
    }

    fn tombstone_chain(&mut self, head: EntryId) {
        let mut current = head;
        while !current.is_nil() {
            let next = self.entries.next_link(current);
            if self
                .entries
                .flags(current)
                .contains(EntryFlags::PLACEHOLDER)
            {
                self.live_placeholders = self.live_placeholders.saturating_sub(1);
            }
            self.dir_index_remove(current);
            self.unlink_same_name(current);
            self.unlink_child(current);
            self.sever_children(current);
            self.release_name(self.entries.name_id(current));
            self.entries.tombstone(current);
            self.dirty += 1;
            current = next;
        }
    }

    /// Whether a link with this parent and name is already in the record's
    /// chain.
    fn chain_has_link(&self, record: RecordId, parent: EntryId, name: &[u8]) -> bool {
        let Some(head) = self.head_of(record) else {
            return false;
        };
        let mut current = head;
        while !current.is_nil() {
            if self.entries.parent(current) == parent
                && self.names.raw_bytes(self.entries.name_id(current)) == name
            {
                return true;
            }
            current = self.entries.next_link(current);
        }
        false
    }

    /// Appends a new hard-link name to the tail of the record's chain.
    fn add_link(&mut self, record: RecordId, parent: EntryId, name: &[u8], name_lossy: bool) {
        let id = self.intern_name(name);
        let flags = EntryFlags::EMPTY.with(EntryFlags::NON_UNICODE_NAME, name_lossy);
        let entry = self.entries.alloc(record, parent, id, flags);
        self.link_same_name(entry, id);
        self.link_child(entry);
        let existing = self.by_record.get(record.record_number());
        if let Some(head) = existing {
            let mut tail = head;
            while !self.entries.next_link(tail).is_nil() {
                tail = self.entries.next_link(tail);
            }
            self.entries.set_next_link(tail, entry);
        } else {
            self.by_record.set(record.record_number(), entry);
        }
        self.dirty += 1;
    }

    /// Makes the hard-link chain of `record` exactly `desired`, preserving the
    /// entries that already match by parent and name so their ids (and any
    /// children pointing at them) survive.
    fn set_chain_links(&mut self, record: RecordId, is_dir: bool, desired: &[LinkTarget]) {
        self.reclaim_if_stale(record);
        let key = record.record_number();
        let mut current: Vec<EntryId> = Vec::new();
        let existing = self.by_record.get(key);
        if let Some(head) = existing.filter(|&head| self.entries.record(head) == record) {
            let mut entry = head;
            while !entry.is_nil() {
                current.push(entry);
                entry = self.entries.next_link(entry);
            }
        }

        let mut kept: Vec<EntryId> = Vec::new();
        let mut used = vec![false; current.len()];
        for target in desired {
            let existing = current.iter().enumerate().position(|(position, &entry)| {
                !used[position]
                    && self.entries.parent(entry) == target.parent
                    && self.names.raw_bytes(self.entries.name_id(entry))
                        == target.name.bytes.as_slice()
            });
            if let Some(position) = existing {
                used[position] = true;
                kept.push(current[position]);
            } else {
                let id = self.intern_name(&target.name.bytes);
                let flags = EntryFlags::EMPTY
                    .with(EntryFlags::DIR, is_dir)
                    .with(EntryFlags::NON_UNICODE_NAME, target.name.lossy);
                let entry = self.entries.alloc(record, target.parent, id, flags);
                self.link_same_name(entry, id);
                self.link_child(entry);
                self.dir_index_insert(entry);
                kept.push(entry);
                self.dirty += 1;
            }
        }

        for (position, &entry) in current.iter().enumerate() {
            if !used[position] {
                if self.entries.flags(entry).contains(EntryFlags::PLACEHOLDER) {
                    self.live_placeholders = self.live_placeholders.saturating_sub(1);
                }
                self.dir_index_remove(entry);
                self.unlink_same_name(entry);
                self.unlink_child(entry);
                self.sever_children(entry);
                self.release_name(self.entries.name_id(entry));
                self.entries.tombstone(entry);
                self.dirty += 1;
            }
        }

        for (position, &entry) in kept.iter().enumerate() {
            let next = kept.get(position + 1).copied().unwrap_or(EntryId::NIL);
            self.entries.set_next_link(entry, next);
        }
        if let Some(&head) = kept.first() {
            self.by_record.set(key, head);
        }
    }
}

#[cfg(test)]
#[path = "volume_tests.rs"]
mod volume_tests;

#[cfg(test)]
#[path = "tape_tests.rs"]
mod tape_tests;
