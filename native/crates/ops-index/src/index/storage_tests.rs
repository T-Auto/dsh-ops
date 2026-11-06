use super::*;
use crate::ids::{EntryId, NameId, RecordId};
use crate::index::invariants_tests::{
    name_chains_match_rebuild, name_order_matches_rebuild, name_refcounts_match_chains,
};
use crate::index::record_map::RecordMap;
use crate::usn::{FILE_ATTRIBUTE_DIRECTORY, ParsedUsnRecord, USN_REASON_FILE_CREATE};

const ROOT: u64 = 5;

fn create(record: u64, parent: u64, name: &[u8], is_dir: bool) -> ParsedUsnRecord {
    ParsedUsnRecord {
        major_version: 2,
        record: RecordId::new(record),
        parent: RecordId::new(parent),
        usn: 0,
        timestamp_ft: 0,
        reason: USN_REASON_FILE_CREATE,
        attributes: if is_dir { FILE_ATTRIBUTE_DIRECTORY } else { 0 },
        name: name.to_vec(),
        name_lossy: false,
    }
}

fn index_with(names: &[(&[u8], bool)]) -> VolumeIndex {
    let mut index = VolumeIndex::new(RecordId::new(ROOT), RecordMap::sparse());
    for (position, (name, is_dir)) in names.iter().enumerate() {
        index.insert_enum(&create(100 + position as u64, ROOT, name, *is_dir));
    }
    index
}

fn ranked_keys(index: &VolumeIndex) -> Vec<(u64, Vec<u8>)> {
    index
        .name_order()
        .iter()
        .copied()
        .filter(|&id| index.names().is_live(id))
        .map(|id| {
            (
                index.name_rank_key(id),
                index.names().folded_bytes(id).to_vec(),
            )
        })
        .collect()
}

#[test]
fn a_new_volume_starts_with_a_root_and_lost_and_found() {
    let index = VolumeIndex::new(RecordId::new(ROOT), RecordMap::sparse());
    assert_eq!(index.root(), EntryId::new(0));
    assert_eq!(index.lost_found(), EntryId::new(1));
    assert_eq!(index.len(), 2);
    assert!(!index.has_orphans());
    assert!(name_order_matches_rebuild(&index));
}

