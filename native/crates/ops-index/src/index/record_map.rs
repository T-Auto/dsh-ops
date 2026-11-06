// Design informed by mustafaahci/goz (MIT).
//! Dense or sparse map from a record number to an entry slot.
//!
//! The key is the low 48-bit record number, not the full [`crate::ids::RecordId`]:
//! that is what lets the map notice slot reuse -- a new generation of the same
//! record replaces the old mapping instead of adding a second one. The caller
//! keeps the generation and compares it after the lookup.
//!
//! A volume with contiguous record numbers can store one entry id per number
//! ([Dense](RecordMap::Dense)); a sparse volume stores only what exists
//! ([Sparse](RecordMap::Sparse)). [`RecordMap::densify_if_smaller`] switches when
//! the dense array would be smaller, mirroring the index's memory contract.

use std::collections::HashMap;

use crate::ids::EntryId;

/// Bytes one dense slot costs: a four-byte entry id.
const DENSE_BYTES_PER_SLOT: usize = 4;

/// Estimated bytes one sparse slot costs: a sixteen-byte pair plus one control
/// byte. Used only to compare against the dense alternative.
const SPARSE_BYTES_PER_SLOT: usize = 17;

/// Empty dense slot marker; never a live entry id.
const EMPTY: EntryId = EntryId::NIL;

/// Record-number to entry-slot map.
#[derive(Debug)]
pub enum RecordMap {
    /// One slot per record number, starting at zero.
    Dense(Vec<EntryId>),
    /// Only the record numbers that exist.
    Sparse(HashMap<u64, EntryId>),
}

impl RecordMap {
    /// Builds an empty sparse map.
    pub fn sparse() -> Self {
        Self::Sparse(HashMap::new())
    }

    /// Builds a dense map with `capacity` empty slots.
    pub fn dense(capacity: usize) -> Self {
        Self::Dense(vec![EMPTY; capacity])
    }

    /// Name of the current representation, for diagnostics.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Dense(_) => "dense",
            Self::Sparse(_) => "sparse",
        }
    }

    /// Number of mappings.
    ///
    /// Linear in the dense array length because unused slots count as absent.
    pub fn len(&self) -> usize {
        match self {
            Self::Dense(slots) => slots.iter().filter(|entry| !entry.is_nil()).count(),
            Self::Sparse(map) => map.len(),
        }
    }

    /// Whether the map holds no mapping.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Entry slot of `record`, or `None`.
    pub fn get(&self, record: u64) -> Option<EntryId> {
        match self {
            Self::Dense(slots) => {
                let index = usize::try_from(record).ok()?;
                slots.get(index).copied().filter(|entry| !entry.is_nil())
            }
            Self::Sparse(map) => map.get(&record).copied(),
        }
    }

    /// Maps `record` to `entry`, replacing an older generation's mapping.
    ///
    /// # Panics
    ///
    /// Panics in dense mode when the record number does not fit in `usize`;
    /// dense mode is only used for contiguous record spaces on 64-bit targets.
    pub fn set(&mut self, record: u64, entry: EntryId) {
        debug_assert!(!entry.is_nil(), "a tombstoned entry cannot be mapped");
        match self {
            Self::Dense(slots) => {
                let index = usize::try_from(record).expect("dense record map needs a 64-bit usize");
                if index >= slots.len() {
                    slots.resize(index + 1, EMPTY);
                }
                slots[index] = entry;
            }
            Self::Sparse(map) => {
                map.insert(record, entry);
            }
        }
    }

    /// Removes the mapping of `record`, if any.
    pub fn remove(&mut self, record: u64) {
        match self {
            Self::Dense(slots) => {
                if let Ok(index) = usize::try_from(record)
                    && let Some(slot) = slots.get_mut(index)
                {
                    *slot = EMPTY;
                }
            }
            Self::Sparse(map) => {
                map.remove(&record);
            }
        }
    }

    /// Converts a sparse map to dense when that is smaller.
    ///
    /// The threshold is `(max_record + 1) * 4 < capacity * 17`: the dense array
    /// must win against the estimated sparse footprint. An empty sparse map has
    /// no maximum and stays sparse.
    pub fn densify_if_smaller(&mut self) {
        let replacement = if let Self::Sparse(map) = self {
            let Some(&max_record) = map.keys().max() else {
                return;
            };
            let Some(dense_len) = usize::try_from(max_record.saturating_add(1)).ok() else {
                return;
            };
            let Some(dense_bytes) = dense_len.checked_mul(DENSE_BYTES_PER_SLOT) else {
                return;
            };
            if dense_bytes >= map.capacity() * SPARSE_BYTES_PER_SLOT {
                return;
            }
            let mut slots = vec![EMPTY; dense_len];
            for (&record, &entry) in map.iter() {
                slots[record as usize] = entry;
            }
            Some(Self::Dense(slots))
        } else {
            None
        };
        if let Some(replacement) = replacement {
            *self = replacement;
        }
    }
}

#[cfg(test)]
#[path = "record_map_tests.rs"]
mod record_map_tests;
