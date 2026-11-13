use super::*;
use std::{sync::mpsc, thread, time::Duration};

fn shutdown_during_io(read: bool) {
    let (pipe, peer) = platform::test_pair().unwrap();
    let mut stream = ControlPipe(pipe);
    let control = stream.try_clone().unwrap();
    let mut later = control.try_clone().unwrap();
    let (started, starting) = mpsc::channel();
    let (ended, ending) = mpsc::channel();
    let worker = thread::spawn(move || {
        started.send(()).unwrap();
        let result = if read {
            stream.read(&mut [0u8; 1]).map(|_| ())
        } else {
            stream.write_all(&vec![b'x'; 4 * 1024 * 1024])
        };
        ended.send(result).unwrap();
    });
    starting.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        ending.recv_timeout(Duration::from_millis(50)).is_err(),
        "peer intentionally neither reads nor writes"
    );
    control.shutdown().unwrap();
    let settled = ending.recv_timeout(Duration::from_secs(2));
    // Close the peer even if the assertion fails, so a broken implementation's
    // worker is released rather than leaving a test-owned I/O thread behind.
    drop(peer);
    worker.join().unwrap();
    assert!(settled.is_ok(), "shutdown must unblock pending I/O");
    assert!(
        later.write_all(b"late").is_err(),
        "shutdown must prevent the next write"
    );
    assert_eq!(later.read(&mut [0u8; 1]).unwrap(), 0);
    control.shutdown().unwrap();
}
#[test]
fn shutdown_unblocks_reads_and_prevents_later_io() {
    shutdown_during_io(true);
}
#[test]
fn shutdown_unblocks_writes_and_prevents_later_io() {
    shutdown_during_io(false);
}
