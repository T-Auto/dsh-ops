use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use crate::mft::MftNode;
use ops_index::usn::{
    USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE, USN_REASON_HARD_LINK_CHANGE,
    USN_REASON_RENAME_NEW_NAME, USN_REASON_RENAME_OLD_NAME,
};
use ops_index::{ChangeAction, EntryKind, FileKey, SourceError};
use usn_journal_rs::{Fid, FileAttributes, Filetime, Usn, UsnReason, UsnSourceInfo};

use super::*;

const SERIAL: u64 = 0x5EA1;
const NORMAL: u32 = 0;
const DIRECTORY: u32 = 0x10;

fn mft_node(fid: u64, parent: u64, name: &str, attributes: u32) -> MftNode {
    MftNode {
        fid: Fid::new(fid),
        parent: Fid::new(parent),
        name: OsString::from(name),
        attributes: FileAttributes::from_bits_retain(attributes),
    }
}

fn seeded<'a>(
    nodes: &'a [MftNode],
    record_paths: &[(u64, PathBuf)],
    root_fid: u64,
) -> SubtreePaths<'a> {
    let mut paths: HashMap<u64, PathBuf> = record_paths.iter().cloned().collect();
    paths.insert(root_fid, PathBuf::new());
    let known: HashSet<u64> = nodes.iter().filter_map(|node| node.fid.as_u64()).collect();
    SubtreePaths {
        paths,
        known,
        nodes,
    }
}

fn entry(fid: u64, parent: u64, name: &str, reason: u32, is_dir: bool) -> UsnEntry {
    let units: Vec<u16> = name.encode_utf16().collect();
    UsnEntry {
        usn: Usn::new(i64::try_from(fid).expect("fid fits") * 10),
        time: Filetime::new(0),
        fid: Fid::new(fid),
        parent_fid: Fid::new(parent),
        reason: UsnReason::from_bits_retain(reason),
        source_info: UsnSourceInfo::from_bits_retain(0),
        file_name: OsString::from_wide(&units),
        file_attributes: FileAttributes::from_bits_retain(if is_dir { DIRECTORY } else { NORMAL }),
    }
}

fn rels(candidates: &HashMap<FileKey, Candidate>) -> Vec<PathBuf> {
    let mut rels: Vec<PathBuf> = candidates
        .values()
        .map(|candidate| candidate.rel.clone())
        .collect();
    rels.sort();
    rels
}

#[test]
fn a_journal_entry_becomes_a_pure_parsed_record() {
    let parsed =
        parsed_record(&entry(42, 10, "résumé.txt", USN_REASON_FILE_CREATE, false)).expect("parse");
    assert_eq!(parsed.record.get(), 42);
    assert_eq!(parsed.parent.get(), 10);
    assert_eq!(parsed.reason, USN_REASON_FILE_CREATE);
    assert!(!parsed.is_dir());
    assert_eq!(
        parsed.name,
        "résumé.txt".as_bytes().to_vec(),
        "names stay WTF-8 bytes"
    );
    assert!(!parsed.name_lossy);
}

