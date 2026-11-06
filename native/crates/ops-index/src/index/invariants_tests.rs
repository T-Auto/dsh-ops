//! Test-only invariant checkers for the volume policy layer.
//!
//! The model-based operations assume five structural invariants: the directory
//! scope index, the child chains, the same-name chains, the name refcounts, and
//! the folded-name order. Checking them against a full rebuild after every
//! mutation keeps the incremental maintenance honest. They live here, not in
//! the production modules, because they are test support only.

use crate::ids::{EntryId, NameId};
use crate::index::volume::VolumeIndex;

/// Every live entry with a parent appears exactly once in that parent's child
/// chain, and chains contain nothing else.
pub(crate) fn child_chains_match_rebuild(index: &VolumeIndex) -> bool {
    use crate::index::entry::EntryFlags;
    use std::collections::{HashMap, HashSet};
    let entries = index.entries();
    let mut expected: HashMap<EntryId, HashSet<EntryId>> = HashMap::new();
    for entry in entries.live_entries() {
        let parent = entries.parent(entry);
        if !parent.is_nil() && !entries.flags(entry).contains(EntryFlags::CHAIN_DETACHED) {
            expected.entry(parent).or_default().insert(entry);
        }
    }
    for parent in entries.live_entries() {
        let mut seen: HashSet<EntryId> = HashSet::new();
        let mut current = entries.first_child(parent);
        while !current.is_nil() {
            if entries.parent(current) != parent || !seen.insert(current) {
                return false;
            }
            current = entries.next_child(current);
        }
        if seen != expected.remove(&parent).unwrap_or_default() {
            return false;
        }
    }
    expected.is_empty()
}

/// Walking every name's chain visits exactly the live entries bearing that
/// name, each once.
pub(crate) fn name_chains_match_rebuild(index: &VolumeIndex) -> bool {
    use std::collections::{HashMap, HashSet};
    let mut expected: HashMap<NameId, HashSet<EntryId>> = HashMap::new();
    for entry in index.entries().live_entries() {
        expected
            .entry(index.entries().name_id(entry))
            .or_default()
            .insert(entry);
    }
    for id in index.names().name_ids() {
        let mut seen: HashSet<EntryId> = HashSet::new();
        let mut current = index.names().same_head(id);
        while !current.is_nil() {
            if !seen.insert(current) {
                return false;
            }
            current = index.entries().next_same(current);
        }
        if seen != expected.remove(&id).unwrap_or_default() {
            return false;
        }
    }
    expected.is_empty()
}

/// Every name's refcount equals its same-name chain length.
pub(crate) fn name_refcounts_match_chains(index: &VolumeIndex) -> bool {
    index.names().name_ids().all(|id| {
        let mut length = 0usize;
        let mut current = index.names().same_head(id);
        while !current.is_nil() {
            length += 1;
            current = index.entries().next_same(current);
        }
        index.names().refcount(id) as usize == length
    })
}

/// The incrementally maintained directory scope index equals a rebuild.
pub(crate) fn dir_index_matches_rebuild(index: &VolumeIndex) -> bool {
    use crate::index::entry::EntryFlags;
    use crate::index::scope::scope_key_hash;
    use std::collections::HashMap;
    let entries = index.entries();
    let mut expected: HashMap<(EntryId, u64), Vec<EntryId>> = HashMap::new();
    for entry in entries.live_entries() {
        let flags = entries.flags(entry);
        if !flags.contains(EntryFlags::DIR)
            || flags.contains(EntryFlags::PLACEHOLDER)
            || entry == index.root()
            || entry == index.lost_found()
        {
            continue;
        }
        let key = (
            entries.parent(entry),
            scope_key_hash(index.folded_name(entry)),
        );
        expected.entry(key).or_default().push(entry);
    }
    if expected.len() != index.dir_children.len() {
        return false;
    }
    expected.iter().all(|(key, want)| {
        index.dir_children.get(key).is_some_and(|found| {
            let mut want = want.clone();
            let mut found = found.clone();
            want.sort_unstable();
            found.sort_unstable();
            want == found
        })
    })
}

/// The folded-name order equals a rebuild: sorted by (folded bytes, id), every
/// live id exactly once, and each rank equal to its group's first position.
pub(crate) fn name_order_matches_rebuild(index: &VolumeIndex) -> bool {
    let names = index.names();
    let key = |id: NameId| (names.folded_bytes(id), id);
    let live: Vec<NameId> = index
        .name_order()
        .iter()
        .copied()
        .filter(|&id| names.is_live(id))
        .collect();
    if !live.windows(2).all(|pair| key(pair[0]) < key(pair[1])) {
        return false;
    }
    let mut seen: Vec<NameId> = live
        .iter()
        .copied()
        .chain(
            index
                .name_unranked()
                .iter()
                .copied()
                .filter(|&id| names.is_live(id)),
        )
        .collect();
    let count = seen.len();
    seen.sort_unstable();
    seen.dedup();
    if seen.len() != count {
        return false;
    }
    let want: Vec<NameId> = names.name_ids().filter(|&id| names.is_live(id)).collect();
    if seen != want {
        return false;
    }
    let mut group_start = 0usize;
    let mut previous: Option<&[u8]> = None;
    for (position, &id) in index.name_order().iter().enumerate() {
        if !names.is_live(id) {
            continue;
        }
        let folded = names.folded_bytes(id);
        if previous != Some(folded) {
            group_start = position;
            previous = Some(folded);
        }
        let rank = (index.name_rank_key(id) - 1) / 2;
        if rank as usize != group_start {
            return false;
        }
    }
    index
        .name_unranked()
        .iter()
        .all(|&id| !index.name_is_ranked(id))
}
