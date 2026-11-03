use crate::ids::RecordId;
use crate::index::invariants_tests::dir_index_matches_rebuild;
use crate::index::path::PathStatus;
use crate::index::record_map::RecordMap;
use crate::index::volume::VolumeIndex;
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
    index.insert_enum(&create(100, ROOT, b"a", true));
    index.insert_enum(&create(101, 100, b"b", true));
    index.insert_enum(&create(102, 101, b"c.txt", false));
    index.insert_enum(&create(103, ROOT, b"d", true));
    index
}

fn head(index: &VolumeIndex, record: u64) -> crate::ids::EntryId {
    index.head_of(RecordId::new(record)).expect("indexed")
}

#[test]
fn child_dir_resolves_only_directory_entries() {
    let index = tree();
    assert_eq!(index.child_dir(index.root(), b"a"), Some(head(&index, 100)));
    assert_eq!(
        index.child_dir(head(&index, 100), b"b"),
        Some(head(&index, 101))
    );
    assert_eq!(index.child_dir(head(&index, 100), b"c.txt"), None);
    assert_eq!(index.child_dir(index.root(), b"missing"), None);
    assert_eq!(index.child_dir(head(&index, 100), b"a"), None);
}

#[test]
fn child_dir_matches_the_folded_name() {
    let mut index = tree();
    index.insert_enum(&create(200, ROOT, b"Docs", true));
    assert_eq!(
        index.child_dir(index.root(), b"docs"),
        Some(head(&index, 200))
    );
    assert_eq!(index.child_dir(index.root(), b"Docs"), None);
    assert_eq!(index.folded_name(head(&index, 200)), b"docs");
}

#[test]
fn rename_moves_the_scope_key() {
    let mut index = tree();
    let directory = head(&index, 100);
    assert_eq!(index.child_dir(index.root(), b"a"), Some(directory));
    index.insert_enum(&create(100, ROOT, b"renamed", true));
    assert_eq!(index.child_dir(index.root(), b"a"), None);
    assert_eq!(index.child_dir(index.root(), b"renamed"), Some(directory));
    assert!(dir_index_matches_rebuild(&index));
}

#[test]
fn deleting_a_directory_removes_its_scope_key() {
    let mut index = tree();
    assert_eq!(index.child_dir(index.root(), b"a"), Some(head(&index, 100)));
    index.apply_batch(&[ParsedUsnRecord {
        major_version: 2,
        record: RecordId::new(100),
        parent: RecordId::new(ROOT),
        usn: 0,
        timestamp_ft: 0,
        reason: crate::usn::USN_REASON_FILE_DELETE,
        attributes: 0,
        name: Vec::new(),
        name_lossy: false,
    }]);
    assert_eq!(index.child_dir(index.root(), b"a"), None);
    assert!(dir_index_matches_rebuild(&index));
}

#[test]
fn subtree_walk_yields_strict_descendants_depth_first() {
    let index = tree();
    let mut under_root: Vec<crate::ids::EntryId> = index.subtree_entries(index.root()).collect();
    under_root.sort();
    assert_eq!(
        under_root,
        vec![
            head(&index, 100),
            head(&index, 101),
            head(&index, 102),
            head(&index, 103)
        ]
    );

    let mut under_a: Vec<crate::ids::EntryId> = index.subtree_entries(head(&index, 100)).collect();
    under_a.sort();
    assert_eq!(under_a, vec![head(&index, 101), head(&index, 102)]);
    assert!(index.subtree_entries(head(&index, 102)).next().is_none());
}

#[test]
fn duplicate_sibling_names_are_kept_as_candidates_and_compared_exactly() {
    let mut index = tree();
    index.insert_enum(&create(200, ROOT, b"Same", true));
    index.insert_enum(&create(201, ROOT, b"same", true));
    let found = index
        .child_dir(index.root(), b"same")
        .expect("one of the two folded-equal directories");
    assert!(found == head(&index, 200) || found == head(&index, 201));
    assert!(dir_index_matches_rebuild(&index));
}
#[test]
fn child_dir_ignores_a_detached_child_directory_after_parent_slot_reuse() {
    let mut index = tree();
    index.insert_enum(&create(300, 100, b"childdir", true));
    let old_parent = head(&index, 100);
    let child = head(&index, 300);
    assert_eq!(index.child_dir(old_parent, b"childdir"), Some(child));

    // The parent dies while its child directory record survives: the child is
    // severed (CHAIN_DETACHED) and its scope key still names the old slot.
    index.apply_batch(&[ParsedUsnRecord {
        major_version: 2,
        record: RecordId::new(100),
        parent: RecordId::new(ROOT),
        usn: 0,
        timestamp_ft: 0,
        reason: crate::usn::USN_REASON_FILE_DELETE,
        attributes: 0,
        name: Vec::new(),
        name_lossy: false,
    }]);

    // A new directory reuses the record number (and thus the entry slot).
    index.insert_enum(&create(100, ROOT, b"replacement", true));
    let new_parent = head(&index, 100);
    assert_eq!(new_parent, old_parent, "the freed slot must be reused");
    assert_eq!(
        index.child_dir(new_parent, b"childdir"),
        None,
        "a chain-detached child directory must never resolve through a reused parent slot"
    );
    let mut path = Vec::new();
    assert_eq!(index.path_of(child, &mut path), PathStatus::Stale);
}
