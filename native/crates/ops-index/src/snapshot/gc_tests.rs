use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

struct TestDir(PathBuf);

impl TestDir {
    fn new(tag: &str) -> Self {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ops-index-gc-{tag}-{}-{serial}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn publish(directory: &Path, bytes: usize) -> u64 {
    let path = directory.join(SNAPSHOT_FILE);
    fs::write(&path, vec![0x5A; bytes]).unwrap();
    bytes as u64
}

fn residue(directory: &Path, serial: u64, bytes: usize) -> PathBuf {
    let path = directory.join(format!("{SNAPSHOT_FILE}.tmp.4242.{serial}"));
    fs::write(&path, vec![0xA5; bytes]).unwrap();
    path
}

#[test]
fn collecting_a_missing_directory_is_a_no_op() {
    let missing = std::env::temp_dir().join("ops-index-gc-does-not-exist");
    let _ = fs::remove_dir_all(&missing);
    assert_eq!(
        collect(&missing, MAX_SNAPSHOT_BYTES).unwrap(),
        GcReport::default()
    );
    assert_eq!(remove_all(&missing).unwrap(), GcReport::default());
}

#[test]
fn collecting_removes_crash_residue_and_keeps_the_published_image() {
    let directory = TestDir::new("residue");
    publish(directory.path(), 64);
    residue(directory.path(), 0, 10);
    residue(directory.path(), 1, 20);
    let report = collect(directory.path(), MAX_SNAPSHOT_BYTES).unwrap();
    assert_eq!(report.removed_temporary, 2);
    assert_eq!(report.removed_published, 0);
    assert_eq!(report.bytes_reclaimed, 30);
    assert!(directory.path().join(SNAPSHOT_FILE).is_file());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn a_published_image_over_the_cap_is_removed() {
    let directory = TestDir::new("cap");
    publish(directory.path(), 100);
    let report = collect(directory.path(), 99).unwrap();
    assert_eq!(report.removed_published, 1);
    assert_eq!(report.bytes_reclaimed, 100);
    assert!(!directory.path().join(SNAPSHOT_FILE).exists());
}

#[test]
fn a_published_image_at_the_cap_is_kept() {
    let directory = TestDir::new("cap-equal");
    publish(directory.path(), 100);
    let report = collect(directory.path(), 100).unwrap();
    assert_eq!(report, GcReport::default());
    assert!(directory.path().join(SNAPSHOT_FILE).is_file());
}

#[test]
fn unrelated_files_and_directories_are_never_touched() {
    let directory = TestDir::new("unrelated");
    publish(directory.path(), 8);
    fs::write(directory.path().join("notes.txt"), b"keep me").unwrap();
    let nested = directory.path().join(format!("{SNAPSHOT_FILE}.tmp.dir"));
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("inside"), b"x").unwrap();
    let report = collect(directory.path(), MAX_SNAPSHOT_BYTES).unwrap();
    assert_eq!(report, GcReport::default());
    assert!(directory.path().join("notes.txt").is_file());
    assert!(nested.join("inside").is_file());
}

#[test]
fn collection_can_take_the_writer_lock_as_its_proof() {
    let directory = TestDir::new("locked");
    let lock = SnapshotLock::acquire(directory.path()).unwrap();
    residue(directory.path(), 0, 3);
    let report = collect_locked(&lock, MAX_SNAPSHOT_BYTES).unwrap();
    assert_eq!(report.removed_temporary, 1);
    assert_eq!(report.bytes_reclaimed, 3);
}

#[test]
fn remove_all_clears_the_store_and_the_directory() {
    let directory = TestDir::new("remove-all");
    publish(directory.path(), 32);
    residue(directory.path(), 0, 4);
    let lock = SnapshotLock::acquire(directory.path()).unwrap();
    drop(lock);
    let report = remove_all(directory.path()).unwrap();
    assert_eq!(report.removed_published, 1);
    assert_eq!(report.removed_temporary, 1);
    assert!(report.removed_lock);
    assert_eq!(report.bytes_reclaimed, 36);
    assert!(
        !directory.path().exists(),
        "an emptied store directory is removed"
    );
}

#[test]
fn remove_all_leaves_a_directory_that_still_has_foreign_files() {
    let directory = TestDir::new("remove-foreign");
    publish(directory.path(), 8);
    fs::write(directory.path().join("notes.txt"), b"not ours").unwrap();
    let report = remove_all(directory.path()).unwrap();
    assert_eq!(report.removed_published, 1);
    assert!(directory.path().join("notes.txt").is_file());
    assert!(!directory.path().join(SNAPSHOT_FILE).exists());
}

#[test]
fn report_counts_every_removed_file() {
    let report = GcReport {
        removed_temporary: 2,
        removed_published: 1,
        removed_lock: true,
        bytes_reclaimed: 9,
    };
    assert_eq!(report.removed_files(), 4);
    assert_eq!(GcReport::default().removed_files(), 0);
}

#[test]
fn temporary_names_are_derived_from_the_published_name() {
    assert!(is_temporary("index.snapshot.tmp.4242.0"));
    assert!(is_temporary("index.snapshot.tmp.1.2"));
    assert!(!is_temporary("index.snapshot"));
    assert!(!is_temporary("index.snapshot.bak"));
    assert!(!is_temporary("other.tmp.1.0"));
}

#[test]
fn gc_errors_carry_a_stable_code() {
    let error = GcError::Io(std::io::Error::other("boom"));
    assert_eq!(error.code(), "INDEX_SNAPSHOT_GC_IO");
    assert!(error.to_string().contains("snapshot cleanup failed"));
    assert!(std::error::Error::source(&error).is_some());
}
