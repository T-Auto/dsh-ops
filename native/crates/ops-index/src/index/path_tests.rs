use super::*;
use crate::ids::{EntryId, RecordId};
use crate::index::entry::EntryFlags;
use crate::index::path::{MAX_PATH_HOPS, PathStatus};
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

fn tree() -> VolumeIndex {
    let mut index = VolumeIndex::new(RecordId::new(ROOT), RecordMap::sparse());
    index.insert_enum(&create(100, ROOT, b"docs", true));
    index.insert_enum(&create(200, 100, b"sub", true));
    index.insert_enum(&create(300, 200, b"file.txt", false));
    index
}

fn path_of(index: &VolumeIndex, record: u64) -> (PathStatus, Vec<u8>) {
    let entry = index.head_of(RecordId::new(record)).expect("indexed");
    let mut out = Vec::new();
    let status = index.path_of(entry, &mut out);
    (status, out)
}

#[test]
fn paths_are_rebuilt_from_parent_links_top_down() {
    let index = tree();
    assert_eq!(path_of(&index, 100), (PathStatus::Ok, b"docs".to_vec()));
    assert_eq!(path_of(&index, 200), (PathStatus::Ok, b"docs/sub".to_vec()));
    assert_eq!(
        path_of(&index, 300),
        (PathStatus::Ok, b"docs/sub/file.txt".to_vec())
    );
    assert_eq!(path_of(&index, ROOT), (PathStatus::Ok, Vec::new()));
}

#[test]
fn path_of_appends_without_clearing_the_output() {
    let index = tree();
    let entry = index.head_of(RecordId::new(300)).expect("indexed");
    let mut out = b"prefix:".to_vec();
    assert_eq!(index.path_of(entry, &mut out), PathStatus::Ok);
    assert_eq!(out, b"prefix:docs/sub/file.txt".to_vec());
}

#[test]
fn a_parent_cycle_is_detected_not_looped() {
    let mut index = tree();
    let docs = index.head_of(RecordId::new(100)).expect("docs");
    let sub = index.head_of(RecordId::new(200)).expect("sub");
    index.force_parent(docs, sub);
    let mut out = Vec::new();
    assert_eq!(
        index.path_of(index.head_of(RecordId::new(100)).unwrap(), &mut out),
        PathStatus::CycleDetected
    );
    assert!(out.is_empty());
    let _ = MAX_PATH_HOPS;
}

#[test]
fn a_tombstoned_parent_makes_the_path_stale() {
    let mut index = tree();
    let file = index.head_of(RecordId::new(300)).expect("file.txt");
    // A missed delete: the parent's record dies, the child record does not, so
    // the child survives with a parent pointer into a tombstoned slot.
    index.apply_batch(&[ParsedUsnRecord {
        major_version: 2,
        record: RecordId::new(200),
        parent: RecordId::new(ROOT),
        usn: 0,
        timestamp_ft: 0,
        reason: crate::usn::USN_REASON_FILE_DELETE,
        attributes: 0,
        name: Vec::new(),
        name_lossy: false,
    }]);
    let mut out = Vec::new();
    assert_eq!(index.path_of(file, &mut out), PathStatus::Stale);
    assert!(out.is_empty());
    let _ = EntryId::NIL;
}

#[test]
fn a_chain_detached_child_makes_the_path_stale() {
    let mut index = tree();
    let file = index.head_of(RecordId::new(300)).expect("file.txt");
    let flags = index.entries().flags(file);
    index
        .entries_mut()
        .set_flags(file, flags.with(EntryFlags::CHAIN_DETACHED, true));
    let mut out = Vec::new();
    assert_eq!(index.path_of(file, &mut out), PathStatus::Stale);
    assert!(out.is_empty());
}

#[test]
fn orphans_report_in_lost_found_and_are_not_presentable() {
    let mut index = tree();
    index.insert_enum(&create(7, 42, b"orphan.txt", false));
    let (status, path) = path_of(&index, 7);
    assert_eq!(status, PathStatus::InLostFound);
    assert!(path.starts_with(b"$LostFound/"));

    let entry = index.head_of(RecordId::new(7)).expect("orphan");
    assert!(!index.is_synthetic(entry));
    assert!(!index.is_presentable(entry));
    assert!(index.is_presentable(index.head_of(RecordId::new(100)).expect("docs")));
    assert!(index.is_synthetic(index.lost_found()));
    assert!(index.is_synthetic(index.root()));
    assert!(!index.is_presentable(index.root()));

    let normal = index.head_of(RecordId::new(100)).expect("docs");
    assert!(index.is_presentable(normal));
}

#[test]
fn entry_access_never_panics_on_stale_or_out_of_range_ids() {
    let index = tree();
    assert!(index.entry(EntryId::new(999)).is_none());
    let head = index.head_of(RecordId::new(100)).expect("docs");
    assert!(index.entry_if_record(head, RecordId::new(200)).is_none());
    assert!(index.entry_if_record(head, RecordId::new(100)).is_some());
}
