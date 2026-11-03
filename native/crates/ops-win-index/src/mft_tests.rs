use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::*;

const NORMAL: u32 = 0;
const DIRECTORY: u32 = 0x10;
const REPARSE_POINT: u32 = 0x400;
const SERIAL: u64 = 0x5EA1;

fn node(fid: u64, parent: u64, name: &str, attributes: u32) -> MftNode {
    MftNode {
        fid: Fid::new(fid),
        parent: Fid::new(parent),
        name: OsString::from(name),
        attributes: FileAttributes::from_bits_retain(attributes),
    }
}

fn generous_budget() -> EnumBudget {
    EnumBudget::new(1_000_000, 64, Instant::now() + Duration::from_secs(30))
}

fn names(batch: &ColdBatch) -> Vec<String> {
    batch
        .entries
        .iter()
        .map(|entry| entry.rel.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn assemble_rebuilds_paths_from_parent_ids() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(10, 5, "docs", DIRECTORY),
        node(11, 10, "report.txt", NORMAL),
        node(12, 10, "nested", DIRECTORY),
        node(13, 12, "deep.md", NORMAL),
    ];
    let batch = assemble(&nodes, 5, SERIAL, &generous_budget()).expect("assembly");
    let mut got = names(&batch);
    got.sort();
    assert_eq!(
        got,
        vec![
            "docs",
            "docs\\nested",
            "docs\\nested\\deep.md",
            "docs\\report.txt",
        ]
    );
    assert!(!batch.truncated);
}

#[test]
fn assemble_roots_at_a_requested_subdirectory() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(10, 5, "docs", DIRECTORY),
        node(11, 10, "report.txt", NORMAL),
        node(12, 5, "other.txt", NORMAL),
    ];
    let batch = assemble(&nodes, 10, SERIAL, &generous_budget()).expect("assembly");
    assert_eq!(names(&batch), vec!["report.txt"]);
}

#[test]
fn subtree_paths_anchor_the_root_with_an_empty_path() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(10, 5, "docs", DIRECTORY),
        node(11, 10, "report.txt", NORMAL),
    ];
    let paths = subtree_paths(&nodes, 10).expect("paths");
    assert_eq!(paths.paths.get(&10), Some(&PathBuf::new()));
    assert_eq!(paths.paths.get(&11), Some(&PathBuf::from("report.txt")));
    assert!(!paths.paths.contains_key(&5));
}

#[test]
fn candidate_key_is_the_full_file_reference_and_volume_serial() {
    let full = Fid::from_parts(42, 7);
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        MftNode {
            fid: full,
            parent: Fid::new(5),
            name: OsString::from("file.txt"),
            attributes: FileAttributes::from_bits_retain(NORMAL),
        },
    ];
    let batch = assemble(&nodes, 5, SERIAL, &generous_budget()).expect("assembly");
    let entry = batch
        .entries
        .iter()
        .find(|entry| entry.rel.as_path() == Path::new("file.txt"))
        .expect("file entry");
    assert_eq!(
        entry.key.file,
        full.as_u64().expect("standard 64-bit id"),
        "the full nFileIndex is exposed, sequence included"
    );
    assert_eq!(entry.key.volume, SERIAL);
}

#[test]
fn assemble_classifies_entries_from_attributes() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(10, 5, "docs", DIRECTORY),
        node(11, 5, "link", REPARSE_POINT),
        node(12, 5, "file.txt", NORMAL),
    ];
    let batch = assemble(&nodes, 5, SERIAL, &generous_budget()).expect("assembly");
    let kind = |name: &str| {
        batch
            .entries
            .iter()
            .find(|entry| entry.rel.as_path() == Path::new(name))
            .expect("entry")
            .kind
    };
    assert_eq!(kind("docs"), EntryKind::Dir);
    assert_eq!(kind("link"), EntryKind::Link);
    assert_eq!(kind("file.txt"), EntryKind::File);
}

#[test]
fn assemble_prunes_at_max_depth_and_reports_truncation() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(10, 5, "docs", DIRECTORY),
        node(11, 10, "nested", DIRECTORY),
        node(12, 11, "deep.md", NORMAL),
    ];
    let budget = EnumBudget::new(100, 1, Instant::now() + Duration::from_secs(30));
    let batch = assemble(&nodes, 5, SERIAL, &budget).expect("assembly");
    assert_eq!(names(&batch), vec!["docs"]);
    assert!(
        batch.truncated,
        "children below the depth limit are missing"
    );
}

#[test]
fn assemble_stops_at_max_entries_and_reports_truncation() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(10, 5, "a.txt", NORMAL),
        node(11, 5, "b.txt", NORMAL),
        node(12, 5, "c.txt", NORMAL),
    ];
    let budget = EnumBudget::new(2, 64, Instant::now() + Duration::from_secs(30));
    let batch = assemble(&nodes, 5, SERIAL, &budget).expect("assembly");
    assert_eq!(batch.entries.len(), 2);
    assert!(batch.truncated);
}

#[test]
fn assemble_reports_an_expired_deadline() {
    let nodes = vec![node(5, 5, "root", DIRECTORY), node(10, 5, "a.txt", NORMAL)];
    let deadline = Instant::now() - Duration::from_millis(1);
    let budget = EnumBudget::new(100, 64, deadline);
    assert_eq!(
        assemble(&nodes, 5, SERIAL, &budget),
        Err(SourceError::Budget)
    );
}

#[test]
fn assemble_rejects_extended_file_ids() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        MftNode {
            fid: Fid::from_u128(0x1_0000_0000_0000_0001),
            parent: Fid::new(5),
            name: OsString::from("refs.txt"),
            attributes: FileAttributes::from_bits_retain(NORMAL),
        },
    ];
    assert_eq!(
        assemble(&nodes, 5, SERIAL, &generous_budget()),
        Err(SourceError::Unsupported)
    );
}

#[test]
fn assemble_collapses_duplicate_records_for_one_id() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(11, 5, "first.txt", NORMAL),
        node(11, 5, "alias.txt", NORMAL),
    ];
    let batch = assemble(&nodes, 5, SERIAL, &generous_budget()).expect("assembly");
    assert_eq!(names(&batch), vec!["first.txt"]);
}

#[test]
fn a_root_fid_outside_the_mft_yields_an_empty_batch() {
    let nodes = vec![node(10, 99, "orphan.txt", NORMAL)];
    let batch = assemble(&nodes, 5, SERIAL, &generous_budget()).expect("assembly");
    assert!(batch.entries.is_empty());
    assert!(!batch.truncated);
}

#[test]
fn permission_errors_map_to_the_unsupported_fallback() {
    assert_eq!(
        map_usn_error(UsnError::PermissionError),
        SourceError::Unsupported
    );
}

#[test]
fn io_errors_keep_their_kind() {
    let error = UsnError::IoError(std::io::Error::new(std::io::ErrorKind::NotFound, "missing"));
    assert_eq!(
        map_usn_error(error),
        SourceError::Io(std::io::ErrorKind::NotFound)
    );
}

#[test]
fn invalid_mount_points_are_unsupported() {
    assert_eq!(
        map_usn_error(UsnError::InvalidMountPointError("bad".into())),
        SourceError::Unsupported
    );
}

#[test]
fn the_whole_volume_node_cap_is_a_budget_error() {
    assert!(check_node_budget(MAX_MFT_NODES - 1).is_ok());
    assert_eq!(check_node_budget(MAX_MFT_NODES), Err(SourceError::Budget));
}
