use super::super::manager::{Data, Manager, Queue};
use super::*;
use std::sync::{Condvar, Mutex, atomic::AtomicBool};
use std::thread;

struct HeldCapture {
    thread: Option<thread::JoinHandle<()>>,
    fatal: Arc<AtomicBool>,
    dropped_after_fatal: Arc<AtomicBool>,
}
impl CaptureCleanup for HeldCapture {
    fn drain(&mut self, _: Instant) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "fixture reader did not acknowledge cancellation",
        ))
    }
    fn cleanup_unconfirmed(&self) -> bool {
        true
    }
}
impl Drop for HeldCapture {
    fn drop(&mut self) {
        self.dropped_after_fatal
            .store(self.fatal.load(Ordering::Acquire), Ordering::Release);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn release(gate: &(Mutex<bool>, Condvar)) {
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
}

#[test]
fn call_poison_closes_admission_and_invokes_actual_manager_fatal_before_drop() {
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let fatal = Arc::new(AtomicBool::new(false));
    let dropped_after_fatal = Arc::new(AtomicBool::new(false));
    let (output, responses) = mpsc::channel();
    let (fatal_flag, fatal_gate) = (fatal.clone(), gate.clone());
    let mut manager = Manager::new(
        move |value| output.send(value).map_err(io::Error::other),
        move || {
            fatal_flag.store(true, Ordering::Release);
            release(&fatal_gate);
        },
    )
    .unwrap();
    let state = manager.test_state();
    let closing = state.closing.clone();
    let session = Arc::new(Session {
        key: "owner".into(),
        queue: Mutex::new(Queue::default()),
        wake: Condvar::new(),
    });
    let request = Request {
        id: "request".into(),
        command: String::new(),
        caps: [1, 1],
        deadline: Instant::now() + Duration::from_secs(30),
        session: session.clone(),
        cancelled: AtomicBool::new(false),
        expired: AtomicBool::new(false),
        data: Mutex::new(Data {
            started: true,
            ..Data::default()
        }),
        wake: Condvar::new(),
    };
    let reader_gate = gate.clone();
    let reader = thread::spawn(move || {
        let mut released = reader_gate.0.lock().unwrap();
        while !*released {
            released = reader_gate.1.wait(released).unwrap();
        }
    });
    let mut capture = HeldCapture {
        thread: Some(reader),
        fatal: fatal.clone(),
        dropped_after_fatal: dropped_after_fatal.clone(),
    };
    let (completed, result) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut owner = Worker {
            state,
            session,
            driver: None,
            live: false,
        };
        // The process range is already gone. A separate unjoined call capture
        // must still prevent cleanup:true and must reach fatal before its Drop.
        let result = owner.failure(
            &request,
            Some(&mut capture),
            io::Error::other("request failed"),
            "SHELL_RESET",
        );
        drop(capture);
        completed.send(result).unwrap();
    });
    let observed = result.recv_timeout(Duration::from_secs(1));
    // Failure teardown always releases the fixture, even if fatal was omitted.
    release(&gate);
    worker.join().unwrap();
    manager.shutdown().unwrap();
    assert!(observed.unwrap().is_err());
    assert!(fatal.load(Ordering::Acquire));
    assert!(closing.load(Ordering::Acquire));
    assert!(dropped_after_fatal.load(Ordering::Acquire));
    assert!(
        responses.try_recv().is_err(),
        "poisoned cleanup must not publish a terminal success receipt"
    );
}
