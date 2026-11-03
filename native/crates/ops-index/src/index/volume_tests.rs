use super::*;
use crate::ids::{EntryId, RecordId};
use crate::index::entry::EntryFlags;
use crate::index::path::PathStatus;
use crate::layout::{FILE_ATTRIBUTE_DIRECTORY, LayoutFile, LayoutName};
use crate::usn::{
    FILE_ATTRIBUTE_DIRECTORY as USN_DIRECTORY, ParsedUsnRecord, USN_REASON_DATA_EXTEND,
    USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE, USN_REASON_RENAME_NEW_NAME,
};

const ROOT: u64 = 5;

fn record(record: u64, parent: u64, name: &[u8], reason: u32, is_dir: bool) -> ParsedUsnRecord {
    ParsedUsnRecord {
        major_version: 2,
        record: RecordId::new(record),
        parent: RecordId::new(parent),
        usn: 0,
        timestamp_ft: 0,
        reason,
        attributes: if is_dir { USN_DIRECTORY } else { 0 },
        name: name.to_vec(),
        name_lossy: false,
    }
}

fn create(record_id: u64, parent: u64, name: &[u8], is_dir: bool) -> ParsedUsnRecord {
    let mut rec = record(
        record_id,
        parent,
        name,
        USN_REASON_FILE_CREATE | USN_REASON_DATA_EXTEND,
        is_dir,
    );
    rec.attributes = if is_dir { USN_DIRECTORY } else { 0 };
    rec
}

fn layout_name(parent: u64, name: &[u8]) -> LayoutName {
    LayoutName {
        parent: RecordId::new(parent),
        name: name.to_vec(),
        name_lossy: false,
        dos_only: false,
    }
}

fn layout_file(
    reference: u64,
    names: Vec<LayoutName>,
    is_dir: bool,
    size: Option<u64>,
    mtime_ft: Option<i64>,
) -> LayoutFile {
    LayoutFile {
        reference: RecordId::new(reference),
        attributes: if is_dir { FILE_ATTRIBUTE_DIRECTORY } else { 0 },
        size,
        mtime_ft,
        names,
    }
}

fn new_index() -> VolumeIndex {
    VolumeIndex::new(RecordId::new(ROOT), RecordMap::sparse())
}

fn sorted_paths(index: &VolumeIndex) -> Vec<String> {
    let mut paths = index.collect_real_paths();
    paths.sort();
    paths
}

#[test]
fn builds_simple_tree_and_reconstructs_paths() {
    let mut index = new_index();
    index.insert_enum(&create(1000, ROOT, b"docs", true));
    index.insert_enum(&create(1001, 1000, b"sub", true));
    index.insert_enum(&create(1002, 1001, b"report.pdf", false));
    index.insert_enum(&create(1003, ROOT, b"top.txt", false));

    assert_eq!(
        sorted_paths(&index),
        vec![
            "docs".to_string(),
            "docs/sub".to_string(),
            "docs/sub/report.pdf".to_string(),
            "top.txt".to_string(),
        ]
    );
    assert!(!index.has_orphans());
    assert!(index.child_chains_match_rebuild());
    assert!(index.name_chains_match_rebuild());
    assert!(index.name_refcounts_match_chains());
    assert!(index.dir_index_matches_rebuild());
}

#[test]
fn directory_rename_touches_exactly_one_entry() {
    let mut index = new_index();
    index.insert_enum(&create(1000, ROOT, b"old", true));
    for child in 0..3000u64 {
        index.insert_enum(&create(
            2000 + child,
            1000,
            format!("f{child:05}.txt").as_bytes(),
            false,
        ));
    }
    index.take_write_count();

    let mut rename = record(1000, ROOT, b"RENAMED", USN_REASON_RENAME_NEW_NAME, true);
    rename.attributes = USN_DIRECTORY;
    let outcome = index.apply_batch(&[rename]);
    assert!(outcome.anomalies.is_empty());

    assert_eq!(
        index.take_write_count(),
        1,
        "a directory rename must touch one entry"
    );
    let paths = sorted_paths(&index);
    assert!(paths.contains(&"RENAMED/f00000.txt".to_string()));
    assert!(paths.contains(&"RENAMED/f02999.txt".to_string()));
    assert!(!paths.iter().any(|path| path.starts_with("old/")));
    assert!(index.child_chains_match_rebuild());
    assert!(index.name_chains_match_rebuild());
}

