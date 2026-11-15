use super::*;
use std::sync::{Arc, Condvar, Mutex};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ops-search-open-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        for index in 0..40 {
            fs::write(
                root.join(format!("f{index:03}.txt")),
                format!("hit {index}\n"),
            )
            .unwrap();
        }
        Self(root)
    }
    fn request(&self) -> Request {
        serde_json::from_value(json!({"root":self.0,"scope":"open-test","tool":"grep","args":{}}))
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn collect(scan: &mut Scan, root: &Path, request: &Request) -> Vec<(PathBuf, Vec<u8>)> {
    let mut rows = Vec::new();
    scan.walk(root, &[], request, |path, _, scan| {
        if let Some(bytes) = scan.read(path) {
            rows.push((path.to_owned(), bytes));
        }
        Ok(())
    })
    .unwrap();
    rows
}

#[test]
fn exact_content_walk_opens_a_bounded_window_concurrently_and_preserves_order() {
    let fixture = Fixture::new();
    let gate = Arc::new((Mutex::new((0usize, false)), Condvar::new()));
    let witness = gate.clone();
    let mut scan = Scan::new();
    scan.preopen_reads = true;
    scan.open_hook = Some(Arc::new(move |_| {
        let (mutex, changed) = &*witness;
        let mut state = mutex.lock().unwrap();
        state.0 += 1;
        changed.notify_all();
        while !state.1 {
            state = changed.wait(state).unwrap();
        }
    }));
    let (held, rows, scan) = std::thread::scope(|scope| {
        let root = &fixture.0;
        let work = scope.spawn(move || {
            let request = serde_json::from_value(
                json!({"root":root,"scope":"open-test","tool":"grep","args":{}}),
            )
            .unwrap();
            let rows = collect(&mut scan, root, &request);
            (rows, scan)
        });
        let (mutex, changed) = &*gate;
        let state = mutex.lock().unwrap();
        let (mut state, _) = changed
            .wait_timeout_while(state, Duration::from_secs(5), |state| {
                state.0 < crate::scan_open::WORKERS
            })
            .unwrap();
        let held = state.0;
        // Release before asserting so the old serial implementation cannot deadlock.
        state.1 = true;
        changed.notify_all();
        drop(state);
        let (rows, scan) = work.join().unwrap();
        (held, rows, scan)
    });
    assert_eq!(
        held,
        crate::scan_open::WORKERS,
        "the checked opens must overlap, with a fixed concurrency bound"
    );
    let mut serial = Scan::new();
    let expected = collect(&mut serial, &fixture.0, &fixture.request());
    assert_eq!(rows, expected);
    assert_eq!(scan.scanned, serial.scanned);
    assert_eq!(scan.bytes, serial.bytes);
    assert_eq!(scan.hash.clone().finalize(), serial.hash.finalize());
    assert!(scan.complete());
    assert!(scan.preopened.is_empty());
}

#[test]
fn preopens_keep_exclusions_file_and_byte_budgets_identical() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("private")).unwrap();
    fs::write(fixture.0.join("private/secret.txt"), "secret").unwrap();
    fs::write(fixture.0.join(".hidden"), "hidden").unwrap();
    let mut request = fixture.request();
    request.deny_roots = vec![fixture.0.join("private").to_string_lossy().into_owned()];
    for (files, bytes) in [(5, 0), (100, MAX_SCAN_BYTES - 8), (100, 0)] {
        let mut serial = Scan::new();
        serial.max_files = files;
        serial.bytes = bytes;
        let expected = collect(&mut serial, &fixture.0, &request);
        let mut parallel = Scan::new();
        parallel.preopen_reads = true;
        parallel.max_files = files;
        parallel.bytes = bytes;
        assert_eq!(collect(&mut parallel, &fixture.0, &request), expected);
        assert_eq!(parallel.scanned, serial.scanned);
        assert_eq!(parallel.bytes, serial.bytes);
        assert_eq!(parallel.stopped, serial.stopped);
        assert_eq!(parallel.reasons, serial.reasons);
        assert_eq!(parallel.hash.clone().finalize(), serial.hash.finalize());
        assert!(parallel.preopened.is_empty());
    }
}

#[test]
fn expired_scan_never_starts_a_read_ahead_open() {
    let fixture = Fixture::new();
    let mut scan = Scan::new();
    scan.preopen_reads = true;
    scan.timeout = Duration::ZERO;
    scan.open_hook = Some(Arc::new(|_| panic!("expired scan opened a file")));
    scan.metadata_hook = Some(Arc::new(|_| panic!("expired scan observed an entry")));
    assert!(collect(&mut scan, &fixture.0, &fixture.request()).is_empty());
    assert_eq!(scan.stopped, Some(TruncatedBy::Time));
    assert!(scan.preopened.is_empty());
}

