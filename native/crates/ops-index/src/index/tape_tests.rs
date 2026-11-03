//! Model-based convergence properties for the volume policy layer.
//!
//! The tape assumes a consistent journal order: a DELETE record names one
//! record only, and in a journal that was applied in order every descendant's
//! own DELETE arrived before its parent's. The model therefore removes the
//! whole subtree on a delete. The index itself cannot assume that (it must
//! survive a missed child delete), so it severs live children instead and
//! refuses their paths; that behaviour has its own unit test in
//! `volume_tests`.

use super::*;
use crate::ids::RecordId;
use crate::index::invariants_tests::{
    child_chains_match_rebuild, dir_index_matches_rebuild, name_chains_match_rebuild,
    name_order_matches_rebuild, name_refcounts_match_chains,
};
use crate::index::record_map::RecordMap;
use crate::layout::{FILE_ATTRIBUTE_DIRECTORY, LayoutFile, LayoutName};
use crate::usn::{
    ParsedUsnRecord, USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE, USN_REASON_RENAME_NEW_NAME,
};
use proptest::prelude::*;
use std::collections::BTreeMap;

const ROOT: u64 = 5;
const FIRST_RECORD: u64 = 100;
const RECORD_COUNT: u16 = 40;
const NAME_COUNT: u8 = 10;

fn record_id(selector: u16) -> u64 {
    FIRST_RECORD + u64::from(selector)
}

fn parent_id(selector: u16) -> u64 {
    if selector == RECORD_COUNT {
        ROOT
    } else {
        record_id(selector)
    }
}

fn name_of(selector: u8) -> Vec<u8> {
    format!("n{selector}").into_bytes()
}

#[derive(Clone, Debug)]
enum Action {
    Create {
        record: u16,
        parent: u16,
        name: u8,
        is_dir: bool,
    },
    Rename {
        record: u16,
        parent: u16,
        name: u8,
    },
    Delete {
        record: u16,
    },
}

fn action_strategy() -> impl Strategy<Value = Action> {
    let record = 0u16..RECORD_COUNT;
    let parent = 0u16..=RECORD_COUNT;
    let name = 0u8..NAME_COUNT;
    prop_oneof![
        (record.clone(), parent.clone(), name.clone(), any::<bool>()).prop_map(
            |(record, parent, name, is_dir)| Action::Create {
                record,
                parent,
                name,
                is_dir
            }
        ),
        (record.clone(), parent.clone(), name.clone()).prop_map(|(record, parent, name)| {
            Action::Rename {
                record,
                parent,
                name,
            }
        }),
        record.prop_map(|record| Action::Delete { record }),
    ]
}

/// Model state: record -> (parent record, name, is_dir).
///
/// A delete removes the whole subtree, matching a journal applied in consistent
/// order (the index cannot assume that and instead severs live children; that
/// behaviour is pinned by an explicit unit test).
#[derive(Default)]
struct Model {
    entries: BTreeMap<u64, (u64, Vec<u8>, bool)>,
}

impl Action {
    fn as_record(&self, model: &Model) -> ParsedUsnRecord {
        match self {
            Self::Create {
                record,
                parent,
                name,
                is_dir,
            } => ParsedUsnRecord {
                major_version: 2,
                record: RecordId::new(record_id(*record)),
                parent: RecordId::new(parent_id(*parent)),
                usn: 0,
                timestamp_ft: 0,
                reason: USN_REASON_FILE_CREATE,
                attributes: if *is_dir { FILE_ATTRIBUTE_DIRECTORY } else { 0 },
                name: name_of(*name),
                name_lossy: false,
            },
            Self::Rename {
                record,
                parent,
                name,
            } => {
                let is_dir = model
                    .entries
                    .get(&record_id(*record))
                    .map(|entry| entry.2)
                    .unwrap_or(false);
                ParsedUsnRecord {
                    major_version: 2,
                    record: RecordId::new(record_id(*record)),
                    parent: RecordId::new(parent_id(*parent)),
                    usn: 0,
                    timestamp_ft: 0,
                    reason: USN_REASON_RENAME_NEW_NAME,
                    attributes: if is_dir { FILE_ATTRIBUTE_DIRECTORY } else { 0 },
                    name: name_of(*name),
                    name_lossy: false,
                }
            }
            Self::Delete { record } => ParsedUsnRecord {
                major_version: 2,
                record: RecordId::new(record_id(*record)),
                parent: RecordId::new(ROOT),
                usn: 0,
                timestamp_ft: 0,
                reason: USN_REASON_FILE_DELETE,
                attributes: 0,
                name: Vec::new(),
                name_lossy: false,
            },
        }
    }