#[test]
fn catch_up_applies_creates_renames_and_deletes_to_the_candidate_set() {
    let nodes = [
        mft_node(5, 5, "root", DIRECTORY),
        mft_node(10, 5, "docs", DIRECTORY),
        mft_node(33, 10, "linked.txt", NORMAL),
    ];
    let seed = seeded(&nodes, &[(10, PathBuf::from("docs"))], 5);
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    let entries = [
        entry(20, 5, "newdocs", USN_REASON_FILE_CREATE, true),
        entry(21, 20, "a.txt", USN_REASON_FILE_CREATE, false),
        entry(22, 10, "old.txt", USN_REASON_RENAME_NEW_NAME, false),
        entry(23, 10, "dead.txt", USN_REASON_FILE_DELETE, false),
    ];
    let skipped = apply_entries(&seed, &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(skipped, 0);
    assert_eq!(
        rels(&candidates),
        vec![
            PathBuf::from("docs").join("old.txt"),
            PathBuf::from("newdocs"),
            PathBuf::from("newdocs").join("a.txt"),
        ]
    );
    assert_eq!(candidates[&FileKey::new(SERIAL, 20)].kind, EntryKind::Dir);
    assert!(!candidates.contains_key(&FileKey::new(SERIAL, 23)));
}

#[test]
fn records_outside_the_requested_root_are_ignored_not_skipped() {
    let nodes = [
        mft_node(5, 5, "root", DIRECTORY),
        mft_node(77, 5, "elsewhere", DIRECTORY),
    ];
    let seed = seeded(&nodes, &[], 5);
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    let entries = [entry(
        99,
        77,
        "elsewhere.txt",
        USN_REASON_FILE_CREATE,
        false,
    )];
    let skipped = apply_entries(&seed, &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(
        skipped, 0,
        "an existing parent outside the root is not a defect"
    );
    assert!(candidates.is_empty());
}

#[test]
fn a_dangling_parent_is_counted_as_skipped() {
    let nodes = [mft_node(5, 5, "root", DIRECTORY)];
    let seed = seeded(&nodes, &[], 5);
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    let entries = [entry(98, 999, "orphan.txt", USN_REASON_FILE_CREATE, false)];
    let skipped = apply_entries(&seed, &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(skipped, 1, "a parent missing from the MFT is never guessed");
    assert!(candidates.is_empty());
}

#[test]
fn a_dangling_parent_marks_the_change_report_as_skipped() {
    let nodes = [mft_node(5, 5, "root", DIRECTORY)];
    let seed = seeded(&nodes, &[], 5);
    let entries = [entry(97, 999, "orphan.txt", USN_REASON_FILE_CREATE, false)];
    let report =
        changes_for_entries(&seed, &entries, SERIAL, JournalCursor::new(7, 500)).expect("map");
    assert_eq!(report.skipped, 1);
    assert!(report.changes.is_empty());
}

#[test]
fn changes_map_reason_classes_to_actions() {
    let nodes = [
        mft_node(5, 5, "root", DIRECTORY),
        mft_node(10, 5, "docs", DIRECTORY),
        mft_node(33, 10, "linked.txt", NORMAL),
    ];
    let seed = seeded(
        &nodes,
        &[
            (10, PathBuf::from("docs")),
            (33, PathBuf::from("docs").join("linked.txt")),
        ],
        5,
    );
    let entries = [
        entry(30, 10, "added.txt", USN_REASON_FILE_CREATE, false),
        entry(31, 10, "renamed.txt", USN_REASON_RENAME_NEW_NAME, false),
        entry(32, 10, "dead.txt", USN_REASON_FILE_DELETE, false),
        entry(33, 10, "linked.txt", USN_REASON_HARD_LINK_CHANGE, false),
        entry(34, 10, "old-name.txt", USN_REASON_RENAME_OLD_NAME, false),
    ];
    let report = changes_for_entries(&seed, &entries, SERIAL, JournalCursor::new(7, 500))
        .expect("map changes");
    assert_eq!(report.cursor, JournalCursor::new(7, 500));
    assert_eq!(report.skipped, 0);
    let action_for = |name: &str| {
        report
            .changes
            .iter()
            .filter(|change| change.rel == PathBuf::from("docs").join(name))
            .map(|change| change.action)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        action_for("added.txt"),
        vec![ChangeAction::Added, ChangeAction::Modified],
        "FILE_CREATE is Upsert plus StatDirty in P3's normalization"
    );
    assert_eq!(action_for("renamed.txt"), vec![ChangeAction::Renamed]);
    assert_eq!(action_for("dead.txt"), vec![ChangeAction::Removed]);
    assert_eq!(action_for("linked.txt"), vec![ChangeAction::Modified]);
    assert!(
        action_for("old-name.txt").is_empty(),
        "RENAME_OLD_NAME alone is telemetry"
    );
}

fn directory_rename_tree() -> Vec<MftNode> {
    vec![
        mft_node(5, 5, "root", DIRECTORY),
        mft_node(10, 5, "old", DIRECTORY),
        mft_node(11, 10, "child.txt", NORMAL),
        mft_node(12, 10, "sub", DIRECTORY),
        mft_node(13, 12, "deep.txt", NORMAL),
    ]
}

fn directory_rename_paths() -> Vec<(u64, PathBuf)> {
    vec![
        (10, PathBuf::from("old")),
        (11, PathBuf::from("old").join("child.txt")),
        (12, PathBuf::from("old").join("sub")),
        (13, PathBuf::from("old").join("sub").join("deep.txt")),
    ]
}

#[test]
fn a_directory_rename_moves_every_known_descendant() {
    let nodes = directory_rename_tree();
    let seed = seeded(&nodes, &directory_rename_paths(), 5);
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    for (fid, rel) in directory_rename_paths() {
        let key = FileKey::new(SERIAL, fid);
        let is_dir = fid == 10 || fid == 12;
        candidates.insert(
            key,
            Candidate {
                rel,
                key,
                kind: if is_dir {
                    EntryKind::Dir
                } else {
                    EntryKind::File
                },
                len: 0,
                modified_ns: None,
            },
        );
    }
    let entries = [entry(10, 5, "new", USN_REASON_RENAME_NEW_NAME, true)];
    let skipped = apply_entries(&seed, &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(skipped, 0);
    assert_eq!(
        rels(&candidates),
        vec![
            PathBuf::from("new"),
            PathBuf::from("new").join("child.txt"),
            PathBuf::from("new").join("sub"),
            PathBuf::from("new").join("sub").join("deep.txt"),
        ]
    );
    assert!(
        !candidates
            .values()
            .any(|candidate| candidate.rel.starts_with("old")),
        "no descendant may keep the stale directory prefix"
    );
}

#[test]
fn a_directory_rename_rows_every_known_descendant() {
    let nodes = directory_rename_tree();
    let seed = seeded(&nodes, &directory_rename_paths(), 5);
    let entries = [entry(10, 5, "new", USN_REASON_RENAME_NEW_NAME, true)];
    let report =
        changes_for_entries(&seed, &entries, SERIAL, JournalCursor::new(7, 500)).expect("map");
    assert_eq!(report.skipped, 0);
    for expected in [
        PathBuf::from("new"),
        PathBuf::from("new").join("child.txt"),
        PathBuf::from("new").join("sub"),
        PathBuf::from("new").join("sub").join("deep.txt"),
    ] {
        assert!(
            report
                .changes
                .iter()
                .any(|change| change.rel == expected && change.action == ChangeAction::Renamed),
            "missing Renamed row for {expected:?}: {:?}",
            report.changes
        );
    }
}

fn moved_in_tree() -> Vec<MftNode> {
    vec![
        mft_node(5, 5, "root", DIRECTORY),
        mft_node(77, 5, "outside", DIRECTORY),
        mft_node(20, 77, "incoming", DIRECTORY),
        mft_node(21, 20, "child.txt", NORMAL),
        mft_node(22, 20, "sub", DIRECTORY),
        mft_node(23, 22, "deep.txt", NORMAL),
    ]
}

fn moved_in_paths() -> Vec<PathBuf> {
    vec![
        PathBuf::from("incoming"),
        PathBuf::from("incoming").join("child.txt"),
        PathBuf::from("incoming").join("sub"),
        PathBuf::from("incoming").join("sub").join("deep.txt"),
    ]
}

#[test]
fn a_directory_moved_into_the_root_brings_its_descendants() {
    let nodes = moved_in_tree();
    let seed = seeded(&nodes, &[], 5);
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    let entries = [entry(20, 5, "incoming", USN_REASON_RENAME_NEW_NAME, true)];
    let skipped = apply_entries(&seed, &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(skipped, 0);
    assert_eq!(
        rels(&candidates),
        moved_in_paths(),
        "a moved-in directory must bring the descendants the MFT already knows"
    );
}

#[test]
fn a_directory_moved_into_the_root_rows_its_descendants_as_added() {
    let nodes = moved_in_tree();
    let seed = seeded(&nodes, &[], 5);
    let entries = [entry(20, 5, "incoming", USN_REASON_RENAME_NEW_NAME, true)];
    let report =
        changes_for_entries(&seed, &entries, SERIAL, JournalCursor::new(7, 500)).expect("map");
    assert_eq!(report.skipped, 0);
    let dir = PathBuf::from("incoming");
    assert!(
        report
            .changes
            .iter()
            .any(|change| change.rel == dir && change.action == ChangeAction::Renamed),
        "the moved directory itself is a Renamed row: {:?}",
        report.changes
    );
    for expected in moved_in_paths().into_iter().filter(|rel| *rel != dir) {
        assert!(
            report
                .changes
                .iter()
                .any(|change| change.rel == expected && change.action == ChangeAction::Added),
            "missing Added row for {expected:?}: {:?}",
            report.changes
        );
    }
}

#[test]
fn a_directory_moved_out_of_the_root_drops_its_known_subtree() {
    let nodes = [
        mft_node(5, 5, "root", DIRECTORY),
        mft_node(30, 5, "out", DIRECTORY),
        mft_node(31, 30, "child.txt", NORMAL),
        mft_node(77, 5, "outside", DIRECTORY),
    ];
    let seed = seeded(
        &nodes,
        &[
            (30, PathBuf::from("out")),
            (31, PathBuf::from("out").join("child.txt")),
        ],
        5,
    );
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    let entries = [entry(30, 77, "out", USN_REASON_RENAME_NEW_NAME, true)];
    let skipped = apply_entries(&seed, &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(skipped, 0);
    assert!(
        candidates.is_empty(),
        "moving a directory out must remove its descendants too: {:?}",
        rels(&candidates)
    );
    let report =
        changes_for_entries(&seed, &entries, SERIAL, JournalCursor::new(7, 500)).expect("map");
    for expected in [PathBuf::from("out"), PathBuf::from("out").join("child.txt")] {
        assert!(
            report
                .changes
                .iter()
                .any(|change| change.rel == expected && change.action == ChangeAction::Removed),
            "missing Removed row for {expected:?}: {:?}",
            report.changes
        );
    }
}

#[test]
fn extended_file_ids_are_unsupported() {
    let mut extended = entry(1, 5, "refs.txt", USN_REASON_FILE_CREATE, false);
    extended.fid = Fid::from_u128(1);
    assert_eq!(parsed_record(&extended), Err(SourceError::Unsupported));
}
