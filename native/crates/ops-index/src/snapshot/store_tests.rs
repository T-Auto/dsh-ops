use super::*;
use crate::ids::{EntryId, NameId, VolumeId};
use crate::snapshot::format::{
    FormatError, HEADER_LEN, Snapshot, SnapshotHeader, SnapshotIdentity, SnapshotRecord,
};
use crate::source::EntryKind;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        let nonce = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "dsh-ops-snapshot-{label}-{}-{nanos}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp directory");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn store(dir: &TempDir) -> SnapshotStore {
    SnapshotStore::new(dir.path())
}

fn header(generation: u64) -> SnapshotHeader {
    SnapshotHeader {
        identity: SnapshotIdentity {
            volume_id: VolumeId::new(9),
            root_dev: 10,
            root_ino: 11,
        },
        generation,
        consistent_at_ms: 12,
    }
}

fn snapshot(generation: u64, tag: &[u8]) -> Snapshot {
    let names = vec![b"root".to_vec(), tag.to_vec(), b"child.txt".to_vec()];
    let records = vec![
        SnapshotRecord::new(EntryId::NIL, NameId::new(0), EntryKind::Dir, 0, Some(1)),
        SnapshotRecord::new(
            EntryId::new(0),
            NameId::new(1),
            EntryKind::File,
            12,
            Some(2),
        ),
        SnapshotRecord::new(EntryId::new(0), NameId::new(2), EntryKind::Dir, 0, None),
    ];
    Snapshot::new(header(generation), records, names).expect("sample snapshot is valid")
}

fn loaded(store: &SnapshotStore) -> Snapshot {
    match store.load().expect("load succeeds") {
        LoadOutcome::Loaded(snapshot) => snapshot,
        other => panic!("expected a loaded snapshot, got {other:?}"),
    }
}

#[test]
fn store_paths_are_fixed_inside_the_cache_directory() {
    let dir = TempDir::new("paths");
    let store = store(&dir);
    assert_eq!(store.dir(), dir.path());
    assert_eq!(store.path(), dir.path().join("snapshot.bin"));
    assert_eq!(store.temp_path(), dir.path().join("snapshot.bin.tmp"));
    assert_eq!(SNAPSHOT_FILE_NAME, "snapshot.bin");
    assert_eq!(SNAPSHOT_TEMP_FILE_NAME, "snapshot.bin.tmp");
}

#[test]
fn a_missing_snapshot_is_an_ordinary_outcome() {
    let dir = TempDir::new("missing");
    let store = store(&dir);
    assert!(matches!(
        store.load().expect("load succeeds"),
        LoadOutcome::Missing
    ));
    assert!(!store.cleanup_temp().expect("cleanup succeeds"));
    assert!(
        store
            .load()
            .expect("load succeeds")
            .into_snapshot()
            .is_none()
    );
}

#[test]
fn round_trip_saves_and_loads_one_snapshot() {
    let dir = TempDir::new("round-trip");
    let store = store(&dir);
    let snapshot = snapshot(3, b"alpha");

    store.save(&snapshot).expect("save succeeds");
    assert!(store.path().is_file());
    assert!(!store.temp_path().exists());
    assert_eq!(loaded(&store), snapshot);
    assert_eq!(loaded(&store), snapshot);
}

#[test]
fn save_creates_a_missing_cache_directory() {
    let dir = TempDir::new("create-dir");
    let cache = dir.path().join("a/b/c");
    let store = SnapshotStore::new(cache);
    let snapshot = snapshot(1, b"created");
    store.save(&snapshot).expect("save creates the directory");
    assert!(store.dir().is_dir());
    assert_eq!(loaded(&store), snapshot);
}

#[test]
fn a_later_save_replaces_the_previous_snapshot() {
    let dir = TempDir::new("replace");
    let store = store(&dir);
    let first = snapshot(1, b"first");
    let second = snapshot(2, b"second");

    store.save(&first).expect("first save");
    store.save(&second).expect("second save");

    assert_eq!(loaded(&store), second);
    assert_ne!(loaded(&store), first);
}

#[test]
fn repeated_saves_keep_loadable_snapshots() {
    let dir = TempDir::new("repeated");
    let store = store(&dir);
    for generation in 0..20u64 {
        let snapshot = snapshot(generation, &[b'a'.wrapping_add(generation as u8)]);
        store.save(&snapshot).expect("save succeeds");
        assert_eq!(loaded(&store), snapshot);
    }
}

#[test]
fn leftover_temporary_file_is_ignored_and_cleaned_explicitly() {
    let dir = TempDir::new("leftover");
    let store = store(&dir);
    let snapshot = snapshot(4, b"kept");
    store.save(&snapshot).expect("save succeeds");

    fs::write(store.temp_path(), b"partial bytes from a crashed writer")
        .expect("write crash residue");
    assert_eq!(loaded(&store), snapshot);
    assert!(
        store.temp_path().is_file(),
        "load must not delete the writer temp file"
    );
    assert!(store.cleanup_temp().expect("cleanup succeeds"));
    assert!(!store.temp_path().exists());
    assert!(!store.cleanup_temp().expect("cleanup succeeds"));
    assert_eq!(loaded(&store), snapshot);
}

