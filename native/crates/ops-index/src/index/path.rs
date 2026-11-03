// Design informed by mustafaahci/goz (MIT).
//! Path reconstruction and read access for one volume.
//!
//! Paths are never stored: an entry keeps only its parent id, so renaming a
//! directory with ten thousand children touches exactly one entry and every
//! descendant's path is correct on the next reconstruction. [`VolumeIndex::path_of`]
//! walks parent links into a small stack buffer and emits the components
//! top-down, skipping the root, with `/` as the platform-neutral separator (the
//! Windows producer renders its own display form).
//!
//! The reference has a window where a child survives its parent's deletion and
//! its now-stale parent pointer is followed into a tombstoned slot, producing a
//! wrong path that still reported `Ok`. Here that walk is refused: a tombstoned
//! or chain-detached link anywhere up the chain returns [`PathStatus::Stale`],
//! never a path built from a dead name.

use crate::ids::{EntryId, RecordId};
use crate::index::entry::{EntryFlags, EntryView};
use crate::index::volume::VolumeIndex;

/// Maximum parent hops before a path is declared cyclic.
pub const MAX_PATH_HOPS: usize = 4096;

/// How a parent walk terminated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathStatus {
    /// A normal path rooted at the volume root.
    Ok,
    /// The chain terminates in lost-and-found (an unresolved orphan).
    InLostFound,
    /// The chain crosses a tombstoned or detached link: the entry has no
    /// trustworthy path.
    Stale,
    /// The hop cap was hit: corrupt or raced parent links; the volume should
    /// rescan rather than trust this path.
    CycleDetected,
}

impl VolumeIndex {
    /// Appends `dir/dir/name` for `entry` to `out` as WTF-8 and reports how the
    /// walk terminated. `out` is appended to, not cleared; no separator is
    /// inserted between the existing content and the first component.
    pub fn path_of(&self, entry: EntryId, out: &mut Vec<u8>) -> PathStatus {
        let mut chain: Vec<EntryId> = Vec::with_capacity(16);
        let mut current = entry;
        for _ in 0..MAX_PATH_HOPS {
            chain.push(current);
            let parent = self.entries.parent(current);
            if parent.is_nil() {
                break;
            }
            current = parent;
        }
        let top = *chain
            .last()
            .expect("path walk always pushes the starting entry");
        if !self.entries.parent(top).is_nil() {
            return PathStatus::CycleDetected;
        }
        for &node in &chain {
            if self.entries.is_tombstone(node)
                || self
                    .entries
                    .flags(node)
                    .contains(EntryFlags::CHAIN_DETACHED)
            {
                return PathStatus::Stale;
            }
        }
        let mut first_component = true;
        for &node in chain.iter().rev() {
            if node == self.root {
                continue;
            }
            if !first_component {
                out.push(b'/');
            }
            first_component = false;
            out.extend_from_slice(self.names.raw_bytes(self.entries.name_id(node)));
        }
        if top == self.lost_found {
            PathStatus::InLostFound
        } else {
            PathStatus::Ok
        }
    }

    /// Chain-head entry for a record, if present and not stale.
    pub fn head_of(&self, record: RecordId) -> Option<EntryId> {
        let head = self.by_record.get(record.record_number())?;
        (self.entries.record(head) == record).then_some(head)
    }

    /// The entry if it is live and still the one holding `record`.
    ///
    /// A query page that was scanned before a journal apply can hold ids whose
    /// slots were reused; `None` means the row is gone and must be dropped.
    pub fn entry_if_record(&self, entry: EntryId, record: RecordId) -> Option<EntryView> {
        self.entries
            .get(entry)
            .filter(|view| view.record() == record)
    }

    /// Read access to a live entry, or `None` for a dead/out-of-range id.
    pub fn entry(&self, entry: EntryId) -> Option<EntryView> {
        self.entries.get(entry)
    }

    /// This entry's folded name (precomputed, shared with every entry bearing
    /// the same name).
    pub fn folded_name(&self, entry: EntryId) -> &[u8] {
        self.names.folded_bytes(self.entries.name_id(entry))
    }

