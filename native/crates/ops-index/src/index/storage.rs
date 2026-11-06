// Design informed by mustafaahci/goz (MIT).
//! Name ordering, compaction, and storage maintenance for the volume layer.
//!
//! The query layer can sort hits by name without folding anything per hit, but
//! only if the index keeps names in folded order and assigns each name an
//! integer rank. This module owns that order: [`NameOrder`] keeps the sorted
//! live ids, an `unranked` waiting list for names interned since the last
//! merge, and a per-name rank that makes a name-sorted candidate comparable
//! with a single `u64`.
//!
//! Compaction is the same split the reference uses: [`VolumeIndex::plan_compaction`]
//! copies live names with `&self` (safe to run outside a write lock), and
//! [`VolumeIndex::apply_compaction`] installs the plan under the exclusive lock.
//! Applying also remaps the name order and re-ranks it, so the two structures
//! never disagree about which id is which.

use crate::ids::NameId;
use crate::index::name::{CompactPlan, NameStore};
use crate::index::volume::VolumeIndex;

/// Rank of a name that is not in the order (waiting for a merge, or dead).
pub const UNRANKED: u32 = u32::MAX;

/// Folded-name order with a rank per interned name.
#[derive(Default)]
pub struct NameOrder {
    /// Live ids in `(folded bytes, id)` order; dead ids may linger until the
    /// next merge or compaction.
    order: Vec<NameId>,
    /// Per-name rank: the position of the first live id of its folded group.
    rank_of: Vec<u32>,
    /// Ids interned since the last merge, in intern order.
    unranked: Vec<NameId>,
    /// Ranked ids that died since the last merge: they widen probes, so they
    /// count toward the merge trigger.
    dead_ranked: usize,
}

impl NameOrder {
    /// Builds an empty order.
    pub fn new() -> Self {
        Self::default()
    }

    /// Ids in folded-name order; dead ids may linger.
    pub fn order(&self) -> &[NameId] {
        &self.order
    }

    /// Ids waiting for the next merge, in intern order.
    pub fn unranked(&self) -> &[NameId] {
        &self.unranked
    }

    /// `(ranked slots, waiting names)`, for diagnostics.
    pub fn stats(&self) -> (usize, usize) {
        (self.order.len(), self.unranked.len())
    }

    /// Whether the name is in the sorted order.
    pub fn is_ranked(&self, id: NameId) -> bool {
        matches!(self.rank_of.get(id.index()), Some(&rank) if rank != UNRANKED)
    }

    /// The comparison key of a name: folded bytes, then id.
    fn key(names: &NameStore, id: NameId) -> (&[u8], NameId) {
        (names.folded_bytes(id), id)
    }

    /// Rank of a name, or [`UNRANKED`].
    pub fn rank(&self, id: NameId) -> u32 {
        self.rank_of.get(id.index()).copied().unwrap_or(UNRANKED)
    }

    /// Registers an id that was just interned.
    pub fn push_unranked(&mut self, id: NameId) {
        self.unranked.push(id);
        if id.index() >= self.rank_of.len() {
            self.rank_of.resize(id.index() + 1, UNRANKED);
        }
    }

    /// Notes that a ranked id died (it stays in the order until a merge).
    pub fn note_released(&mut self, id: NameId) {
        if self.is_ranked(id) {
            self.dead_ranked += 1;
        }
    }

    /// Sorts every live id into the order: the one full sort, run once after
    /// bootstrap. Names interned later wait in `unranked`.
    pub fn build(&mut self, names: &NameStore) {
        let mut order: Vec<NameId> = names.name_ids().filter(|&id| names.is_live(id)).collect();
        order.sort_unstable_by(|&a, &b| {
            names
                .folded_bytes(a)
                .cmp(names.folded_bytes(b))
                .then(a.cmp(&b))
        });
        self.order = order;
        self.unranked.clear();
        self.dead_ranked = 0;
        self.rerank(names);
    }