#[test]
fn optimize_storage_builds_a_sorted_ranked_order() {
    let mut index = index_with(&[(b"zeta", false), (b"Alpha", false), (b"beta", false)]);
    index.optimize_storage();

    assert_eq!(index.name_order_stats().1, 0, "no name waits after a build");
    let keys = ranked_keys(&index);
    let folded: Vec<Vec<u8>> = keys.iter().map(|(_, name)| name.clone()).collect();
    assert!(folded.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(folded.contains(&b"alpha".to_vec()));
    assert!(folded.contains(&b"beta".to_vec()));
    assert!(folded.contains(&b"zeta".to_vec()));
    assert!(name_order_matches_rebuild(&index));
}

#[test]
fn new_names_wait_unranked_then_merge_into_the_order() {
    let mut index = index_with(&[(b"middle", false)]);
    index.optimize_storage();
    index.insert_enum(&create(200, ROOT, b"aaa", false));
    index.insert_enum(&create(201, ROOT, b"zzz", false));

    assert_eq!(index.name_order_stats().1, 2);
    assert!(name_order_matches_rebuild(&index));

    let aaa = index
        .names()
        .name_ids()
        .find(|&id| index.names().raw_bytes(id) == b"aaa")
        .unwrap();
    let middle = index
        .names()
        .name_ids()
        .find(|&id| index.names().raw_bytes(id) == b"middle")
        .unwrap();
    let zzz = index
        .names()
        .name_ids()
        .find(|&id| index.names().raw_bytes(id) == b"zzz")
        .unwrap();
    assert!(index.name_rank_key(aaa) < index.name_rank_key(middle));
    assert!(index.name_rank_key(middle) < index.name_rank_key(zzz));

    index.force_name_merge();
    assert_eq!(index.name_order_stats().1, 0);
    assert!(name_order_matches_rebuild(&index));
    let keys = ranked_keys(&index);
    let folded: Vec<Vec<u8>> = keys.iter().map(|(_, name)| name.clone()).collect();
    assert!(folded.windows(2).all(|pair| pair[0] <= pair[1]));
    assert_eq!(
        index.name_order_stats().0,
        5,
        "guard, lost-and-found and three names"
    );
}

#[test]
fn dead_names_do_not_rank_and_a_merge_drops_them() {
    let mut index = index_with(&[(b"keep", false), (b"drop", false)]);
    index.optimize_storage();
    let drop = index
        .names()
        .name_ids()
        .find(|&id| index.names().raw_bytes(id) == b"drop")
        .unwrap();
    assert!(index.name_is_ranked(drop));

    index.apply_batch(&[ParsedUsnRecord {
        major_version: 2,
        record: RecordId::new(101),
        parent: RecordId::new(ROOT),
        usn: 0,
        timestamp_ft: 0,
        reason: crate::usn::USN_REASON_FILE_DELETE,
        attributes: 0,
        name: Vec::new(),
        name_lossy: false,
    }]);
    assert!(!index.names().is_live(drop));
    index.force_name_merge();
    assert!(name_order_matches_rebuild(&index));
    assert!(!index.name_is_ranked(drop));
}

#[test]
fn compaction_remaps_entries_and_the_name_order() {
    let mut index = VolumeIndex::new(RecordId::new(ROOT), RecordMap::sparse());
    let mut survivors = Vec::new();
    for position in 0..400u32 {
        let name = format!("dead-{position:05}-padding-padding-padding-padding");
        index.insert_enum(&create(
            1000 + position as u64,
            ROOT,
            name.as_bytes(),
            false,
        ));
        if position % 4 == 0 {
            survivors.push(1000 + position as u64);
        }
    }
    for position in 0..400u32 {
        if position % 4 != 0 {
            index.apply_batch(&[ParsedUsnRecord {
                major_version: 2,
                record: RecordId::new(1000 + position as u64),
                parent: RecordId::new(ROOT),
                usn: 0,
                timestamp_ft: 0,
                reason: crate::usn::USN_REASON_FILE_DELETE,
                attributes: 0,
                name: Vec::new(),
                name_lossy: false,
            }]);
        }
    }
    assert!(
        index.plan_compaction().is_some(),
        "dead names must trigger compaction"
    );
    let before_slots = index.names().slot_count();
    let before_paths = {
        let mut paths = index.collect_real_paths();
        paths.sort();
        paths
    };

    let plan = index.plan_compaction().expect("plan");
    index.apply_compaction(plan);

    assert!(index.names().slot_count() < before_slots);
    let mut after_paths = index.collect_real_paths();
    after_paths.sort();
    assert_eq!(after_paths, before_paths);
    for record in survivors {
        assert!(index.head_of(RecordId::new(record)).is_some());
        assert!(!index.head_of(RecordId::new(record)).unwrap().is_nil());
    }
    assert!(name_order_matches_rebuild(&index));
    assert!(name_chains_match_rebuild(&index));
    assert!(name_refcounts_match_chains(&index));
    assert!(index.plan_compaction().is_none());
}

#[test]
fn optimize_storage_densifies_a_contiguous_record_space() {
    let mut index = VolumeIndex::new(RecordId::new(1), RecordMap::sparse());
    for record in 2..=200u64 {
        index.insert_enum(&create(
            record,
            1,
            format!("file-{record:03}").as_bytes(),
            false,
        ));
    }
    assert_eq!(index.record_map_kind(), "sparse");
    index.optimize_storage();
    assert_eq!(index.record_map_kind(), "dense");
    assert!(index.head_of(RecordId::new(200)).is_some());
    assert_eq!(index.len(), 201);
}

#[test]
fn rank_keys_are_stable_across_compaction() {
    let mut index = VolumeIndex::new(RecordId::new(ROOT), RecordMap::sparse());
    index.insert_enum(&create(100, ROOT, b"aaa", false));
    index.insert_enum(&create(101, ROOT, b"bbb", false));
    index.insert_enum(&create(102, ROOT, b"ccc", false));
    for record in [100u64, 101] {
        index.apply_batch(&[ParsedUsnRecord {
            major_version: 2,
            record: RecordId::new(record),
            parent: RecordId::new(ROOT),
            usn: 0,
            timestamp_ft: 0,
            reason: crate::usn::USN_REASON_FILE_DELETE,
            attributes: 0,
            name: Vec::new(),
            name_lossy: false,
        }]);
    }
    let plan = index.plan_compaction();
    if let Some(plan) = plan {
        index.apply_compaction(plan);
    }
    index.optimize_storage();
    assert!(name_order_matches_rebuild(&index));
    let ids: Vec<NameId> = index.names().name_ids().collect();
    assert!(!ids.is_empty());
}
