use super::*;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

struct TestDir(PathBuf);

impl TestDir {
    fn new(tag: &str) -> Self {
        static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ops-index-lock-{tag}-{}-{serial}",
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

#[test]
fn acquiring_creates_the_directory_and_lock_file() {
    let parent = TestDir::new("create");
    let directory = parent.path().join("cache");
    let lock = SnapshotLock::acquire(&directory).unwrap();
    assert_eq!(lock.directory(), directory.as_path());
    assert_eq!(lock.path(), directory.join(LOCK_FILE));
    assert!(lock.path().is_file());
}

#[test]
fn an_exclusive_lock_is_exclusive_within_one_process() {
    let directory = TestDir::new("exclusive");
    let first = SnapshotLock::try_acquire(directory.path()).unwrap();
    assert!(first.is_some());
    let second = SnapshotLock::try_acquire(directory.path()).unwrap();
    assert!(second.is_none(), "a second writer must not take the lock");
    drop(first);
    let third = SnapshotLock::try_acquire(directory.path()).unwrap();
    assert!(third.is_some(), "dropping the guard must release the lock");
}

#[test]
fn a_blocking_acquire_waits_for_the_current_writer() {
    let directory = TestDir::new("blocking");
    let held = SnapshotLock::acquire(directory.path()).unwrap();
    let (sender, receiver) = mpsc::channel();
    let path = directory.path().to_path_buf();
    let waiter = thread::spawn(move || {
        let lock = SnapshotLock::acquire(&path);
        sender.send(lock.is_ok()).unwrap();
        drop(lock);
    });
    assert!(
        receiver.recv_timeout(Duration::from_millis(150)).is_err(),
        "the second writer must block while the lock is held"
    );
    drop(held);
    assert!(receiver.recv_timeout(Duration::from_secs(5)).unwrap());
    waiter.join().unwrap();
}

#[test]
fn a_contended_try_acquire_reports_contention_not_io() {
    let directory = TestDir::new("contention");
    let first = SnapshotLock::try_acquire(directory.path()).unwrap();
    assert!(first.is_some());
    for _ in 0..5 {
        assert!(
            SnapshotLock::try_acquire(directory.path())
                .unwrap()
                .is_none()
        );
    }
    drop(first);
}

#[test]
fn the_lock_file_persists_after_release() {
    let directory = TestDir::new("persist");
    drop(SnapshotLock::acquire(directory.path()).unwrap());
    assert!(directory.path().join(LOCK_FILE).is_file());
    assert!(
        SnapshotLock::try_acquire(directory.path())
            .unwrap()
            .is_some()
    );
}

#[test]
fn a_blocked_lock_path_is_an_io_error() {
    let directory = TestDir::new("blocked");
    let blocker = directory.path().join("blocker");
    fs::write(&blocker, b"file").unwrap();
    let error = SnapshotLock::acquire(&blocker).unwrap_err();
    assert_eq!(error.code(), "INDEX_SNAPSHOT_LOCK_IO");
    assert!(error.to_string().contains("snapshot lock failed"));
    assert!(std::error::Error::source(&error).is_some());
}
