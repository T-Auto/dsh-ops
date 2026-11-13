//! Real owned process plus the production bounded reply writer, with deterministic backpressure.
use super::*;
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::windows::fs::OpenOptionsExt,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
const CHILD: &str = "resident::confined::lifecycle_tests::blocked_child";
#[test]
#[ignore = "owned subprocess fixture, invoked explicitly by confined lifecycle test"]
fn blocked_child() {
    if std::env::var_os("OPS_EARLY_EXIT").is_some() {
        eprintln!("denied by confined fixture");
        std::process::exit(23);
    }
    let root = std::env::current_dir().unwrap();
    let _held = OpenOptions::new()
        .create_new(true)
        .write(true)
        .share_mode(0)
        .open(root.join("held"))
        .unwrap();
    fs::write(root.join("ready"), "ready").unwrap();
    let mut byte = [0];
    if std::io::stdin().read(&mut byte).unwrap_or(0) != 0 {
        fs::write(root.join("received"), byte).unwrap();
    }
    loop {
        thread::park();
    }
}
#[test]
fn early_runner_refusal_preserves_exit_and_stderr_after_partial_input() {
    let launch = Launch {
        argv: vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            CHILD.into(),
            "--nocapture".into(),
        ],
        cwd: std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        env: BTreeMap::from([("OPS_EARLY_EXIT".into(), "1".into())]),
        deadline: Instant::now() + Duration::from_secs(5),
    };
    let started: crate::shell::Started = Arc::new(|_| {
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.send(Ok(())).unwrap();
        Ok(receiver)
    });
    let state = Arc::new(Mutex::new(super::super::RequestState::default()));
    let exchange = execute(
        vec![b'x'; 2 * 1024 * 1024],
        launch,
        "refusal",
        &state,
        &started,
        &|| panic!("early refusal must join"),
    );
    assert_eq!(exchange["exitCode"], 23, "{exchange}");
    assert_eq!(exchange["interrupted"], false, "{exchange}");
    assert!(
        exchange["stderr"]
            .as_str()
            .unwrap()
            .contains("denied by confined fixture")
    );
    assert!(state.lock().unwrap().leaf.is_none());
}
struct Gate(Arc<(Mutex<bool>, Condvar)>);
impl Gate {
    fn release(&self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        self.release();
    }
}
#[test]
fn deadline_joins_owned_runner_while_start_receipt_is_blocked_and_preserves_order() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let directory = std::env::temp_dir().join(format!(
        "ops-confined-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&directory).unwrap();
    let gate = Gate(Arc::new((Mutex::new(false), Condvar::new())));
    let blocked = gate.0.clone();
    let (entered, entering) = mpsc::sync_channel(1);
    let (sent, frames) = mpsc::channel();
    let mut manager = crate::shell::Manager::new(
        move |value| {
            if value["type"] == "started" {
                entered.send(()).unwrap();
                let mut released = blocked.0.lock().unwrap();
                while !*released {
                    released = blocked.1.wait(released).unwrap();
                }
            }
            sent.send(value).unwrap();
            Ok(())
        },
        || panic!("cleanup must be confirmed"),
    )
    .unwrap();
    let launch = Launch {
        argv: vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--ignored".into(),
            "--exact".into(),
            CHILD.into(),
            "--nocapture".into(),
        ],
        cwd: directory.to_string_lossy().into_owned(),
        env: BTreeMap::new(),
        deadline: Instant::now() + Duration::from_millis(1500),
    };
    let state = Arc::new(Mutex::new(super::super::RequestState::default()));
    let active = state.clone();
    let started = manager.started_output();
    let completed = manager.output();
    let (settled, terminal) = mpsc::sync_channel(1);
    let runner = thread::spawn(move || {
        let exchange = execute(
            vec![b'x'; 2 * 1024 * 1024],
            launch,
            "blocked",
            &active,
            &started,
            &|| panic!("owned input cleanup must settle"),
        );
        completed(json!({"type":"completed","requestId":"blocked","exchange":exchange})).unwrap();
        settled.send(exchange).unwrap();
    });
    entering.recv_timeout(Duration::from_secs(5)).unwrap();
    let ready_deadline = Instant::now() + Duration::from_secs(1);
    while !directory.join("ready").exists() && Instant::now() < ready_deadline {
        thread::sleep(Duration::from_millis(2));
    }
    let child_was_ready = directory.join("ready").exists();
    let result = terminal.recv_timeout(Duration::from_secs(4));
    let child_released = result.is_ok()
        && OpenOptions::new()
            .write(true)
            .share_mode(0)
            .open(directory.join("held"))
            .is_ok();
    // Even a failing regression releases the writer and cancels the owned child before joining.
    let completed_while_blocked = result.is_ok();
    if !completed_while_blocked {
        super::super::cancel(&state);
    }
    gate.release();
    runner.join().unwrap();
    let exchange = result.unwrap_or_else(|_| terminal.recv().unwrap());
    let first = frames.recv_timeout(Duration::from_secs(2)).unwrap();
    let second = frames.recv_timeout(Duration::from_secs(2)).unwrap();
    manager.shutdown().unwrap();
    let stdin_untouched = !directory.join("received").exists();
    fs::remove_dir_all(directory).unwrap();
    assert!(child_was_ready);
    assert!(
        completed_while_blocked,
        "deadline cannot wait for the physical start writer"
    );
    assert!(
        child_released,
        "owned child must have released its exclusive handle before completion"
    );
    assert!(
        stdin_untouched,
        "no request bytes may precede the physical start receipt"
    );
    assert_eq!(first["type"], "started");
    assert_eq!(second["type"], "completed");
    assert_eq!(exchange["interrupted"], true);
    assert!(exchange.get("value").is_none());
    assert!(state.lock().unwrap().leaf.is_none());
}
