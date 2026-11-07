use super::*;
use crate::ids::{EntryId, RecordId};

#[test]
fn empty_maps_report_empty() {
    let sparse = RecordMap::sparse();
    assert!(sparse.is_empty());
    assert_eq!(sparse.len(), 0);
    assert_eq!(sparse.get(0), None);
    assert_eq!(sparse.kind(), "sparse");

    let dense = RecordMap::dense(0);
    assert!(dense.is_empty());
    assert_eq!(dense.get(0), None);
    assert_eq!(dense.kind(), "dense");
}

#[test]
fn sparse_map_round_trips_and_replaces() {
    let mut map = RecordMap::sparse();
    map.set(42, EntryId::new(1));
    assert_eq!(map.get(42), Some(EntryId::new(1)));
    assert_eq!(map.get(41), None);
    assert_eq!(map.len(), 1);

    map.set(42, EntryId::new(2));
    assert_eq!(map.get(42), Some(EntryId::new(2)));
    assert_eq!(map.len(), 1);

    map.remove(42);
    assert_eq!(map.get(42), None);
    assert!(map.is_empty());
    map.remove(42);
}

#[test]
fn dense_map_grows_to_the_record_number() {
    let mut map = RecordMap::dense(0);
    map.set(3, EntryId::new(9));
    assert_eq!(map.get(3), Some(EntryId::new(9)));
    assert_eq!(map.get(2), None);
    assert_eq!(map.len(), 1);

    map.set(1, EntryId::new(4));
    assert_eq!(map.get(1), Some(EntryId::new(4)));
    assert_eq!(map.len(), 2);

    map.remove(3);
    assert_eq!(map.get(3), None);
    assert_eq!(map.len(), 1);
    map.remove(99);
}

#[test]
fn record_number_key_ignores_the_generation() {
    let first = RecordId::from_parts(7, 1);
    let second = RecordId::from_parts(7, 2);
    assert_eq!(first.record_number(), second.record_number());

    let mut map = RecordMap::sparse();
    map.set(first.record_number(), EntryId::new(3));
    assert_eq!(map.get(second.record_number()), Some(EntryId::new(3)));

    map.set(second.record_number(), EntryId::new(4));
    assert_eq!(map.get(first.record_number()), Some(EntryId::new(4)));
    assert_eq!(map.len(), 1);
}

#[test]
fn densify_converts_only_when_dense_is_smaller() {
    let mut map = RecordMap::sparse();
    for record in 0..64u64 {
        map.set(record, EntryId::new(record as u32));
    }
    map.densify_if_smaller();
    assert_eq!(map.kind(), "dense");
    assert_eq!(map.len(), 64);
    for record in 0..64u64 {
        assert_eq!(map.get(record), Some(EntryId::new(record as u32)));
    }

    map.densify_if_smaller();
    assert_eq!(map.kind(), "dense");
}

#[test]
fn sparse_stays_sparse_for_high_record_numbers() {
    let mut map = RecordMap::sparse();
    map.set(1_000_000, EntryId::new(1));
    map.set(2_000_000, EntryId::new(2));
    map.densify_if_smaller();
    assert_eq!(map.kind(), "sparse");
    assert_eq!(map.get(2_000_000), Some(EntryId::new(2)));
    assert_eq!(map.len(), 2);
}

#[test]
fn densify_leaves_an_empty_sparse_map_alone() {
    let mut map = RecordMap::sparse();
    map.densify_if_smaller();
    assert_eq!(map.kind(), "sparse");
    assert!(map.is_empty());
}
