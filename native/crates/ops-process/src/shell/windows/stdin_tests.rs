use super::*;
use crate::shell::MAX_INPUT_BYTES;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
    sync::atomic::AtomicUsize,
};

const CHILD: &str = "shell::windows::launch::stdin_tests::owned_input_child";
struct Release(Arc<super::super::spill_io::TestGate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}
struct Fixture {
    range: Range,
    directory: std::path::PathBuf,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ops-stdin-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let mut range = Range::new().unwrap();
        range
            .spawn_with_stdin(
                Launch {
                    argv: vec![
                        std::env::current_exe().unwrap().into(),
                        "--ignored".into(),
                        "--exact".into(),
                        CHILD.into(),
                        "--nocapture".into(),
                    ],
                    cwd: directory.clone(),
                    env: vec![
                        ("OPS_INPUT_MODE".into(), mode.into()),
                        ("OPS_INPUT_DIR".into(), directory.clone().into()),
                    ],
                    output_cap: 128 * 1024,
                },
                Retention::Tail,
                16 * 1024,
            )
            .unwrap();
        Self { range, directory }
    }
    fn gate(&self, file: &str) {
        until(|| self.directory.join(file).is_file());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.range
            .terminate(Instant::now() + Duration::from_secs(5))
            .unwrap();
        let _ = self
            .range
            .captures_until(Instant::now() + Duration::from_secs(5));
        fs::remove_dir_all(&self.directory).unwrap();
    }
}
fn until(check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !check() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(2));
    }
    assert!(
        check(),
        "fixture condition was not observed before deadline"
    );
}
#[test]
#[ignore = "owned subprocess fixture, invoked explicitly by stdin lifecycle tests"]
fn owned_input_child() {
    let directory = std::path::PathBuf::from(std::env::var_os("OPS_INPUT_DIR").unwrap());
    match std::env::var("OPS_INPUT_MODE").unwrap().as_str() {
        "echo" => {
            let mut bytes = Vec::new();
            std::io::stdin().read_to_end(&mut bytes).unwrap();
            fs::write(
                directory.join("received"),
                format!(
                    "{}:{}",
                    bytes.len(),
                    bytes.iter().map(|value| u64::from(*value)).sum::<u64>()
                ),
            )
            .unwrap();
            std::io::stdout().write_all(&bytes).unwrap();
            std::io::stdout().flush().unwrap();
            std::io::stderr().write_all(&vec![b'e'; 20000]).unwrap();
            std::process::exit(0);
        }
        "descendant" => {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", CHILD, "--nocapture"])
                .env_clear()
                .env("OPS_INPUT_DIR", &directory)
                .env("OPS_INPUT_MODE", "leaf")
                .stdin(Stdio::inherit())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            fs::write(directory.join("child-pid"), child.id().to_string()).unwrap();
            fs::write(directory.join("ready"), []).unwrap();
            let _ = child.wait();
        }
        "leaf" => {
            fs::write(directory.join("child-ready"), []).unwrap();
        }
        mode => panic!("unexpected fixture mode {mode}"),
    }
    fs::write(directory.join("ready"), []).unwrap();
    loop {
        thread::sleep(Duration::from_secs(60));
    }
}

#[test]
fn input_is_exact_and_eof_precedes_exit_with_distinct_bounded_output_tails() {
    let mut fixture = Fixture::new("echo");
    let bytes: Vec<u8> = (0..MAX_INPUT_BYTES).map(|index| index as u8).collect();
    fixture.range.write_input(bytes.clone()).unwrap();
    assert_eq!(
        fixture
            .range
            .wait_root_exit(Instant::now() + Duration::from_secs(5))
            .unwrap(),
        0
    );
    fixture
        .range
        .wait_empty(Instant::now() + Duration::from_secs(5))
        .unwrap();
    let captures = fixture
        .range
        .captures_until(Instant::now() + Duration::from_secs(5))
        .unwrap();
    assert_eq!(
        fs::read_to_string(fixture.directory.join("received")).unwrap(),
        format!(
            "{}:{}",
            bytes.len(),
            bytes.iter().map(|value| u64::from(*value)).sum::<u64>()
        )
    );
    assert_eq!(captures[0].bytes, bytes[bytes.len() - 128 * 1024..]);
    assert_eq!(captures[1].bytes, vec![b'e'; 16 * 1024]);
    assert!(captures.iter().all(|capture| capture.truncated));
    assert!(!fixture.range.cleanup_unconfirmed());
}