#[test]
fn orphan_gets_placeholder_then_reparents_when_parent_arrives() {
    let mut index = new_index();
    index.insert_enum(&create(7, 42, b"child.txt", false));

    assert!(index.has_orphans());
    assert_eq!(index.stats().placeholders_created, 1);
    let child = index.head_of(RecordId::new(7)).expect("child indexed");
    let mut path = Vec::new();
    assert_eq!(index.path_of(child, &mut path), PathStatus::InLostFound);
    assert_eq!(index.path_of(index.root(), &mut path), PathStatus::Ok);
    assert!(sorted_paths(&index).is_empty());

    index.insert_enum(&create(42, ROOT, b"parent", true));
    assert!(!index.has_orphans());
    assert_eq!(
        sorted_paths(&index),
        vec!["parent".to_string(), "parent/child.txt".to_string()]
    );
    let child = index.head_of(RecordId::new(7)).expect("child indexed");
    let mut path = Vec::new();
    assert_eq!(index.path_of(child, &mut path), PathStatus::Ok);
}

#[test]
fn slot_reuse_never_aliases() {
    let mut index = new_index();
    index.insert_enum(&create(7, ROOT, b"old.txt", false));
    assert!(index.head_of(RecordId::new(7)).is_some());

    let reused = RecordId::from_parts(7, 4);
    let mut second = create(7, ROOT, b"new.txt", false);
    second.record = reused;
    index.insert_enum(&second);

    assert_eq!(index.stats().stale_slots, 1);
    assert_eq!(sorted_paths(&index), vec!["new.txt".to_string()]);
    assert!(index.head_of(RecordId::new(7)).is_none());
    assert_eq!(
        index
            .head_of(reused)
            .map(|entry| index.entry(entry).expect("live").name_id()),
        Some(
            index
                .names()
                .name_ids()
                .find(|&id| index.names().raw_bytes(id) == b"new.txt")
                .unwrap()
        )
    );
}

#[test]
fn parent_slot_reuse_never_leaks_the_stale_chain() {
    let mut index = new_index();
    index.insert_enum(&create(10, ROOT, b"ghostdir", true));
    index.insert_enum(&create(11, 10, b"ghost.txt", false));
    assert!(sorted_paths(&index).contains(&"ghostdir/ghost.txt".to_string()));

    let mut reused = create(10, ROOT, b"newdir", true);
    reused.record = RecordId::from_parts(10, 2);
    index.insert_enum(&reused);

    assert_eq!(index.stats().stale_slots, 1);
    let paths = sorted_paths(&index);
    assert_eq!(paths, vec!["newdir".to_string()]);
    let ghost = index
        .head_of(RecordId::new(11))
        .expect("ghost entry still live");
    let mut path = Vec::new();
    assert_eq!(
        index.path_of(ghost, &mut path),
        PathStatus::Stale,
        "a severed child must not resolve through the reused slot"
    );
    assert!(index.child_chains_match_rebuild());
}

#[test]
fn double_apply_equals_single_apply() {
    let batch = vec![
        create(1000, ROOT, b"docs", true),
        create(1001, 1000, b"a.txt", false),
        create(1002, 1000, b"b.txt", false),
    ];
    let mut once = new_index();
    once.apply_batch(&batch);
    let mut twice = new_index();
    twice.apply_batch(&batch);
    twice.apply_batch(&batch);

    assert_eq!(sorted_paths(&once), sorted_paths(&twice));
    assert_eq!(
        sorted_paths(&twice),
        vec![
            "docs".to_string(),
            "docs/a.txt".to_string(),
            "docs/b.txt".to_string()
        ]
    );
    assert_eq!(once.len(), twice.len());
}

#[test]
fn delete_of_unknown_is_counted_not_fatal() {
    let mut index = new_index();
    let delete = record(99, ROOT, b"", USN_REASON_FILE_DELETE, false);
    let outcome = index.apply_batch(&[delete]);

    assert_eq!(index.stats().delete_of_unknown, 1);
    assert_eq!(
        outcome.anomalies,
        vec![Anomaly::DeleteOfUnknown {
            record: RecordId::new(99)
        }]
    );
}

#[test]
fn created_and_deleted_in_same_batch_nets_to_nothing() {
    let mut index = new_index();
    let create_record = create(7, ROOT, b"temp.txt", false);
    let delete_record = record(7, ROOT, b"", USN_REASON_FILE_DELETE, false);
    index.apply_batch(&[create_record, delete_record]);

    assert!(sorted_paths(&index).is_empty());
    assert_eq!(index.len(), 2);
    assert_eq!(index.allocated(), 3);
    assert!(index.child_chains_match_rebuild());
}