#[test]
fn filtered_paths_are_not_preopened_and_callback_failure_closes_the_window() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join(".hidden.txt"), "hidden").unwrap();
    let mut request = fixture.request();
    request.deny_roots = vec![fixture.0.join("f001.txt").to_string_lossy().into_owned()];
    let opened = Arc::new(Mutex::new(Vec::new()));
    let observer = opened.clone();
    let mut scan = Scan::new();
    scan.preopen_reads = true;
    scan.open_hook = Some(Arc::new(move |path| {
        observer.lock().unwrap().push(path.to_owned())
    }));
    let result = scan.walk(&fixture.0, &["f00*.txt".into()], &request, |_, _, scan| {
        assert!(scan.preopened.len() <= crate::scan_open::WINDOW);
        Err(Failure::new(
            "TEST_STOP",
            "stop without consuming prefetched handles",
        ))
    });
    assert_eq!(result.unwrap_err().code, "TEST_STOP");
    assert!(
        scan.preopened.is_empty(),
        "errors must release every read-ahead handle"
    );
    let names: Vec<_> = opened
        .lock()
        .unwrap()
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(!names.is_empty());
    assert!(
        names
            .iter()
            .all(|name| name.starts_with("f00") && name != "f001.txt")
    );
}

#[test]
fn a_failed_checked_open_is_reported_as_a_scan_gap() {
    let fixture = Fixture::new();
    let removed = fixture.0.join("f000.txt");
    let mut scan = Scan::new();
    scan.preopen_reads = true;
    scan.open_hook = Some(Arc::new(move |path| {
        if path == removed {
            fs::remove_file(path).unwrap();
        }
    }));
    let rows = collect(&mut scan, &fixture.0, &fixture.request());
    assert_eq!(rows.len(), 39);
    assert!(!scan.complete());
    assert_eq!(scan.reasons["read-error"], 1);
    assert_eq!(scan.failed, 1);
    assert!(scan.preopened.is_empty());
}

#[test]
fn read_ahead_metadata_queries_overlap_without_changing_the_snapshot() {
    let fixture = Fixture::new();
    let gate = Arc::new((Mutex::new((0usize, false)), Condvar::new()));
    let witness = gate.clone();
    let mut scan = Scan::new();
    scan.preopen_reads = true;
    scan.metadata_hook = Some(Arc::new(move |_| {
        let (mutex, changed) = &*witness;
        let mut state = mutex.lock().unwrap();
        state.0 += 1;
        changed.notify_all();
        while !state.1 {
            state = changed.wait(state).unwrap();
        }
    }));
    let (held, rows, scan) = std::thread::scope(|scope| {
        let root = &fixture.0;
        let work = scope.spawn(move || {
            let request = serde_json::from_value(
                json!({"root":root,"scope":"metadata-test","tool":"grep","args":{}}),
            )
            .unwrap();
            let rows = collect(&mut scan, root, &request);
            (rows, scan)
        });
        let (mutex, changed) = &*gate;
        let state = mutex.lock().unwrap();
        let (mut state, _) = changed
            .wait_timeout_while(state, Duration::from_secs(5), |state| {
                state.0 < crate::scan_open::WORKERS
            })
            .unwrap();
        let held = state.0;
        state.1 = true;
        changed.notify_all();
        drop(state);
        let (rows, scan) = work.join().unwrap();
        (held, rows, scan)
    });
    assert_eq!(
        held,
        crate::scan_open::WORKERS,
        "the existing no-follow metadata queries must overlap"
    );
    let mut serial = Scan::new();
    assert_eq!(rows, collect(&mut serial, &fixture.0, &fixture.request()));
    assert_eq!(scan.hash.clone().finalize(), serial.hash.finalize());
    assert_eq!(scan.scanned, serial.scanned);
    assert_eq!(scan.bytes, serial.bytes);
    assert!(scan.complete());
}

#[test]
fn a_failed_parallel_metadata_query_remains_an_explicit_scan_gap() {
    let fixture = Fixture::new();
    let removed = fixture.0.join("f000.txt");
    let mut scan = Scan::new();
    scan.preopen_reads = true;
    scan.metadata_hook = Some(Arc::new(move |name| {
        if name == Path::new("f000.txt") {
            fs::remove_file(&removed).unwrap();
        }
    }));
    scan.open_hook = Some(Arc::new(|path| {
        assert_ne!(path.file_name().unwrap(), "f000.txt");
    }));
    let rows = collect(&mut scan, &fixture.0, &fixture.request());
    assert_eq!(rows.len(), 39);
    assert_eq!(scan.scanned, 39);
    assert!(!scan.complete());
    assert_eq!(scan.reasons["unreadable-entry"], 1);
    assert!(scan.preopened.is_empty());
}