#[test]
fn cancellation_joins_blocked_stdin_and_children_created_before_input() {
    let mut fixture = Fixture::new("descendant");
    fixture.gate("child-ready");
    let child: u32 = fs::read_to_string(fixture.directory.join("child-pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        fixture.range.job.contains_pid(child).unwrap(),
        "the early descendant belongs to the Job before any input"
    );
    assert!(fixture.range.active_processes().unwrap() >= 2);
    fixture
        .range
        .write_input(vec![b'x'; MAX_INPUT_BYTES])
        .unwrap();
    until(|| {
        fixture
            .range
            .input
            .as_ref()
            .unwrap()
            .written
            .load(Ordering::Acquire)
            >= 65536
    });
    assert!(
        !fixture.range.input.as_ref().unwrap().is_finished(),
        "the owned child never reads stdin"
    );
    fixture.range.cancellation().cancel().unwrap();
    fixture
        .range
        .terminate(Instant::now() + Duration::from_secs(5))
        .unwrap();
    assert!(
        fixture
            .range
            .captures_until(Instant::now() + Duration::from_secs(5))
            .is_ok(),
        "joined stdout/stderr are independent of partial input delivery"
    );
    assert!(
        fixture.range.input_error().is_some(),
        "partial cancelled input is not successful delivery"
    );
    assert_eq!(fixture.range.active_processes().unwrap(), 0);
    assert!(fixture.range.input.as_ref().unwrap().is_finished());
    assert!(fixture.range.readers.is_empty());
    assert!(!fixture.range.cleanup_unconfirmed());
}

#[test]
fn an_unjoined_input_owner_poison_cannot_be_cleared_by_late_finish() {
    let mut fixture = Fixture::new("echo");
    let (gate, entered) = fixture
        .range
        .input
        .as_ref()
        .unwrap()
        .control
        .gate_next_close();
    let _release = Release(gate.clone());
    fixture.range.write_input(b"bounded".to_vec()).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    fixture
        .range
        .wait_root_exit(Instant::now() + Duration::from_secs(5))
        .unwrap();
    fixture
        .range
        .wait_empty(Instant::now() + Duration::from_secs(5))
        .unwrap();
    let result = fixture.range.captures_until(Instant::now());
    gate.release();
    assert!(result.is_err());
    assert!(fixture.range.cleanup_unconfirmed());
    assert!(
        fixture
            .range
            .captures_until(Instant::now() + Duration::from_secs(5))
            .is_err()
    );
    assert!(
        fixture
            .range
            .output_views()
            .unwrap()
            .iter()
            .all(|view| !view.snapshot().eof)
    );
}

#[test]
fn input_record_cap_rejects_without_sending_bytes_or_losing_ownership() {
    let mut fixture = Fixture::new("echo");
    assert!(
        fixture
            .range
            .write_input(vec![0; MAX_INPUT_BYTES + 1])
            .is_err()
    );
    assert_eq!(
        fixture
            .range
            .input
            .as_ref()
            .unwrap()
            .written
            .load(Ordering::Acquire),
        0
    );
    fixture.range.write_input(Vec::new()).unwrap();
    assert_eq!(
        fixture
            .range
            .wait_root_exit(Instant::now() + Duration::from_secs(5))
            .unwrap(),
        0
    );
    assert_eq!(
        fs::read_to_string(fixture.directory.join("received")).unwrap(),
        "0:0"
    );
}
