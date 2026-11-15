use super::*;
use std::sync::Condvar;

fn concurrent_arming(pooled: bool) {
    let job = Arc::new(Job::new().unwrap());
    let pool =
        pooled.then(|| super::super::super::channel_pool::ChannelPool::new(job.clone()).unwrap());
    let lease = pool.as_ref().map(|pool| pool.lease().unwrap());
    let gates = Arc::new((Mutex::new([false; 4]), Condvar::new()));
    let (started, observed) = mpsc::channel();
    let worker_gates = gates.clone();
    let gate: ConnectGate = Arc::new(move |index| {
        started.send(index).unwrap();
        let mut released = worker_gates.0.lock().unwrap();
        while !released[index] {
            released = worker_gates.1.wait(released).unwrap();
        }
    });
    let (finished, result) = mpsc::channel();
    let builder = thread::spawn(move || {
        finished
            .send(Channel::build(job, 64, None, None, lease, Some(gate)))
            .unwrap();
    });

    // Hold every reader before ConnectNamedPipe. All four must be dispatched
    // without waiting for the first reader's arming acknowledgment.
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut reached = Vec::new();
    while reached.len() < 4 {
        match observed.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(index) => reached.push(index),
            Err(_) => break,
        }
    }
    *gates.0.lock().unwrap() = [true, true, true, false];
    gates.1.notify_all();
    // Even when other readers arm, the final held reader forbids publication.
    let premature = result.recv_timeout(Duration::from_millis(50)).ok();
    let published_early = premature.is_some();

    // Always release and join before asserting, including against the serial
    // implementation: the regression must not strand its own test fixtures.
    *gates.0.lock().unwrap() = [true; 4];
    gates.1.notify_all();
    let mut channel = premature
        .unwrap_or_else(|| result.recv_timeout(Duration::from_secs(2)).unwrap())
        .unwrap();
    channel
        .drain(Instant::now() + Duration::from_secs(2))
        .unwrap();
    builder.join().unwrap();
    reached.sort_unstable();
    assert_eq!(reached, [0, 1, 2, 3], "readers were armed serially");
    assert!(
        !published_early,
        "endpoint escaped before every connect armed"
    );
    assert!(channel.snapshot().errors.is_empty());
    assert!(channel.readers.is_empty());
    if let Some(pool) = pool {
        let mut next = pool.framed(64, b"OUT:next\n").unwrap();
        next.drain(Instant::now() + Duration::from_secs(2)).unwrap();
    }
}

#[test]
fn dedicated_readers_arm_together_before_endpoint_publication() {
    concurrent_arming(false);
}

#[test]
fn pooled_readers_arm_together_before_endpoint_publication() {
    concurrent_arming(true);
}