    fn apply_to_model(&self, model: &mut Model) {
        match self {
            Self::Create {
                record,
                parent,
                name,
                is_dir,
            } => {
                let record = record_id(*record);
                model
                    .entries
                    .insert(record, (parent_id(*parent), name_of(*name), *is_dir));
            }
            Self::Rename {
                record,
                parent,
                name,
            } => {
                let record = record_id(*record);
                let is_dir = model
                    .entries
                    .get(&record)
                    .map(|entry| entry.2)
                    .unwrap_or(false);
                model
                    .entries
                    .insert(record, (parent_id(*parent), name_of(*name), is_dir));
            }
            Self::Delete { record } => {
                let mut stack = vec![record_id(*record)];
                while let Some(record) = stack.pop() {
                    model.entries.remove(&record);
                    let children: Vec<u64> = model
                        .entries
                        .iter()
                        .filter(|(_, (parent, _, _))| *parent == record)
                        .map(|(&child, _)| child)
                        .collect();
                    stack.extend(children);
                }
            }
        }
    }
}

fn resolve_path(model: &Model, record: u64) -> Option<String> {
    let mut parts = Vec::new();
    let mut current = record;
    while current != ROOT {
        let (parent, name, _) = model.entries.get(&current)?;
        parts.push(name.clone());
        current = *parent;
        if parts.len() > 256 {
            return None;
        }
    }
    parts.reverse();
    let mut path = String::new();
    for part in parts {
        if !path.is_empty() {
            path.push('/');
        }
        path.push_str(&String::from_utf8_lossy(&part));
    }
    Some(path)
}

fn expected_paths(model: &Model) -> Vec<String> {
    let mut paths: Vec<String> = model
        .entries
        .keys()
        .filter_map(|&record| resolve_path(model, record))
        .collect();
    paths.sort();
    paths
}

fn actual_paths(index: &VolumeIndex) -> Vec<String> {
    let mut paths = index.collect_real_paths();
    paths.sort();
    paths
}

fn shuffled(count: usize, seed: u64) -> Vec<usize> {
    let mut order: Vec<usize> = (0..count).collect();
    let mut state = seed | 1;
    for position in (1..count).rev() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let swap = (state as usize) % (position + 1);
        order.swap(position, swap);
    }
    order
}

proptest! {
    // The nightlies found this counterexample (Rename -> Delete of an entry
    // with a live child -> Rename of the same record id) through the
    // `proptest-regressions/index/tape_tests.txt` seed recorded with it.

    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn model_op_tape_converges(actions in prop::collection::vec(action_strategy(), 0..40)) {
        let mut index = VolumeIndex::new(RecordId::new(ROOT), RecordMap::sparse());
        let mut model = Model::default();
        for action in &actions {
            let record = action.as_record(&model);
            index.apply_batch(&[record]);
            action.apply_to_model(&mut model);
            prop_assert!(child_chains_match_rebuild(&index));
            prop_assert!(name_chains_match_rebuild(&index));
            prop_assert!(name_refcounts_match_chains(&index));
            prop_assert!(dir_index_matches_rebuild(&index));
            prop_assert!(name_order_matches_rebuild(&index));
        }
        prop_assert_eq!(actual_paths(&index), expected_paths(&model));

        let batch: Vec<ParsedUsnRecord> = actions.iter().map(|a| a.as_record(&model)).collect();
        index.apply_batch(&batch);
        prop_assert_eq!(actual_paths(&index), expected_paths(&model));
    }

    #[test]
    fn bootstrap_race_converges(
        creates in prop::collection::vec(
            (0u16..RECORD_COUNT, 0u16..=RECORD_COUNT, 0u8..NAME_COUNT, any::<bool>()),
            0..30,
        ),
        seed in any::<u64>(),
        enrich_after in any::<bool>(),
    ) {
        let mut index = VolumeIndex::new(RecordId::new(ROOT), RecordMap::sparse());
        let mut model = Model::default();
        let order = shuffled(creates.len(), seed);
        for position in order {
            let (record, parent, name, is_dir) = creates[position];
            let action = Action::Create {
                record,
                parent,
                name,
                is_dir,
            };
            let record = action.as_record(&model);
            index.insert_enum(&record);
            action.apply_to_model(&mut model);
        }

        if enrich_after {
            for (&record, (parent, name, is_dir)) in &model.entries {
                let page = LayoutFile {
                    reference: RecordId::new(record),
                    attributes: if *is_dir { FILE_ATTRIBUTE_DIRECTORY } else { 0 },
                    size: Some(4096),
                    mtime_ft: Some(7),
                    names: vec![LayoutName {
                        parent: RecordId::new(*parent),
                        name: name.clone(),
                        name_lossy: false,
                        dos_only: false,
                    }],
                };
                index.insert_layout(&page);
            }
        }

        prop_assert_eq!(actual_paths(&index), expected_paths(&model));
        prop_assert!(child_chains_match_rebuild(&index));
        prop_assert!(name_chains_match_rebuild(&index));
        prop_assert!(name_order_matches_rebuild(&index));
    }
}
