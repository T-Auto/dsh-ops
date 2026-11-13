use super::{Manager, protocol};
use serde_json::{Value, json};
use std::{
    fs, io,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CHILD: &str = "task::lifecycle_tests::owned_child";
fn fixture_directory(nonce: u128) -> PathBuf {
    // Parallel tests can observe the same Windows wall-clock tick.
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "ops-task-test-{}-{nonce}-{sequence}",
        std::process::id()
    ))
}

#[test]
fn fixture_paths_stay_unique_when_parallel_calls_share_a_clock_tick() {
    let paths = thread::scope(|scope| {
        let calls: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| fixture_directory(0)))
            .collect();
        calls
            .into_iter()
            .map(|call| call.join().unwrap())
            .collect::<std::collections::HashSet<_>>()
    });
    assert_eq!(paths.len(), 8);
}

struct Fixture {
    manager: Manager,
    output: Receiver<Value>,
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = fixture_directory(nonce);
        fs::create_dir(&directory).unwrap();
        let (send, output) = mpsc::channel();
        let manager = Manager::new(
            Arc::new(move |value| send.send(value).map_err(io::Error::other)),
            || {},
        )
        .unwrap();
        Self {
            manager,
            output,
            directory,
        }
    }
    fn receive(&self, kind: &str) -> Value {
        let value = self.output.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(value["type"], kind, "{value}");
        value
    }
    fn launch(&mut self, lifetime: &str, mode: &str) {
        self.launch_with_deadline(lifetime, mode, None);
    }
    fn launch_with_deadline(&mut self, lifetime: &str, mode: &str, timeout: Option<u32>) {
        self.manager.handle(&json!({"type":"task.execute","requestId":"task","ownerKey":"owner",
            "lifetime":lifetime,"graceMs":1.5,"timeoutMs":timeout,"output":{"memoryBytes":64000,"spillBytes":67108864}})).unwrap();
        self.receive("task.admit");
        self.manager.handle(&json!({"type":"task.admission","requestId":"task","decision":"launch",
            "launch":{"argv":[std::env::current_exe().unwrap(),"--ignored","--exact",CHILD,"--nocapture"],
                "cwd":self.directory,"env":{"OPS_TASK_DIRECTORY":self.directory,"OPS_TASK_MODE":mode}}})).unwrap();
        self.receive("task.started");
    }
    fn gate(&self, name: &str) {
        fs::write(self.directory.join(name), []).unwrap();
    }
    fn wait(&self, name: &str) {
        let until = Instant::now() + Duration::from_secs(5);
        while !self.directory.join(name).exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(
            self.directory.join(name).exists(),
            "missing fixture gate {name}"
        );
    }
    fn read(&mut self, stream: &str) -> Value {
        self.manager.handle(&json!({"type":"task.read","requestId":"task","stream":stream,"offset":0,"maxBytes":65536})).unwrap();
        self.receive("task.output")
    }
    fn promote(&mut self) -> Value {
        self.manager
            .handle(&json!({"type":"task.promote","requestId":"task"}))
            .unwrap();
        self.receive("task.promoted")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.shutdown().unwrap();
    }
}

#[test]
#[ignore = "owned child fixture, explicitly invoked by task lifecycle tests"]
fn owned_child() {
    let directory = PathBuf::from(std::env::var_os("OPS_TASK_DIRECTORY").unwrap());
    let mode = std::env::var("OPS_TASK_MODE").unwrap();
    let wait = |name: &str| {
        let until = Instant::now() + Duration::from_secs(20);
        while !directory.join(name).exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(
            directory.join(name).exists(),
            "child fixture deadline: {name}"
        );
    };
    if mode == "output" {
        use io::{Read, Write};
        assert_eq!(io::stdin().read(&mut [0]).unwrap(), 0);
        io::stdout().write_all(&vec![b'A'; 200000]).unwrap();
        io::stdout().write_all(b"TAIL").unwrap();
        io::stderr().write_all(&vec![b'B'; 180000]).unwrap();
        io::stderr().write_all(b"END").unwrap();
        std::process::exit(259);
    }
    if mode == "descendant" {
        fs::write(directory.join("descendant-ready"), []).unwrap();
        wait("child-request");
        fs::write(directory.join("descendant-responded"), []).unwrap();
        wait("never-release");
    } else {
        let _descendant = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", CHILD, "--nocapture"])
            .env("OPS_TASK_MODE", "descendant")
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        wait("root-exit");
        std::process::exit(0);
    }
}

