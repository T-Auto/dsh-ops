use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use ops_index::usn::{
    USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE, USN_REASON_HARD_LINK_CHANGE,
    USN_REASON_RENAME_NEW_NAME, USN_REASON_RENAME_OLD_NAME,
};
use ops_index::{ChangeAction, EntryKind, FileKey, SourceError};
use usn_journal_rs::{Fid, FileAttributes, Filetime, Usn, UsnReason, UsnSourceInfo};

use super::*;

const SERIAL: u64 = 0x5EA1;

fn seed() -> SubtreePaths {
    let mut paths = HashMap::new();
    paths.insert(5, PathBuf::new());
    paths.insert(10, PathBuf::from("docs"));
    let mut known = HashSet::new();
    known.insert(5);
    known.insert(10);
    // A file that lives on the same volume but outside the requested root.
    known.insert(77);
    SubtreePaths { paths, known }
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
        file_attributes: FileAttributes::from_bits_retain(if is_dir { 0x10 } else { 0 }),
    }
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
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    let entries = [
        entry(20, 5, "newdocs", USN_REASON_FILE_CREATE, true),
        entry(21, 20, "a.txt", USN_REASON_FILE_CREATE, false),
        entry(22, 10, "old.txt", USN_REASON_RENAME_NEW_NAME, false),
        entry(23, 10, "dead.txt", USN_REASON_FILE_DELETE, false),
    ];
    let skipped = apply_entries(&seed(), &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(skipped, 0);
    let dir = candidates
        .get(&FileKey::new(SERIAL, 20))
        .expect("created directory");
    assert_eq!(dir.rel, PathBuf::from("newdocs"));
    assert_eq!(dir.kind, EntryKind::Dir);
    let file = candidates
        .get(&FileKey::new(SERIAL, 21))
        .expect("created file");
    assert_eq!(file.rel, PathBuf::from("newdocs").join("a.txt"));
    assert_eq!(file.kind, EntryKind::File);
    assert!(candidates.contains_key(&FileKey::new(SERIAL, 22)));
    assert!(!candidates.contains_key(&FileKey::new(SERIAL, 23)));
}

#[test]
fn records_outside_the_requested_root_are_ignored_not_skipped() {
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    let entries = [entry(
        99,
        77,
        "elsewhere.txt",
        USN_REASON_FILE_CREATE,
        false,
    )];
    let skipped = apply_entries(&seed(), &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(
        skipped, 0,
        "an existing parent outside the root is not a defect"
    );
    assert!(candidates.is_empty());
}

#[test]
fn a_dangling_parent_is_counted_as_skipped() {
    let mut candidates: HashMap<FileKey, Candidate> = HashMap::new();
    let entries = [entry(98, 999, "orphan.txt", USN_REASON_FILE_CREATE, false)];
    let skipped = apply_entries(&seed(), &mut candidates, &entries, SERIAL).expect("apply");
    assert_eq!(skipped, 1, "a parent missing from the MFT is never guessed");
    assert!(candidates.is_empty());
}

#[test]
fn a_dangling_parent_marks_the_change_report_as_skipped() {
    let entries = [entry(97, 999, "orphan.txt", USN_REASON_FILE_CREATE, false)];
    let report =
        changes_for_entries(&seed(), &entries, SERIAL, JournalCursor::new(7, 500)).expect("map");
    assert_eq!(report.skipped, 1);
    assert!(report.changes.is_empty());
}

#[test]
fn changes_map_reason_classes_to_actions() {
    let entries = [
        entry(30, 10, "added.txt", USN_REASON_FILE_CREATE, false),
        entry(31, 10, "renamed.txt", USN_REASON_RENAME_NEW_NAME, false),
        entry(32, 10, "dead.txt", USN_REASON_FILE_DELETE, false),
        entry(33, 10, "linked.txt", USN_REASON_HARD_LINK_CHANGE, false),
        entry(34, 10, "old-name.txt", USN_REASON_RENAME_OLD_NAME, false),
    ];
    let mut seed = seed();
    seed.paths
        .insert(33, PathBuf::from("docs").join("linked.txt"));
    seed.known.insert(33);
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

#[test]
fn extended_file_ids_are_unsupported() {
    let mut extended = entry(1, 5, "refs.txt", USN_REASON_FILE_CREATE, false);
    extended.fid = Fid::from_u128(1);
    assert_eq!(parsed_record(&extended), Err(SourceError::Unsupported));
}