    /// Whether enough names sit outside the order that queries pay for it.
    pub fn wants_merge(&self) -> bool {
        let limit = 1024.max(self.order.len() / 1000);
        self.unranked.len() > limit || self.dead_ranked > limit
    }

    /// Folds the waiting ids into the order and drops dead ones: one O(n)
    /// merge, never a re-sort.
    pub fn merge_unranked(&mut self, names: &NameStore) {
        if self.order.is_empty() {
            self.build(names);
            return;
        }
        let mut waiting = core::mem::take(&mut self.unranked);
        waiting.retain(|&id| names.is_live(id));
        waiting.sort_unstable_by(|&a, &b| Self::key(names, a).cmp(&Self::key(names, b)));
        let old = core::mem::take(&mut self.order);
        let mut merged = Vec::with_capacity(old.len() + waiting.len());
        let mut old_live = old
            .iter()
            .copied()
            .filter(|&id| names.is_live(id))
            .peekable();
        let mut waiting = waiting.into_iter().peekable();
        while let (Some(&o), Some(&n)) = (old_live.peek(), waiting.peek()) {
            if Self::key(names, n) < Self::key(names, o) {
                merged.push(n);
                waiting.next();
            } else {
                merged.push(o);
                old_live.next();
            }
        }
        merged.extend(old_live);
        merged.extend(waiting);
        self.order = merged;
        self.dead_ranked = 0;
        self.rerank(names);
    }

    /// Recomputes every rank: equal folded names share the position of the
    /// first live one of them; dead and waiting ids rank with nothing.
    fn rerank(&mut self, names: &NameStore) {
        self.rank_of.iter_mut().for_each(|rank| *rank = UNRANKED);
        let mut group_start = 0usize;
        let mut previous: Option<&[u8]> = None;
        for (position, &id) in self.order.iter().enumerate() {
            if !names.is_live(id) {
                continue;
            }
            let folded = names.folded_bytes(id);
            if previous != Some(folded) {
                group_start = position;
                previous = Some(folded);
            }
            self.rank_of[id.index()] = group_start as u32;
        }
    }

    /// The `u64` key a name-sorted candidate is ordered by.
    ///
    /// A ranked name maps to `2*rank+1`; an unranked one borrows the key of the
    /// ranked group with the same folded bytes, or `2*p` for its insertion
    /// position `p`, which lands strictly between the neighbouring keys. Two
    /// unranked names between the same neighbours tie; the caller breaks the
    /// tie on the folded bytes.
    pub fn rank_key(&self, id: NameId, names: &NameStore) -> u64 {
        let rank = self.rank(id);
        if rank != UNRANKED {
            return 2 * u64::from(rank) + 1;
        }
        let folded = names.folded_bytes(id);
        let position = self.insertion_point(folded, names);
        match self.first_live_at(position, names) {
            Some(at) if names.folded_bytes(self.order[at]) == folded => {
                2 * u64::from(self.rank(self.order[at])) + 1
            }
            _ => 2 * position as u64,
        }
    }

    /// First position at or after `from` holding a live id.
    fn first_live_at(&self, from: usize, names: &NameStore) -> Option<usize> {
        (from..self.order.len()).find(|&position| names.is_live(self.order[position]))
    }

    /// A position `p` where every live id before `p` folds below `folded` and
    /// every live id from `p` on folds at or above it. Dead ids are zero-filled
    /// and out of order, so the search probes past them.
    fn insertion_point(&self, folded: &[u8], names: &NameStore) -> usize {
        let (mut low, mut high) = (0usize, self.order.len());
        while low < high {
            let middle = low + (high - low) / 2;
            match self.first_live_at(middle, names).filter(|&at| at < high) {
                None => high = middle,
                Some(at) => {
                    if names.folded_bytes(self.order[at]) < folded {
                        low = at + 1;
                    } else {
                        high = middle;
                    }
                }
            }
        }
        low
    }

