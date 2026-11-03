use std::ffi::OsString;
use std::path::Path;
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
    let batch = assemble(&nodes, &[], SERIAL, &generous_budget()).expect("assembly");
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
    let batch = assemble(
        &nodes,
        &[OsString::from("docs")],
        SERIAL,
        &generous_budget(),
    )
    .expect("assembly");
    assert_eq!(names(&batch), vec!["report.txt"]);
}

#[test]
fn assemble_matches_root_components_case_insensitively() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(10, 5, "Docs", DIRECTORY),
        node(11, 10, "report.txt", NORMAL),
    ];
    let batch = assemble(
        &nodes,
        &[OsString::from("docs")],
        SERIAL,
        &generous_budget(),
    )
    .expect("assembly");
    assert_eq!(names(&batch), vec!["report.txt"]);
}

#[test]
fn candidate_key_is_the_record_number_not_the_full_reference() {
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
    let batch = assemble(&nodes, &[], SERIAL, &generous_budget()).expect("assembly");
    let entry = batch
        .entries
        .iter()
        .find(|entry| entry.rel.as_path() == Path::new("file.txt"))
        .expect("file entry");
    assert_eq!(
        entry.key.file, 42,
        "only the 48-bit record number is exposed"
    );
    assert_eq!(entry.key.volume, 0, "W1 has no volume serial yet");
}

#[test]
fn assemble_classifies_entries_from_attributes() {
    let nodes = vec![
        node(5, 5, "root", DIRECTORY),
        node(10, 5, "docs", DIRECTORY),
        node(11, 5, "link", REPARSE_POINT),
        node(12, 5, "file.txt", NORMAL),
    ];
    let batch = assemble(&nodes, &[], SERIAL, &generous_budget()).expect("assembly");
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
    let batch = assemble(&nodes, &[], SERIAL, &budget).expect("assembly");
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
    let batch = assemble(&nodes, &[], SERIAL, &budget).expect("assembly");
    assert_eq!(batch.entries.len(), 2);
    assert!(batch.truncated);
}

#[test]
fn assemble_reports_an_expired_deadline() {
    let nodes = vec![node(5, 5, "root", DIRECTORY), node(10, 5, "a.txt", NORMAL)];
    let deadline = Instant::now() - Duration::from_millis(1);
    let budget = EnumBudget::new(100, 64, deadline);
    assert_eq!(
        assemble(&nodes, &[], SERIAL, &budget),
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
        assemble(&nodes, &[], SERIAL, &generous_budget()),
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
    let batch = assemble(&nodes, &[], SERIAL, &generous_budget()).expect("assembly");
    assert_eq!(names(&batch), vec!["first.txt"]);
}

#[test]
fn assemble_requires_a_volume_root() {
    let nodes = vec![node(10, 99, "orphan.txt", NORMAL)];
    assert_eq!(
        assemble(&nodes, &[], SERIAL, &generous_budget()),
        Err(SourceError::Unsupported)
    );
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