    /// Every live entry id (root, lost-and-found, and placeholders included).
    pub fn live_entries(&self) -> impl Iterator<Item = EntryId> + '_ {
        self.entries.live_entries()
    }

    /// `true` for the root, lost-and-found, and any placeholder: entries that do
    /// not describe a fully resolved file-system object.
    pub fn is_synthetic(&self, entry: EntryId) -> bool {
        let flags = self.entries.flags(entry);
        entry == self.root
            || entry == self.lost_found
            || flags.contains(EntryFlags::PLACEHOLDER)
            || flags.contains(EntryFlags::LOST_FOUND)
    }

    /// Whether the entry can appear as a normal query hit: it is not
    /// synthetic, it is not tombstoned or chain-detached, and its whole parent
    /// chain reaches the volume root (an orphan under lost-and-found is not
    /// presentable, even though the orphan entry itself is a normal entry).
    pub fn is_presentable(&self, entry: EntryId) -> bool {
        if self.is_synthetic(entry) {
            return false;
        }
        let Some(view) = self.entries.get(entry) else {
            return false;
        };
        if !view.is_presentable() {
            return false;
        }
        let mut current = entry;
        for _ in 0..MAX_PATH_HOPS {
            if current == self.root {
                return true;
            }
            if current == self.lost_found {
                return false;
            }
            let parent = self.entries.parent(current);
            if parent.is_nil() {
                return false;
            }
            if self.entries.is_tombstone(parent)
                || self
                    .entries
                    .flags(parent)
                    .contains(EntryFlags::CHAIN_DETACHED)
            {
                return false;
            }
            current = parent;
        }
        false
    }

    /// Collects every real entry's reconstructed path as a lossy `String`
    /// (test and diagnostics helper; orphans are excluded).
    pub fn collect_real_paths(&self) -> Vec<String> {
        let mut paths = Vec::new();
        let mut buffer = Vec::new();
        for entry in self.live_entries() {
            if self.is_synthetic(entry) {
                continue;
            }
            buffer.clear();
            if self.path_of(entry, &mut buffer) == PathStatus::Ok {
                paths.push(crate::wtf8::to_string_lossy(&buffer));
            }
        }
        paths
    }

    /// Test-only: forces a parent link so the defensive cycle guard can be
    /// exercised (the public API never produces a cycle).
    #[cfg(test)]
    pub fn force_parent(&mut self, entry: EntryId, parent: EntryId) {
        self.entries.set_parent(entry, parent);
    }

    /// Test-only: iterates the live entries sharing one interned name.
    #[cfg(test)]
    pub fn name_chain(&self, id: crate::ids::NameId) -> NameChain<'_> {
        NameChain {
            entries: &self.entries,
            current: self.names.same_head(id),
        }
    }

    /// Test-only invariant: every live child appears exactly once in its
    /// parent's child chain, and chains contain nothing else.
    #[cfg(test)]
    pub fn child_chains_match_rebuild(&self) -> bool {
        use std::collections::{HashMap, HashSet};
        let mut expected: HashMap<EntryId, HashSet<EntryId>> = HashMap::new();
        for entry in self.entries.live_entries() {
            let parent = self.entries.parent(entry);
            if !parent.is_nil()
                && !self
                    .entries
                    .flags(entry)
                    .contains(EntryFlags::CHAIN_DETACHED)
            {
                expected.entry(parent).or_default().insert(entry);
            }
        }
        for parent in self.entries.live_entries() {
            let mut seen: HashSet<EntryId> = HashSet::new();
            let mut current = self.entries.first_child(parent);
            while !current.is_nil() {
                if self.entries.parent(current) != parent || !seen.insert(current) {
                    return false;
                }
                current = self.entries.next_child(current);
            }
            if seen != expected.remove(&parent).unwrap_or_default() {
                return false;
            }
        }
        expected.is_empty()
    }

    /// Test-only invariant: walking every name's chain visits exactly the live
    /// entries bearing that name, each once.
    #[cfg(test)]
    pub fn name_chains_match_rebuild(&self) -> bool {
        use std::collections::{HashMap, HashSet};
        let mut expected: HashMap<crate::ids::NameId, HashSet<EntryId>> = HashMap::new();
        for entry in self.entries.live_entries() {
            expected
                .entry(self.entries.name_id(entry))
                .or_default()
                .insert(entry);
        }
        for id in self.names.name_ids() {
            let mut seen: HashSet<EntryId> = HashSet::new();
            for entry in self.name_chain(id) {
                if !seen.insert(entry) {
                    return false;
                }
            }
            if seen != expected.remove(&id).unwrap_or_default() {
                return false;
            }
        }
        expected.is_empty()
    }

    /// Test-only invariant: every name's refcount equals its chain length.
    #[cfg(test)]
    pub fn name_refcounts_match_chains(&self) -> bool {
        self.names
            .name_ids()
            .all(|id| self.names.refcount(id) as usize == self.name_chain(id).count())
    }
}

/// Iterator over one interned name's live entries.
#[cfg(test)]
pub struct NameChain<'a> {
    entries: &'a crate::index::entry::EntryTable,
    current: EntryId,
}

#[cfg(test)]
impl Iterator for NameChain<'_> {
    type Item = EntryId;

    fn next(&mut self) -> Option<EntryId> {
        if self.current.is_nil() {
            return None;
        }
        let entry = self.current;
        self.current = self.entries.next_same(entry);
        Some(entry)
    }
}

#[cfg(test)]
#[path = "path_tests.rs"]
mod path_tests;
