// Design informed by mustafaahci/goz (MIT).
//! Persistent directory-scope index.
//!
//! Resolving a query scope component by component must not scan the volume.
//! This module keeps a `(parent entry, hash of folded name) -> directories` map,
//! maintained on every mutation, so `child_dir` is a hash lookup plus one exact
//! folded-name comparison per candidate. Hash collisions are handled by keeping
//! every candidate under a key and comparing the real bytes, so a collision
//! costs one extra compare and can never resolve to the wrong directory.
//!
//! Only real directories are indexed: files, placeholders, the root and
//! lost-and-found are never a scope component. The price is proportional to the
//! directory count (~10x rarer than files), not to the entry count.

use crate::ids::EntryId;
use crate::index::entry::EntryFlags;
use crate::index::volume::VolumeIndex;

/// FNV-1a over a folded name. Insert, remove and lookup all use this one
/// function; drift between them would silently drop directories from scopes.
pub(crate) fn scope_key_hash(folded: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for &byte in folded {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

impl VolumeIndex {
    /// Records a real directory's current `(parent, folded name) -> entry`.
    ///
    /// No-op for files, placeholders, root and lost-and-found. Reads the
    /// entry's CURRENT fields, so call it after the parent/name/flags are set.
    pub(crate) fn dir_index_insert(&mut self, entry: EntryId) {
        let flags = self.entries.flags(entry);
        if !flags.contains(EntryFlags::DIR)
            || flags.contains(EntryFlags::PLACEHOLDER)
            || entry == self.root
            || entry == self.lost_found
        {
            return;
        }
        let key = (
            self.entries.parent(entry),
            scope_key_hash(self.folded_name(entry)),
        );
        let candidates = self.dir_children.entry(key).or_default();
        if !candidates.contains(&entry) {
            candidates.push(entry);
        }
    }

    /// Removes a directory's current key. Call BEFORE a rename or tombstone
    /// overwrites its parent/name (it reads them), and only for directories.
    pub(crate) fn dir_index_remove(&mut self, entry: EntryId) {
        if !self.entries.flags(entry).contains(EntryFlags::DIR) {
            return;
        }
        let key = (
            self.entries.parent(entry),
            scope_key_hash(self.folded_name(entry)),
        );
        if let Some(candidates) = self.dir_children.get_mut(&key) {
            candidates.retain(|&candidate| candidate != entry);
            if candidates.is_empty() {
                self.dir_children.remove(&key);
            }
        }
    }

    /// Looks up a child directory by its folded name: O(1) plus one compare.
    pub fn child_dir(&self, parent: EntryId, folded_name: &[u8]) -> Option<EntryId> {
        let key = (parent, scope_key_hash(folded_name));
        let candidates = self.dir_children.get(&key)?;
        candidates.iter().copied().find(|&directory| {
            !self
                .entries
                .flags(directory)
                .contains(EntryFlags::CHAIN_DETACHED)
                && self.folded_name(directory) == folded_name
        })
    }

    /// Depth-first walk of every live entry strictly under `root` (the root
    /// itself is not yielded). Backtracks through parent pointers, so the walk
    /// needs no explicit stack.
    pub fn subtree_entries(&self, root: EntryId) -> SubtreeWalk<'_> {
        SubtreeWalk {
            entries: &self.entries,
            root,
            current: self.entries.first_child(root),
        }
    }
}

/// Depth-first iterator over a directory's live descendants.
pub struct SubtreeWalk<'a> {
    entries: &'a crate::index::entry::EntryTable,
    root: EntryId,
    current: EntryId,
}

impl Iterator for SubtreeWalk<'_> {
    type Item = EntryId;

    fn next(&mut self) -> Option<EntryId> {
        if self.current.is_nil() {
            return None;
        }
        let yielded = self.current;
        let child = self.entries.first_child(yielded);
        if !child.is_nil() {
            self.current = child;
        } else {
            let mut at = yielded;
            loop {
                let sibling = self.entries.next_child(at);
                if !sibling.is_nil() {
                    self.current = sibling;
                    break;
                }
                at = self.entries.parent(at);
                if at == self.root || at.is_nil() {
                    self.current = EntryId::NIL;
                    break;
                }
            }
        }
        Some(yielded)
    }
}

#[cfg(test)]
#[path = "scope_tests.rs"]
mod scope_tests;
