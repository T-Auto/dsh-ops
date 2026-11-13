use super::Manager;
use serde_json::{Value, json};
use std::{
    io,
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

fn fixture() -> (Manager, Receiver<Value>) {
    let (sender, receiver) = mpsc::channel();
    (
        Manager::new(
            move |value| sender.send(value).map_err(io::Error::other),
            || {},
        )
        .unwrap(),
        receiver,
    )
}
fn execute(manager: &mut Manager, id: &str, owner: &str, timeout: u64) {
    manager.handle(&json!({"type":"shell.execute","requestId":id,"sessionKey":owner,
        "command":"printf should-not-run","timeoutMs":timeout,"stdoutBytes":1024,"stderrBytes":1024})).unwrap();
}
fn receive(receiver: &Receiver<Value>, kind: &str, id: &str) -> Value {
    let value = receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("kernel frame must arrive without awaiting an approval callback");
    assert_eq!(value["type"], kind, "{value}");
    assert_eq!(value["requestId"], id, "{value}");
    value
}
fn reject(manager: &mut Manager, id: &str) {
    manager
        .handle(
            &json!({"type":"shell.admission","requestId":id,"decision":"reject",
        "error":{"code":"POLICY_DENIED","message":"Test policy refused the unstarted command"}}),
        )
        .unwrap();
}

#[test]
fn shared_spill_configuration_is_allocation_only_and_precedes_admission() {
    let root =
        std::env::temp_dir().join(format!("ops-uncreated-shell-store-{}", std::process::id()));
    assert!(!root.exists());
    let store = ops_process::shell::SpillStore::new(&root, 1024).unwrap();
    let (mut manager, output) = fixture();
    manager.enable_spill(store.clone()).unwrap();
    assert!(
        !root.exists(),
        "configuration must not perform coordinator filesystem I/O"
    );
    assert!(manager.enable_spill(store.clone()).is_err());
    manager.shutdown().unwrap();
    let (mut manager, late_output) = fixture();
    execute(&mut manager, "late", "owner", 30_000);
    assert!(manager.enable_spill(store).is_err());
    manager.shutdown().unwrap();
    drop(output);
    drop(late_output);
}

#[test]
fn queued_expiry_and_cancellation_do_not_wait_for_the_active_approval() {
    let (mut manager, output) = fixture();
    execute(&mut manager, "head", "owner", 30_000);
    receive(&output, "shell.admit", "head");
    execute(&mut manager, "expires", "owner", 50);
    let expired = receive(&output, "shell.completed", "expires");
    assert_eq!(expired["error"]["code"], "TIMEOUT");
    assert_eq!(expired["effectState"], "none");
    assert_eq!(expired["shellState"], "preserved");
    execute(&mut manager, "cancelled", "owner", 30_000);
    manager.cancel("cancelled").unwrap();
    assert_eq!(
        receive(&output, "shell.completed", "cancelled")["error"]["code"],
        "CANCELLED"
    );
    execute(&mut manager, "sibling", "other", 30_000);
    receive(&output, "shell.admit", "sibling");
    reject(&mut manager, "sibling");
    assert_eq!(
        receive(&output, "shell.completed", "sibling")["status"],
        "rejected"
    );
    manager.cancel("head").unwrap();
    let head = receive(&output, "shell.completed", "head");
    assert_eq!(head["cleanupConfirmed"], true);
    assert_eq!(head["effectState"], "none");
    assert_eq!(head["shellState"], "reset");
    manager.shutdown().unwrap();
}

#[test]
fn control_retire_cancels_the_head_but_re_admits_the_queued_request() {
    let (mut manager, output) = fixture();
    execute(&mut manager, "head", "owner", 30_000);
    receive(&output, "shell.admit", "head");
    execute(&mut manager, "next", "owner", 30_000);
    manager.handle(&json!({"type":"shell.retire","requestId":"retire","sessionKey":"owner","reason":"policy changed"})).unwrap();
    let head = receive(&output, "shell.completed", "head");
    assert_eq!(head["status"], "cancelled");
    assert_eq!(head["effectState"], "none");
    assert_eq!(
        receive(&output, "shell.closed", "retire")["cleanupConfirmed"],
        true
    );
    assert_eq!(receive(&output, "shell.admit", "next")["hasShell"], false);
    // A late response from the retired head cannot authorize the next request.
    reject(&mut manager, "head");
    reject(&mut manager, "next");
    receive(&output, "shell.completed", "next");
    manager.shutdown().unwrap();
}

#[test]
fn admission_retire_keeps_the_same_unstarted_request_and_rotates_endpoints() {
    let (mut manager, output) = fixture();
    execute(&mut manager, "same", "owner", 30_000);
    let first = receive(&output, "shell.admit", "same");
    manager
        .handle(&json!({"type":"shell.admission","requestId":"same","decision":"retire"}))
        .unwrap();
    let second = receive(&output, "shell.admit", "same");
    assert_eq!(second["hasShell"], false);
    assert_ne!(first["bootstrap"], second["bootstrap"]);
    reject(&mut manager, "same");
    let done = receive(&output, "shell.completed", "same");
    assert_eq!(done["status"], "rejected");
    assert_eq!(done["effectState"], "none");
    assert_eq!(done["stdoutTotal"], 0);
    manager.handle(&json!({"type":"shell.read","requestId":"same","stream":"stdout","offset":0,"maxBytes":1})).unwrap();
    assert_eq!(receive(&output, "shell.output", "same")["eof"], true);
    manager.handle(&json!({"type":"shell.read","requestId":"same","stream":"stderr","offset":1,"maxBytes":1})).unwrap();
    assert_eq!(
        receive(&output, "shell.output", "same")["error"]["code"],
        "OUTPUT_INCOMPLETE"
    );
    manager
        .handle(&json!({"type":"shell.release","requestId":"same"}))
        .unwrap();
    assert!(!manager.contains("same"));
    manager.shutdown().unwrap();
}

#[test]
fn owner_close_joins_the_active_preparation_and_cancels_the_whole_queue() {
    let (mut manager, output) = fixture();
    execute(&mut manager, "head", "owner", 30_000);
    receive(&output, "shell.admit", "head");
    execute(&mut manager, "next", "owner", 30_000);
    manager.handle(&json!({"type":"shell.close","requestId":"close","sessionKey":"owner","reason":"owner disposed"})).unwrap();
    for id in ["head", "next"] {
        let value = receive(&output, "shell.completed", id);
        assert_eq!(value["status"], "cancelled");
        assert_eq!(value["effectState"], "none");
        assert_eq!(value["cleanupConfirmed"], true);
    }
    assert_eq!(
        receive(&output, "shell.closed", "close")["cleanupConfirmed"],
        true
    );
    let began = Instant::now();
    manager.shutdown().unwrap();
    assert!(
        began.elapsed() < Duration::from_secs(5),
        "deadline waiters must join promptly"
    );
}

#[test]
fn a_blocked_response_writer_does_not_block_control_dispatch() {
    use std::sync::{Arc, Condvar, Mutex};
    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let writer_gate = gate.clone();
    let (writing, writer_entered) = mpsc::channel();
    let (handled, dispatched) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut manager = Manager::new(
            move |_| {
                writing.send(()).unwrap();
                let (lock, wake) = &*writer_gate;
                let mut released = lock.lock().unwrap();
                while !*released {
                    released = wake.wait(released).unwrap();
                }
                Ok(())
            },
            || {},
        )
        .unwrap();
        manager.handle(&json!({"type":"shell.close","requestId":"close","sessionKey":"absent","reason":"disposed"})).unwrap();
        handled.send(()).unwrap();
        manager.shutdown().unwrap();
    });
    // Even if shutdown wins before the asynchronous writer starts, dispatch
    // must have returned. Wait for either event without depending on a sleep.
    let returned = dispatched.recv_timeout(Duration::from_secs(1)).is_ok();
    let _ = writer_entered.try_recv();
    let (lock, wake) = &*gate;
    *lock.lock().unwrap() = true;
    wake.notify_all();
    worker.join().unwrap();
    assert!(
        returned,
        "a blocked reply hid input EOF from the control reader"
    );
}

