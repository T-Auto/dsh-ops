use super::*;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn command() -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--ignored", "--exact", "leaf::tests::child", "--nocapture"]);
    command
}
#[test]
#[ignore = "child fixture, invoked explicitly by the process lifecycle tests"]
fn child() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    match input.trim() {
        "flood" => {
            io::stdout().write_all(&vec![b'o'; 256 * 1024]).unwrap();
            io::stdout().write_all(b"stdout-tail").unwrap();
            io::stderr().write_all(&vec![b'e'; 256 * 1024]).unwrap();
            io::stderr().write_all(b"stderr-tail").unwrap();
        }
        "echo" => println!("leaf completed"),
        ready if ready.starts_with("wait:") => {
            std::fs::write(&ready[5..], b"ready").unwrap();
            loop {
                thread::park();
            }
        }
        _ => panic!("unknown fixture command"),
    }
}
#[test]
fn output_is_bounded_and_both_streams_keep_draining() {
    let output = Execution::start(command(), 1024, 512)
        .unwrap()
        .run(b"flood".to_vec())
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout.len(), 1024);
    assert_eq!(output.stderr.len(), 512);
    assert!(output.stdout_lossy && output.stderr_lossy);
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("stdout-tail")
    );
    assert!(output.stderr.ends_with(b"stderr-tail"));
}
#[test]
fn cancelling_a_running_leaf_does_not_stop_another_execution() {
    let ready = std::env::temp_dir().join(format!(
        "ops-leaf-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let execution = Execution::start(command(), 1024, 512).unwrap();
    let cancel = execution.cancellation();
    let input = format!("wait:{}", ready.display()).into_bytes();
    let running = thread::spawn(move || execution.run(input));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    let started = ready.exists();
    let sibling = Execution::start(command(), 1024, 512)
        .unwrap()
        .run(b"echo".to_vec());
    cancel.cancel().unwrap();
    let stopped = running.join().unwrap().unwrap();
    cancel.cancel().unwrap();
    assert!(started, "fixture must reach its blocking operation");
    assert!(!stopped.status.success());
    let sibling = sibling.unwrap();
    assert!(sibling.status.success());
    assert!(
        String::from_utf8(sibling.stdout)
            .unwrap()
            .contains("leaf completed")
    );
    std::fs::remove_file(ready).unwrap();
}
#[test]
fn cancellation_before_input_and_drop_reap_the_child() {
    let execution = Execution::start(command(), 1024, 512).unwrap();
    let cancel = execution.cancellation();
    cancel.cancel().unwrap();
    assert!(!execution.run(b"echo".to_vec()).unwrap().status.success());
    let abandoned = Execution::start(command(), 1024, 512).unwrap();
    let cancel = abandoned.cancellation();
    drop(abandoned);
    assert!(cancel.0.state.lock().unwrap().status.is_some());
    cancel.cancel().unwrap();
}

#[cfg(unix)]
#[test]
fn leaf_preserves_outer_group_and_exit_observation_does_not_reap() {
    let mut execution = Execution::start(command(), 1024, 512).unwrap();
    let pid = execution.cancel.0.state.lock().unwrap().child.id() as libc::pid_t;
    // SAFETY: scalar queries for our live owned child and this process's group.
    let (child_group, outer_group) = unsafe { (libc::getpgid(pid), libc::getpgrp()) };
    assert_ne!(child_group, -1);
    assert_eq!(
        child_group, outer_group,
        "file leaves must retain the host ownership group"
    );
    let mut stdin = execution.stdin.take().unwrap();
    stdin.write_all(b"echo").unwrap();
    drop(stdin);
    execution.cancel.0.scope.wait_exited().unwrap();
    // A second observation succeeds only if the first left the child unreaped;
    // settlement can then reap it under the same lock used by cancel().
    assert!(execution.cancel.wait().unwrap().success());
    execution.settled = true;
    execution.cancellation().cancel().unwrap();
}

#[cfg(windows)]
#[test]
fn closing_the_nested_job_kills_its_stdin_waiting_child() {
    let mut command = command();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    platform::prepare(&mut command);
    let mut child = command.spawn().unwrap();
    let scope = platform::Scope::attach(&child).unwrap();
    assert!(
        child.try_wait().unwrap().is_none(),
        "stdin has not been fed"
    );
    drop(scope); // No explicit termination: this asserts KILL_ON_JOB_CLOSE itself.
    let deadline = Instant::now() + Duration::from_secs(5);
    let exited = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            break None;
        }
        thread::sleep(Duration::from_millis(5));
    };
    if exited.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    // Job close may report exit code zero; the property is that the still-owned
    // stdin-waiting process exited without an explicit kill or input delivery.
    assert!(exited.is_some(), "closing the Job must end the child");
}