#[test]
fn actual_task_joins_raw_tails_stdin_eof_and_real_exit_259() {
    let mut fixture = Fixture::new();
    fixture.launch("foreground", "output");
    let terminal = fixture.receive("task.completed");
    assert_eq!(terminal["status"], "completed");
    assert_eq!(terminal["exitCode"], 259);
    assert_eq!(terminal["effectState"], "unknown");
    assert_eq!(terminal["cleanupConfirmed"], true);
    let stdout = fixture.read("stdout");
    let stderr = fixture.read("stderr");
    assert_eq!(
        stdout["bytesBase64"],
        protocol::base64(&[vec![b'A'; 63996], b"TAIL".to_vec()].concat())
    );
    assert_eq!(
        stderr["bytesBase64"],
        protocol::base64(&[vec![b'B'; 63997], b"END".to_vec()].concat())
    );
    for output in [&stdout, &stderr] {
        assert_eq!(output["eof"], true);
        assert_eq!(output["lossy"], true);
        assert!(output["error"].is_null());
    }
    assert_eq!(fixture.promote()["accepted"], false);
    fixture
        .manager
        .handle(&json!({"type":"task.release","requestId":"task"}))
        .unwrap();
    assert!(!fixture.manager.contains("task"));
}

#[test]
fn ordinary_root_exit_retires_inherited_descendant_writers() {
    let mut fixture = Fixture::new();
    fixture.launch("foreground", "root");
    fixture.wait("descendant-ready");
    fixture.gate("root-exit");
    let terminal = fixture.receive("task.completed");
    assert_eq!(terminal["status"], "completed");
    assert_eq!(terminal["cleanupConfirmed"], true);
    assert_eq!(fixture.read("stdout")["eof"], true);
    assert_eq!(fixture.read("stderr")["eof"], true);
    assert_eq!(fixture.promote()["accepted"], false);
    assert!(!fixture.directory.join("descendant-responded").exists());
}

#[test]
fn explicit_and_promoted_jobs_preserve_descendants_until_targeted_cancel() {
    for promote in [false, true] {
        let mut fixture = Fixture::new();
        fixture.launch(if promote { "foreground" } else { "job" }, "root");
        fixture.wait("descendant-ready");
        if promote {
            assert_eq!(fixture.promote()["accepted"], true);
        }
        fixture.gate("root-exit");
        assert!(matches!(
            fixture.output.recv_timeout(Duration::from_millis(150)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        fixture.gate("child-request");
        fixture.wait("descendant-responded");
        assert_eq!(fixture.read("stdout")["eof"], false);
        fixture.manager.cancel("task").unwrap();
        let terminal = fixture.receive("task.completed");
        assert_eq!(terminal["status"], "cancelled");
        assert_eq!(terminal["effectState"], "unknown");
        assert_eq!(terminal["cleanupConfirmed"], true);
        assert_eq!(fixture.read("stdout")["eof"], true);
        assert_eq!(fixture.promote()["accepted"], false);
    }
}

#[test]
fn promotion_does_not_remove_an_explicit_hard_execution_deadline() {
    let mut fixture = Fixture::new();
    fixture.launch_with_deadline("foreground", "root", Some(3000));
    fixture.wait("descendant-ready");
    assert_eq!(fixture.promote()["accepted"], true);
    fixture.gate("root-exit");
    let terminal = fixture.receive("task.completed");
    assert_eq!(terminal["status"], "cancelled");
    assert_eq!(terminal["error"]["code"], "TIMEOUT");
    assert_eq!(terminal["cleanupConfirmed"], true);
    assert_eq!(fixture.read("stdout")["eof"], true);
}