#[test]
fn next_save_overwrites_a_leftover_temporary_file() {
    let dir = TempDir::new("overwrite-temp");
    let store = store(&dir);
    let first = snapshot(5, b"first");
    let second = snapshot(6, b"second");

    store.save(&first).expect("first save");
    fs::write(store.temp_path(), b"stale temp").expect("write stale temp");
    store.save(&second).expect("second save");

    assert_eq!(loaded(&store), second);
    assert!(!store.temp_path().exists());
}

#[test]
fn corrupt_snapshot_is_discarded_and_can_be_rebuilt() {
    let dir = TempDir::new("corrupt");
    let store = store(&dir);
    let original = snapshot(7, b"original");
    store.save(&original).expect("save succeeds");

    let mut bytes = fs::read(store.path()).expect("read snapshot");
    bytes[HEADER_LEN + 3] ^= 0xFF;
    fs::write(store.path(), &bytes).expect("write corrupt snapshot");

    match store.load().expect("load succeeds") {
        LoadOutcome::Discarded(error) => {
            assert!(matches!(error, FormatError::BadCrc { .. }));
        }
        other => panic!("expected a discarded snapshot, got {other:?}"),
    }
    assert!(
        store.path().is_file(),
        "load leaves the rejected file for the writer to replace"
    );

    let rebuilt = snapshot(8, b"rebuilt");
    store.save(&rebuilt).expect("rebuild save succeeds");
    assert_eq!(loaded(&store), rebuilt);
}

#[test]
fn truncated_snapshot_is_discarded_and_can_be_rebuilt() {
    let dir = TempDir::new("truncated");
    let store = store(&dir);
    let original = snapshot(9, b"original");
    store.save(&original).expect("save succeeds");

    let bytes = fs::read(store.path()).expect("read snapshot");
    fs::write(store.path(), &bytes[..bytes.len() / 2]).expect("truncate snapshot");

    match store.load().expect("load succeeds") {
        LoadOutcome::Discarded(error) => {
            assert!(matches!(error, FormatError::Truncated { .. }));
        }
        other => panic!("expected a discarded snapshot, got {other:?}"),
    }

    let rebuilt = snapshot(10, b"rebuilt");
    store.save(&rebuilt).expect("rebuild save succeeds");
    assert_eq!(loaded(&store), rebuilt);
}

#[test]
fn version_mismatch_is_discarded_and_can_be_rebuilt() {
    let dir = TempDir::new("version");
    let store = store(&dir);
    let original = snapshot(11, b"original");
    store.save(&original).expect("save succeeds");

    let mut bytes = fs::read(store.path()).expect("read snapshot");
    // Header layout: magic[8], then the little-endian version at offset 8.
    bytes[8..12].copy_from_slice(&2u32.to_le_bytes());
    fs::write(store.path(), &bytes).expect("write future version");

    match store.load().expect("load succeeds") {
        LoadOutcome::Discarded(error) => {
            assert_eq!(error, FormatError::UnsupportedVersion { found: 2 });
        }
        other => panic!("expected a discarded snapshot, got {other:?}"),
    }

    store.save(&original).expect("rewrite succeeds");
    assert_eq!(loaded(&store), original);
}

#[test]
fn save_reports_an_io_failure_and_a_stable_code() {
    let dir = TempDir::new("io-failure");
    let blocker = dir.path().join("blocker");
    fs::write(&blocker, b"not a directory").expect("write blocker");
    let store = SnapshotStore::new(blocker.join("cache"));

    let error = store
        .save(&snapshot(12, b"blocked"))
        .expect_err("save fails");
    assert!(matches!(error, StoreError::Io { .. }));
    assert_eq!(error.code(), "INDEX_SNAPSHOT_IO");
    assert!(!error.to_string().is_empty());
}

#[test]
fn store_errors_expose_codes_sources_and_messages() {
    let format = StoreError::Format(FormatError::BadMagic);
    assert_eq!(format.code(), "INDEX_SNAPSHOT_FORMAT");
    assert!(format.to_string().contains("magic"));
    assert!(std::error::Error::source(&format).is_some());

    let io = StoreError::Io {
        action: "read the snapshot",
        kind: ErrorKind::PermissionDenied,
    };
    assert_eq!(io.code(), "INDEX_SNAPSHOT_IO");
    assert!(io.to_string().contains("read the snapshot"));
    assert!(std::error::Error::source(&io).is_none());

    let converted: StoreError = FormatError::BadMagic.into();
    assert_eq!(converted, format);
}

#[test]
fn a_many_record_snapshot_round_trips_through_the_store() {
    let dir = TempDir::new("many");
    let store = store(&dir);
    let count = 2000u32;
    let names: Vec<Vec<u8>> = (0..count)
        .map(|index| format!("name-{index}").into_bytes())
        .collect();
    let records: Vec<SnapshotRecord> = (0..count)
        .map(|index| {
            let parent = if index == 0 {
                EntryId::NIL
            } else {
                EntryId::new(0)
            };
            SnapshotRecord::new(
                parent,
                NameId::new(index),
                EntryKind::File,
                u64::from(index),
                Some(i64::from(index)),
            )
        })
        .collect();
    let snapshot =
        Snapshot::new(header(20), records, names.clone()).expect("large snapshot is valid");

    store.save(&snapshot).expect("save succeeds");
    assert_eq!(loaded(&store), snapshot);

    let names_bytes: usize = names.iter().map(|name| 4 + name.len()).sum();
    let expected = HEADER_LEN + count as usize * 26 + names_bytes;
    assert_eq!(
        usize::try_from(fs::metadata(store.path()).expect("metadata").len()).expect("fits usize"),
        expected
    );
}
