use super::super::{Range, channel_wake::wait_readers};
use super::*;
use crate::shell::Launch;
use std::{
    fs::OpenOptions,
    io::Write,
    time::{Duration, Instant},
};

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn child(pool: &ChannelPool, channel: &Channel, prefix: &str, bytes: &str) -> Range {
    let mut range = Range::new().unwrap();
    range.job = pool.0.job.clone();
    range
        .spawn(Launch {
            argv: vec![
                std::env::current_exe().unwrap().into(),
                "--ignored".into(),
                "--exact".into(),
                "shell::windows::channel_pool::tests::writer_child".into(),
                "--nocapture".into(),
            ],
            cwd: std::env::current_dir().unwrap(),
            env: vec![
                ("POOL_PIPE".into(), channel.name().into()),
                ("POOL_PREFIX".into(), prefix.into()),
                ("POOL_BYTES".into(), bytes.into()),
            ],
            output_cap: 1024,
        })
        .unwrap();
    range
}
#[test]
#[ignore = "owned writer fixture, explicitly invoked by pool generation tests"]
fn writer_child() {
    let mut pipe = OpenOptions::new()
        .read(true)
        .write(true)
        .open(std::env::var_os("POOL_PIPE").unwrap())
        .unwrap();
    pipe.write_all(std::env::var("POOL_PREFIX").unwrap().as_bytes())
        .unwrap();
    pipe.write_all(std::env::var("POOL_BYTES").unwrap().as_bytes())
        .unwrap();
}

#[test]
fn reuse_keeps_views_caps_and_old_cancellation_separate() {
    let pool = ChannelPool::new(Arc::new(Job::new().unwrap())).unwrap();
    let pipe_handles: Vec<_> = pool
        .0
        .slots
        .iter()
        .map(|slot| slot.handle.as_raw_handle())
        .collect();
    let threads: Vec<_> = pool
        .0
        .slots
        .iter()
        .map(|slot| slot.reader.as_ref().unwrap().thread().id())
        .collect();
    let mut first = pool.framed(4, b"OUT:first\n").unwrap();
    let name = first.name().to_owned();
    assert!(
        matches!(pool.framed(4, b"OUT:busy\n"), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
    );
    let old = first.view();
    let mut writer = child(&pool, &first, "OUT:first\n", "abcdef");
    writer.wait_empty(deadline()).unwrap();
    first.drain(deadline()).unwrap();
    assert_eq!(old.snapshot().bytes, b"abcd");
    assert_eq!(old.snapshot().observed, 6);
    assert!(old.snapshot().truncated && old.snapshot().writer_eof);

    for generation in 0..8 {
        let prefix = format!("OUT:next-{generation}\n");
        let mut next = pool.framed(8, prefix.as_bytes()).unwrap();
        assert_eq!(next.name(), name);
        // A caller may retain a drained Channel alongside its output view.
        // Closing it must never cancel the next generation on the same handles.
        first.close();
        let mut writer = child(&pool, &next, &prefix, "uvwxyz");
        writer.wait_empty(deadline()).unwrap();
        next.drain(deadline()).unwrap();
        let snapshot = next.snapshot();
        assert_eq!(snapshot.bytes, b"uvwxyz");
        assert!(!snapshot.truncated && snapshot.writer_eof && snapshot.errors.is_empty());
        assert_eq!(snapshot.eof, 1);
        assert_eq!(snapshot.accepted.len(), 1);
        assert_eq!(old.snapshot().bytes, b"abcd");
        assert_eq!(old.snapshot().observed, 6);
    }
    assert_eq!(
        pool.0
            .slots
            .iter()
            .map(|slot| slot.handle.as_raw_handle())
            .collect::<Vec<_>>(),
        pipe_handles
    );
    assert_eq!(
        pool.0
            .slots
            .iter()
            .map(|slot| slot.reader.as_ref().unwrap().thread().id())
            .collect::<Vec<_>>(),
        threads
    );
}

#[test]
fn stale_generation_prefix_is_rejected_and_poisoned_pool_is_not_reused() {
    let pool = ChannelPool::new(Arc::new(Job::new().unwrap())).unwrap();
    let mut first = pool.framed(16, b"OUT:old\n").unwrap();
    first.drain(deadline()).unwrap();
    let mut next = pool.framed(16, b"OUT:new\n").unwrap();
    let mut writer = child(&pool, &next, "OUT:old\n", "stale bytes");
    writer.wait_empty(deadline()).unwrap();
    assert!(next.drain(deadline()).is_err());
    assert_eq!(next.snapshot().observed, 0);
    assert!(!next.snapshot().writer_eof);
    assert!(pool.framed(16, b"OUT:future\n").is_err());
}

#[test]
fn a_task_retires_captured_resources_before_completion_and_reports_panics() {
    struct Held(mpsc::Sender<()>);
    impl Drop for Held {
        fn drop(&mut self) {
            self.0.send(()).unwrap();
        }
    }
    let pool = ChannelPool::new(Arc::new(Job::new().unwrap())).unwrap();
    let lease = pool.lease().unwrap();
    let (released, observed) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let held = Held(released);
    let reader = lease
        .start(
            0,
            Box::new(move || {
                gate.recv().unwrap();
                drop(held);
            }),
        )
        .unwrap();
    assert!(!reader.is_finished());
    assert!(!wait_readers(std::slice::from_ref(&reader), Instant::now()).unwrap());
    release.send(()).unwrap();
    assert!(wait_readers(std::slice::from_ref(&reader), deadline()).unwrap());
    observed.try_recv().unwrap();
    reader.join().unwrap();
    let reader = lease
        .start(0, Box::new(|| panic!("fixture panic")))
        .unwrap();
    assert!(wait_readers(std::slice::from_ref(&reader), deadline()).unwrap());
    assert!(reader.join().is_err());
    drop(lease);
    assert!(
        pool.lease().is_err(),
        "a panicked task permanently poisons reuse"
    );
}

#[test]
fn pooled_generations_keep_separate_sealed_spill_files() {
    let pool = ChannelPool::new(Arc::new(Job::new().unwrap())).unwrap();
    let store = SpillStore::new(&std::env::temp_dir(), 1024).unwrap();
    let mut views = Vec::new();
    for (prefix, bytes, cap) in [
        ("OUT:a\n", "first-full-stream", 4),
        ("OUT:b\n", "second-full-stream", 6),
    ] {
        let mut channel = pool
            .spilling(cap, prefix.as_bytes(), store.clone(), "stdout")
            .unwrap();
        let mut writer = child(&pool, &channel, prefix, bytes);
        writer.wait_empty(deadline()).unwrap();
        channel.drain(deadline()).unwrap();
        let view = channel.view();
        let value = view.snapshot();
        assert_eq!(value.bytes, &bytes.as_bytes()[..cap]);
        assert_eq!(value.observed as usize, bytes.len());
        assert!(value.truncated && value.writer_eof && !value.cleanup_unconfirmed);
        let spill = value.spill.unwrap();
        assert!(spill.sealed);
        assert_eq!(spill.pid, std::process::id());
        assert_eq!(std::fs::read(&spill.path).unwrap(), bytes.as_bytes());
        views.push((view, spill.path, bytes));
    }
    assert_ne!(views[0].1, views[1].1);
    for (view, path, bytes) in &views {
        assert_eq!(view.snapshot().observed as usize, bytes.len());
        assert_eq!(std::fs::read(path).unwrap(), bytes.as_bytes());
        std::fs::remove_file(path).unwrap();
    }
    let directory = store.test_directory();
    drop(views);
    drop(store);
    std::fs::remove_dir(directory).unwrap();
}