#[test]
fn asynchronous_completion_overflow_fails_transport_without_another_input_frame() {
    use std::sync::{Arc, Condvar, Mutex};

    struct ReleaseWriter(Arc<(Mutex<bool>, Condvar)>);
    impl Drop for ReleaseWriter {
        fn drop(&mut self) {
            let (lock, wake) = &*self.0;
            *lock.lock().unwrap() = true;
            wake.notify_all();
        }
    }

    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let writer_gate = gate.clone();
    let (writing, writer_entered) = mpsc::channel();
    let (fatal, failed) = mpsc::channel();
    let mut manager = Manager::new(
        move |value| {
            writing.send(value).map_err(io::Error::other)?;
            let (lock, wake) = &*writer_gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = wake.wait(released).unwrap();
            }
            Ok(())
        },
        move || {
            let _ = fatal.send(());
        },
    )
    .unwrap();
    // Declared after Manager so unwinding always releases the writer before
    // Manager::drop joins it, including if a setup assertion fails.
    let release_writer = ReleaseWriter(gate);
    execute(&mut manager, "head", "owner", 30_000);
    receive(&writer_entered, "shell.admit", "head");

    // The first physical write is held, so these exactly fill the reply queue.
    // Absent owners require neither session workers nor shell processes.
    for index in 0..super::manager::REPLY_WINDOW {
        manager
            .handle(
                &json!({"type":"shell.close","requestId":format!("fill-{index}"),
                "sessionKey":"absent","reason":"fill the bounded reply window"}),
            )
            .unwrap();
    }
    assert!(
        failed.try_recv().is_err(),
        "the bounded queue should still fit"
    );

    // This is the final input. Its session worker, not the control reader,
    // publishes the overflowing completion after consuming this admission.
    reject(&mut manager, "head");
    let notified = failed.recv_timeout(Duration::from_secs(5)).is_ok();
    // Do not call handle/reap to discover the failure; the callback must wake
    // the transport itself. Always release the held writer before any join.
    drop(release_writer);
    let cleanup = manager.shutdown();
    assert!(
        notified,
        "asynchronous reply loss did not fail the transport"
    );
    assert!(
        cleanup
            .unwrap_err()
            .to_string()
            .contains("shell response window unavailable"),
        "the lifecycle thread must retain its enqueue failure"
    );
}
