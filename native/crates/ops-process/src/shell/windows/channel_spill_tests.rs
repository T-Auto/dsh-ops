use super::*;
use std::{fs::File, io::Write};

fn spilling(store: SpillStore) -> Spilling {
    Spilling {
        view: CaptureView::new(4, Retention::Prefix).unwrap(),
        store,
        stream: "stdout",
        busy: Arc::new(AtomicBool::new(false)),
    }
}
fn output(capture: &Spilling, cancel: Cancellation) -> ReaderOutput {
    ReaderOutput {
        capture: Output::new(
            capture.view.clone(),
            4,
            Some(capture.store.clone()),
            "stdout",
            cancel,
        ),
        busy: capture.busy.clone(),
    }
}
fn connected(capture: Spilling, cancel: Cancellation) -> (Channel, File) {
    let (server, client) = tests::connected_pipe();
    let server = Arc::new(server);
    let stop = Arc::new(AtomicBool::new(false));
    let state = Arc::new(Mutex::new(State::default()));
    state.lock().unwrap().accepted.push(std::process::id());
    let (handle, reader_stop, reader_state) = (server.clone(), stop.clone(), state.clone());
    let owned_output = output(&capture, cancel.clone());
    let reader = thread::spawn(move || {
        if let Err(error) = read_peer(
            &handle,
            &reader_stop,
            &reader_state,
            4,
            Some(&Prefix {
                bytes: b"OUT:id\n".to_vec(),
                duplex: false,
            }),
            Some(owned_output),
        ) {
            reader_state.lock().unwrap().errors.push(error.to_string());
        }
    });
    (
        Channel {
            name: OsString::new(),
            stop,
            seal_connects: Arc::new(ConnectSeal::new().unwrap()),
            state,
            handles: vec![Arc::downgrade(&server)],
            readers: vec![super::super::channel_pool::Reader::Dedicated(reader)],
            pool: None,
            spilling: Some(capture),
            cancellations: vec![cancel],
            poisoned: false,
        },
        client,
    )
}
fn wait_for(channel: &Channel, observed: u64) -> ChannelSnapshot {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let snapshot = channel.snapshot();
        if snapshot.observed == observed {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "channel output did not arrive: {snapshot:?}"
        );
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn metadata_opens_cannot_seal_and_framing_never_enters_the_shared_spill() {
    let store = SpillStore::new(&std::env::temp_dir(), 1024).unwrap();
    let capture = spilling(store.clone());
    let (server, client) = tests::connected_pipe();
    drop(client);
    read_peer(
        &Arc::new(server),
        &AtomicBool::new(false),
        &Mutex::new(State::default()),
        4,
        Some(&Prefix {
            bytes: b"OUT:id\n".to_vec(),
            duplex: false,
        }),
        Some(output(&capture, Cancellation::default())),
    )
    .unwrap();
    assert!(!capture.view.snapshot().eof);
    assert!(capture.view.snapshot().spill.is_none());
    let (mut channel, mut client) = connected(capture, Cancellation::default());
    client.write_all(b"OUT:id\nabcdef").unwrap();
    let live = wait_for(&channel, 6);
    assert_eq!(live.bytes, b"abcd");
    assert!(live.truncated && live.ready && !live.writer_eof && !live.writer_closed);
    let path = live.spill.unwrap().path;
    assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
    assert!(!channel.snapshot().spill.unwrap().sealed);
    drop(client);
    channel
        .drain(Instant::now() + Duration::from_secs(3))
        .unwrap();
    let done = channel.snapshot();
    assert!(done.writer_closed && done.writer_eof && done.spill.unwrap().sealed);
    assert!(done.errors.is_empty() && !done.storage_pending);
    std::fs::remove_file(path).unwrap();
    let directory = store.test_directory();
    drop(channel);
    drop(store);
    std::fs::remove_dir(directory).unwrap();
}

#[test]
fn stalled_channel_storage_keeps_snapshots_live_and_requires_poisoned_owner_teardown() {
    let store = SpillStore::new(&std::env::temp_dir(), 1024).unwrap();
    let capture = spilling(store.clone());
    let cancel = Cancellation::default();
    let (gate, entered) = cancel.gate_next_write();
    let (mut channel, mut client) = connected(capture, cancel);
    client.write_all(b"OUT:id\nabcdef").unwrap();
    let entered = entered.recv_timeout(Duration::from_secs(3));
    let view = channel.view();
    let (send, received) = mpsc::channel();
    let observer = thread::spawn(move || {
        let _ = send.send(view.snapshot());
    });
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        entered.unwrap();
        let snapshot = received.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(snapshot.storage_pending && snapshot.ready && !snapshot.writer_eof);
        assert_eq!(snapshot.observed, 0);
        assert!(
            channel
                .close_until(Instant::now() + Duration::from_millis(20))
                .is_err()
        );
        assert!(channel.cleanup_unconfirmed());
        assert!(!channel.readers.is_empty());
        assert!(channel.snapshot().spill.is_none());
    }));
    drop(client);
    gate.release();
    observer.join().unwrap();
    for reader in channel.readers.drain(..) {
        reader.join().unwrap();
    }
    let snapshot = channel.snapshot();
    assert!(snapshot.cleanup_unconfirmed && !snapshot.writer_eof);
    assert!(snapshot.spill.is_none());
    assert_eq!(
        std::fs::read_dir(store.test_directory()).unwrap().count(),
        0
    );
    let directory = store.test_directory();
    drop(channel);
    drop(store);
    std::fs::remove_dir(directory).unwrap();
    outcome.unwrap();
}

#[test]
fn authenticated_raw_eof_is_distinct_from_pending_seal_completion() {
    let store = SpillStore::new(&std::env::temp_dir(), 1024).unwrap();
    let cancel = Cancellation::default();
    let (gate, entered) = cancel.gate_next_close();
    let (mut channel, mut client) = connected(spilling(store.clone()), cancel);
    client.write_all(b"OUT:id\nabcdef").unwrap();
    drop(client);
    let entered = entered.recv_timeout(Duration::from_secs(3));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        entered.unwrap();
        let snapshot = channel.snapshot();
        assert!(snapshot.writer_closed && snapshot.storage_pending);
        assert!(!snapshot.writer_eof);
        assert_eq!(snapshot.observed, 6);
        assert!(!snapshot.spill.unwrap().sealed);
        assert!(!channel.cleanup_unconfirmed());
    }));
    gate.release();
    channel
        .drain(Instant::now() + Duration::from_secs(3))
        .unwrap();
    let snapshot = channel.snapshot();
    assert!(snapshot.writer_eof && !snapshot.storage_pending);
    let spill = snapshot.spill.unwrap();
    assert!(spill.sealed);
    std::fs::remove_file(spill.path).unwrap();
    let directory = store.test_directory();
    drop(channel);
    drop(store);
    std::fs::remove_dir(directory).unwrap();
    outcome.unwrap();
}