    /// Rewrites the order lists through a compaction remap.
    ///
    /// Runs BEFORE the plan is installed; ranks are rebuilt afterwards by
    /// [`Self::rebuild_after_compaction`] once the store has new ids.
    pub fn remap_for_compaction(&mut self, plan: &CompactPlan) {
        self.order = self.order.iter().filter_map(|&id| plan.remap(id)).collect();
        self.unranked = self
            .unranked
            .iter()
            .filter_map(|&id| plan.remap(id))
            .collect();
        self.rank_of = vec![UNRANKED; plan.compacted_names()];
        self.dead_ranked = 0;
    }

    /// Re-ranks the remapped order against the compacted store.
    pub fn rebuild_after_compaction(&mut self, names: &NameStore) {
        self.rank_of.resize(names.slot_count(), UNRANKED);
        self.rerank(names);
    }
}

/// A compaction plan plus the name-store revision it was built from.
///
/// The plan copies live names with `&self` so it can be built off the write
/// lock, but it must be installed only while the store is unchanged: a later
/// intern or release can shrink or grow the id space the remap was computed
/// for, and installing it then would renumber ids the plan never saw (or panic
/// on the length mismatch). `VolumeIndex::apply_compaction` therefore compares
/// [`Self::revision`] with the current store revision and refuses a stale plan
/// without touching the index.
pub struct CompactionPlan {
    plan: CompactPlan,
    revision: u64,
}

impl CompactionPlan {
    /// Revision of the name store the plan was built from.
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

impl VolumeIndex {
    /// Builds a compaction plan without mutating the index, or `None` when the
    /// arenas are not dirty enough.
    pub fn plan_compaction(&self) -> Option<CompactionPlan> {
        self.names.should_compact().then(|| CompactionPlan {
            plan: self.names.plan_compact(),
            revision: self.names_revision,
        })
    }

    /// Installs a [`CompactionPlan`] if it is still current.
    ///
    /// Returns `false` and leaves the index untouched when any name-store
    /// mutation happened after the plan was built; the caller re-plans under the
    /// write lock then. On success the compacted names are swapped, the entry
    /// name column is renumbered and the name order is remapped and re-ranked.
    pub fn apply_compaction(&mut self, plan: CompactionPlan) -> bool {
        if plan.revision != self.names_revision {
            return false;
        }
        let CompactionPlan { plan, .. } = plan;
        self.order.remap_for_compaction(&plan);
        self.names.install_compacted(plan, &mut self.entries);
        self.names_revision += 1;
        self.order.rebuild_after_compaction(&self.names);
        true
    }

    /// One-shot storage optimization after bootstrap: switch the record map to
    /// its cheaper dense backing when the record space allows it, and build the
    /// name order while every name is known.
    pub fn optimize_storage(&mut self) {
        self.by_record.densify_if_smaller();
        self.order.build(&self.names);
    }

    /// `(in the order, waiting)` name counts for diagnostics.
    pub fn name_order_stats(&self) -> (usize, usize) {
        self.order.stats()
    }

    /// Ids in folded-name order (query layer, P7).
    pub fn name_order(&self) -> &[NameId] {
        self.order.order()
    }

    /// Ids waiting for the next merge (query layer, P7).
    pub fn name_unranked(&self) -> &[NameId] {
        self.order.unranked()
    }

    /// Whether the name already has a rank.
    pub fn name_is_ranked(&self, id: NameId) -> bool {
        self.order.is_ranked(id)
    }

    /// The `u64` sort key of a name; see [`NameOrder::rank_key`].
    pub fn name_rank_key(&self, id: NameId) -> u64 {
        self.order.rank_key(id, &self.names)
    }

    /// Test-only: folds the waiting names into the order now.
    #[cfg(test)]
    pub fn force_name_merge(&mut self) {
        self.order.merge_unranked(&self.names);
    }

    /// Test-only: response of the record map's backing kind.
    #[cfg(test)]
    pub fn record_map_kind(&self) -> &'static str {
        self.by_record.kind()
    }
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod storage_tests;
