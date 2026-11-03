use super::*;
use crate::ids::{FileKey, RecordId, VolumeId};
use crate::snapshot::format::{self, RecordFlags, SnapshotRecord};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

struct TestDir(PathBuf);

impl TestDir {
    fn new(tag: &str) -> Self {
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ops-index-snapshot-{tag}-{}-{serial}",
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

fn surrogate_name() -> Vec<u8> {
    // WTF-8 for [0x0061, 0xD800, 0x0062], hard-coded so this slice is independent of P1.
    vec![0x61, 0xED, 0xA0, 0x80, 0x62]
}

fn snapshot(generation: u64) -> Snapshot {
    let surrogate = surrogate_name();
    Snapshot {
        volume: VolumeId::new(7),
        root: FileKey::new(3, 4),
        generation,
        names: vec![b"docs".to_vec(), surrogate],
        records: vec![
            SnapshotRecord {
                record: RecordId::new(11),
                parent: format::PARENT_NIL,
                name: 0,
                flags: RecordFlags::DIR,
                size: None,
                mtime_ns: Some(1),
            },
            SnapshotRecord {
                record: RecordId::new(12),
                parent: 0,
                name: 1,
                flags: RecordFlags::NON_UNICODE_NAME,
                size: Some(42),
                mtime_ns: None,
            },
        ],
    }
}

fn listing(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_missing_store_has_no_snapshot() {
    let directory = TestDir::new("missing");
    let store = SnapshotStore::new(directory.path());
    assert_eq!(store.load().unwrap(), None);
    assert_eq!(store.directory(), directory.path());
    assert_eq!(store.path(), directory.path().join(SNAPSHOT_FILE));
}

#[test]
fn save_then_load_round_trips_every_field() {
    let directory = TestDir::new("roundtrip");
    let store = SnapshotStore::new(directory.path());
    let expected = snapshot(5);
    store.save(&expected).unwrap();
    assert_eq!(store.load().unwrap(), Some(expected));
}

#[test]
fn save_creates_the_directory() {
    let directory = TestDir::new("create");
    let store = SnapshotStore::new(directory.path().join("nested").join("cache"));
    store.save(&snapshot(1)).unwrap();
    assert!(store.path().is_file());
}

#[test]
fn a_second_save_replaces_the_previous_image() {
    let directory = TestDir::new("replace");
    let store = SnapshotStore::new(directory.path());
    store.save(&snapshot(1)).unwrap();
    store.save(&snapshot(2)).unwrap();
    assert_eq!(store.load().unwrap().unwrap().generation, 2);
}

#[test]
fn a_temporary_file_does_not_hide_the_published_image() {
    let directory = TestDir::new("temporary");
    let store = SnapshotStore::new(directory.path());
    store.save(&snapshot(1)).unwrap();
    let next = format::encode(&snapshot(2)).unwrap();
    let temporary = store.write_temporary(&next).unwrap();
    assert_eq!(
        store.load().unwrap().unwrap().generation,
        1,
        "a reader must see the old complete image while the new one is private"
    );
    store.commit(&temporary).unwrap();
    assert_eq!(store.load().unwrap().unwrap().generation, 2);
    assert!(!temporary.exists(), "the commit renamed the temporary file");
}

#[test]
fn load_never_deletes_temporary_files() {
    let directory = TestDir::new("keep-temporary");
    let store = SnapshotStore::new(directory.path());
    store.save(&snapshot(1)).unwrap();
    let temporary = store
        .write_temporary(&format::encode(&snapshot(2)).unwrap())
        .unwrap();
    store.load().unwrap();
    assert!(
        temporary.exists(),
        "temporary files belong to their writer, not to a reader"
    );
    assert!(
        listing(directory.path()).contains(
            &temporary
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );
}

#[test]
fn a_successful_save_leaves_only_the_published_file() {
    let directory = TestDir::new("clean-temporary");
    let store = SnapshotStore::new(directory.path());
    store.save(&snapshot(1)).unwrap();
    assert_eq!(listing(directory.path()), vec![SNAPSHOT_FILE.to_owned()]);
}

#[test]
fn a_failed_save_removes_its_temporary_file() {
    let directory = TestDir::new("failed-save");
    let store = SnapshotStore::new(directory.path());
    // Make the publish path a directory: rename(2) onto a non-empty directory
    // must fail, and save must clean up the temporary file it created.
    fs::create_dir_all(store.path()).unwrap();
    fs::write(store.path().join("occupied"), b"x").unwrap();
    assert!(matches!(store.save(&snapshot(1)), Err(StoreError::Io(_))));
    let names = listing(directory.path());
    assert_eq!(
        names,
        vec![SNAPSHOT_FILE.to_owned()],
        "no temporary file leaked"
    );
}

#[test]
fn a_write_failure_leaves_no_temporary_file() {
    let directory = TestDir::new("write-failure");
    let store = SnapshotStore::new(directory.path());
    super::FAIL_AFTER_CREATE.store(true, Ordering::Relaxed);
    let error = store.save(&snapshot(1)).unwrap_err();
    super::FAIL_AFTER_CREATE.store(false, Ordering::Relaxed);
    assert_eq!(error.code(), "INDEX_SNAPSHOT_IO");
    assert_eq!(
        listing(directory.path()),
        Vec::<String>::new(),
        "a partial temporary file must not survive a failed write"
    );
    assert!(!store.path().exists(), "nothing was published");
}

#[test]
fn an_oversized_image_is_rejected_before_decoding() {
    let directory = TestDir::new("too-large");
    let store = SnapshotStore::new(directory.path());
    store.save(&snapshot(1)).unwrap();
    let size = fs::metadata(store.path()).unwrap().len();
    let error = store.load_with_limit(size - 1).unwrap_err();
    assert_eq!(error.code(), "INDEX_SNAPSHOT_TOO_LARGE");
    match &error {
        StoreError::TooLarge { size: found, max } => {
            assert_eq!(*found, size);
            assert_eq!(*max, size - 1);
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
    assert!(error.to_string().contains("above the"));
    // The exact cap is still accepted.
    assert!(store.load_with_limit(size).unwrap().is_some());
}

#[test]
fn a_corrupt_image_is_reported_not_ignored() {
    let directory = TestDir::new("corrupt");
    let store = SnapshotStore::new(directory.path());
    fs::write(store.path(), vec![b'x'; 100]).unwrap();
    let error = store.load().unwrap_err();
    assert_eq!(error.code(), "INDEX_SNAPSHOT_CORRUPT");
    assert!(matches!(
        error.corrupt(),
        Some(format::SnapshotError::BadMagic)
    ));
}

#[test]
fn a_truncated_image_is_reported_as_corrupt() {
    let directory = TestDir::new("truncated");
    let store = SnapshotStore::new(directory.path());
    let image = format::encode(&snapshot(1)).unwrap();
    fs::write(store.path(), &image[..10]).unwrap();
    let error = store.load().unwrap_err();
    assert!(matches!(
        error.corrupt(),
        Some(format::SnapshotError::Truncated { .. })
    ));
}

#[test]
fn a_rejected_image_is_never_repaired_in_place() {
    let directory = TestDir::new("no-repair");
    let store = SnapshotStore::new(directory.path());
    fs::write(store.path(), b"garbage").unwrap();
    let _ = store.load().unwrap_err();
    assert_eq!(fs::read(store.path()).unwrap(), b"garbage");
}

#[test]
fn unpaired_surrogate_names_survive_the_round_trip() {
    let directory = TestDir::new("surrogate");
    let store = SnapshotStore::new(directory.path());
    store.save(&snapshot(3)).unwrap();
    let loaded = store.load().unwrap().unwrap();
    assert_eq!(loaded.names[1], surrogate_name());
    assert_eq!(loaded.records[1].flags, RecordFlags::NON_UNICODE_NAME);
}

#[test]
fn saving_into_a_path_that_is_a_file_is_an_io_error() {
    let directory = TestDir::new("blocked");
    let blocker = directory.path().join("blocker");
    fs::write(&blocker, b"not a directory").unwrap();
    let store = SnapshotStore::new(&blocker);
    let error = store.save(&snapshot(1)).unwrap_err();
    assert_eq!(error.code(), "INDEX_SNAPSHOT_IO");
    assert!(error.to_string().contains("snapshot store I/O failed"));
}

#[test]
fn two_stores_over_one_directory_do_not_share_state() {
    let directory = TestDir::new("two-stores");
    let first = SnapshotStore::new(directory.path());
    let second = SnapshotStore::new(directory.path());
    first.save(&snapshot(1)).unwrap();
    second.save(&snapshot(9)).unwrap();
    assert_eq!(first.load().unwrap().unwrap().generation, 9);
    assert_eq!(second.load().unwrap().unwrap().generation, 9);
}

#[test]
fn store_error_codes_and_sources_are_stable() {
    let corrupt = StoreError::Corrupt(format::SnapshotError::BadMagic);
    assert_eq!(corrupt.code(), "INDEX_SNAPSHOT_CORRUPT");
    assert!(std::error::Error::source(&corrupt).is_some());
    assert!(corrupt.to_string().contains("corrupt"));
    let io = StoreError::Io(std::io::Error::other("boom"));
    assert_eq!(io.code(), "INDEX_SNAPSHOT_IO");
    assert!(io.corrupt().is_none());
    assert!(std::error::Error::source(&io).is_some());
    let too_large = StoreError::TooLarge { size: 9, max: 8 };
    assert_eq!(too_large.code(), "INDEX_SNAPSHOT_TOO_LARGE");
    assert!(too_large.corrupt().is_none());
    assert!(std::error::Error::source(&too_large).is_none());
}