#[test]
fn oversized_usn_names_are_rejected_before_interning() {
    let mut index = new_index();
    let long_name = vec![b'x'; MAX_NAME_BYTES + 1];
    let record = create(7, ROOT, &long_name, false);
    let outcome = index.apply_batch(&[record]);

    assert_eq!(
        outcome.anomalies,
        vec![Anomaly::OversizedName {
            record: RecordId::new(7),
            len: (MAX_NAME_BYTES + 1) as u64
        }]
    );
    assert!(sorted_paths(&index).is_empty());
    assert_eq!(index.len(), 2);
}

#[test]
fn insert_layout_builds_every_path_from_the_roots_record_and_hard_links() {
    let mut index = new_index();
    let root_page = layout_file(5, vec![layout_name(5, b"root")], true, None, Some(10));
    let file_page = layout_file(
        200,
        vec![
            layout_name(100, b"report.pdf"),
            LayoutName {
                parent: RecordId::new(100),
                name: b"REPORT~1.PDF".to_vec(),
                name_lossy: false,
                dos_only: true,
            },
        ],
        false,
        Some(4096),
        Some(1234),
    );
    let docs_page = layout_file(100, vec![layout_name(5, b"docs")], true, None, Some(99));

    index.insert_layout(&file_page);
    assert!(index.has_orphans());
    index.insert_layout(&docs_page);
    index.insert_layout(&root_page);

    assert!(!index.has_orphans());
    assert_eq!(
        sorted_paths(&index),
        vec!["docs".to_string(), "docs/report.pdf".to_string()]
    );
    let file = index.head_of(RecordId::new(200)).expect("file indexed");
    let view = index.entry(file).expect("live");
    assert_eq!(view.size(), Some(4096));
    assert_eq!(view.mtime(), Some(1234));
    assert!(index.child_chains_match_rebuild());
}

#[test]
fn enrich_builds_hard_link_chain_findable_under_every_name() {
    let mut index = new_index();
    index.insert_layout(&layout_file(
        100,
        vec![layout_name(5, b"dirA")],
        true,
        None,
        None,
    ));
    index.insert_layout(&layout_file(
        101,
        vec![layout_name(5, b"dirB")],
        true,
        None,
        None,
    ));
    index.insert_layout(&layout_file(
        200,
        vec![layout_name(100, b"a.txt"), layout_name(101, b"b.txt")],
        false,
        Some(4096),
        Some(555),
    ));

    assert_eq!(
        sorted_paths(&index),
        vec![
            "dirA".to_string(),
            "dirA/a.txt".to_string(),
            "dirB".to_string(),
            "dirB/b.txt".to_string(),
        ]
    );
    let head = index.head_of(RecordId::new(200)).expect("file indexed");
    let mut links = 0;
    let mut current = head;
    while !current.is_nil() {
        let view = index.entry(current).expect("live link");
        assert_eq!(view.size(), Some(4096));
        assert_eq!(view.mtime(), Some(555));
        links += 1;
        current = index.entries().next_link(current);
    }
    assert_eq!(links, 2);
    assert!(index.name_chains_match_rebuild());
}

#[test]
fn file_delete_removes_the_whole_link_chain() {
    let mut index = new_index();
    index.insert_layout(&layout_file(
        100,
        vec![layout_name(5, b"dirA")],
        true,
        None,
        None,
    ));
    index.insert_layout(&layout_file(
        101,
        vec![layout_name(5, b"dirB")],
        true,
        None,
        None,
    ));
    index.insert_layout(&layout_file(
        200,
        vec![layout_name(100, b"a.txt"), layout_name(101, b"b.txt")],
        false,
        Some(1),
        None,
    ));

    let delete = record(200, 0, b"", USN_REASON_FILE_DELETE, false);
    index.apply_batch(&[delete]);

    assert_eq!(
        sorted_paths(&index),
        vec!["dirA".to_string(), "dirB".to_string()]
    );
    assert!(index.head_of(RecordId::new(200)).is_none());
    assert!(index.child_chains_match_rebuild());
}

#[test]
fn reconcile_links_adds_and_removes_individual_links() {
    let mut index = new_index();
    index.insert_enum(&create(100, ROOT, b"dirA", true));
    index.insert_enum(&create(101, ROOT, b"dirB", true));
    index.insert_enum(&create(200, 100, b"only.txt", false));

    let dir_a = index.head_of(RecordId::new(100)).expect("dirA");
    let dir_b = index.head_of(RecordId::new(101)).expect("dirB");
    let record_id = RecordId::new(200);
    index.reconcile_links(
        record_id,
        &[
            LinkTarget {
                parent: dir_a,
                name: WtfName::new(b"only.txt".to_vec(), false),
            },
            LinkTarget {
                parent: dir_b,
                name: WtfName::new(b"second".to_vec(), false),
            },
        ],
    );
    assert!(sorted_paths(&index).contains(&"dirB/second".to_string()));

    index.reconcile_links(
        record_id,
        &[LinkTarget {
            parent: dir_a,
            name: WtfName::new(b"only.txt".to_vec(), false),
        }],
    );
    assert_eq!(
        sorted_paths(&index),
        vec![
            "dirA".to_string(),
            "dirA/only.txt".to_string(),
            "dirB".to_string()
        ]
    );
    assert!(index.name_chains_match_rebuild());
}

#[test]
fn lone_surrogate_names_round_trip_through_the_index() {
    let mut name = Vec::new();
    let lossy = crate::wtf8::from_utf16(&[0x61, 0xD800, 0x62], &mut name);
    assert!(lossy);

    let mut index = new_index();
    let mut record = create(7, ROOT, &name, false);
    record.name_lossy = true;
    index.insert_enum(&record);

    let entry = index.head_of(RecordId::new(7)).expect("indexed");
    let id = index.entries().name_id(entry);
    assert_eq!(index.names().raw_bytes(id), name.as_slice());
    assert!(
        index
            .entries()
            .flags(entry)
            .contains(EntryFlags::NON_UNICODE_NAME)
    );
    let mut path = Vec::new();
    assert_eq!(index.path_of(entry, &mut path), PathStatus::Ok);
    assert_eq!(path, name);
}

#[test]
fn enrich_with_renamed_directory_never_orphans_children() {
    let mut index = new_index();
    index.insert_enum(&create(100, ROOT, b"documents", true));
    index.insert_enum(&create(200, 100, b"a.txt", false));

    // The rename landed between the ENUM and LAYOUT passes.
    index.insert_enum(&create(100, ROOT, b"renamed", true));
    assert_eq!(
        sorted_paths(&index),
        vec!["renamed".to_string(), "renamed/a.txt".to_string()]
    );

    index.enrich(&layout_file(
        100,
        vec![layout_name(ROOT, b"documents")],
        true,
        None,
        Some(555),
    ));
    assert_eq!(
        sorted_paths(&index),
        vec!["renamed".to_string(), "renamed/a.txt".to_string()]
    );
    let directory = index.head_of(RecordId::new(100)).expect("dir survives");
    assert_eq!(index.entry(directory).expect("live").mtime(), Some(555));
    assert!(index.child_chains_match_rebuild());
}

#[test]
fn enrich_reclaims_a_stale_chain_instead_of_leaking_it() {
    let mut index = new_index();
    index.insert_enum(&create(200, ROOT, b"old-name.txt", false));

    let mut reused = layout_file(
        200,
        vec![layout_name(ROOT, b"new-name.txt")],
        false,
        Some(7),
        None,
    );
    reused.reference = RecordId::from_parts(200, 2);
    index.enrich(&reused);

    assert_eq!(index.stats().stale_slots, 1);
    assert_eq!(sorted_paths(&index), vec!["new-name.txt".to_string()]);
}

#[test]
fn model_names_are_path_unique() {
    let mut index = new_index();
    index.insert_enum(&create(100, ROOT, b"a", true));
    index.insert_enum(&create(101, ROOT, b"b", true));
    index.insert_enum(&create(102, 100, b"same.txt", false));
    index.insert_enum(&create(103, 101, b"same.txt", false));

    let paths = sorted_paths(&index);
    assert_eq!(
        paths,
        vec![
            "a".to_string(),
            "a/same.txt".to_string(),
            "b".to_string(),
            "b/same.txt".to_string()
        ]
    );
    let mut unique = paths.clone();
    unique.dedup();
    assert_eq!(unique, paths);
}

#[test]
fn entry_if_record_rejects_dead_and_reused_slots() {
    let mut index = new_index();
    index.insert_enum(&create(7, ROOT, b"one.txt", false));
    index.insert_enum(&create(8, ROOT, b"two.txt", false));

    assert!(
        index
            .entry_if_record(EntryId::new(999), RecordId::new(7))
            .is_none()
    );
    let entry = index.head_of(RecordId::new(7)).expect("indexed");
    assert!(index.entry_if_record(entry, RecordId::new(8)).is_none());
    assert!(index.entry_if_record(entry, RecordId::new(7)).is_some());

    let delete = record(7, ROOT, b"", USN_REASON_FILE_DELETE, false);
    index.apply_batch(&[delete]);
    assert!(index.entry_if_record(entry, RecordId::new(7)).is_none());
}
