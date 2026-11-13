use super::{Manager, protocol};
use serde_json::{Value, json};
use std::{
    io,
    sync::{
        Arc,
        mpsc::{self, Receiver},
    },
    time::Duration,
};

fn fixture() -> (Manager, Receiver<Value>) {
    let (send, receive) = mpsc::channel();
    (
        Manager::new(
            Arc::new(move |value| send.send(value).map_err(io::Error::other)),
            || {},
        )
        .unwrap(),
        receive,
    )
}
fn execute(manager: &mut Manager, id: &str, owner: &str, timeout: f64) {
    manager
        .handle(
            &json!({"type":"task.execute","requestId":id,"ownerKey":owner,"lifetime":"foreground",
        "timeoutMs":timeout,"graceMs":0.5,"output":{"memoryBytes":64000,"spillBytes":67108864}}),
        )
        .unwrap();
}
fn receive(output: &Receiver<Value>, kind: &str, id: &str) -> Value {
    let value = output
        .recv_timeout(Duration::from_secs(5))
        .expect("task frame must arrive without approval");
    assert_eq!(value["type"], kind, "{value}");
    assert_eq!(value["requestId"], id, "{value}");
    value
}

#[test]
fn queued_deadline_and_cancel_settle_without_waiting_for_eight_active_approvals() {
    let (mut manager, output) = fixture();
    for index in 0..8 {
        let id = format!("head-{index}");
        execute(&mut manager, &id, "busy", 30000.0);
        receive(&output, "task.admit", &id);
    }
    execute(&mut manager, "expires", "other", 10.5);
    let expired = receive(&output, "task.completed", "expires");
    assert_eq!(expired["error"]["code"], "TIMEOUT");
    assert_eq!(expired["effectState"], "none");
    assert_eq!(expired["cleanupConfirmed"], true);
    execute(&mut manager, "cancelled", "other", 30000.0);
    manager.cancel("cancelled").unwrap();
    assert_eq!(
        receive(&output, "task.completed", "cancelled")["error"]["code"],
        "CANCELLED"
    );
    manager.handle(&json!({"type":"task.read","requestId":"cancelled","stream":"stdout","offset":0,"maxBytes":1})).unwrap();
    assert_eq!(receive(&output, "task.output", "cancelled")["eof"], true);
    manager
        .handle(&json!({"type":"task.release","requestId":"cancelled"}))
        .unwrap();
    assert!(!manager.contains("cancelled"));
    manager.shutdown().unwrap();
}

#[test]
fn owner_close_publishes_every_unstarted_terminal_before_its_joined_acknowledgement() {
    let (mut manager, output) = fixture();
    for index in 0..8 {
        let id = format!("head-{index}");
        execute(&mut manager, &id, "closing", 30000.0);
        receive(&output, "task.admit", &id);
    }
    execute(&mut manager, "queued", "closing", 30000.0);
    manager.handle(&json!({"type":"task.closeOwner","requestId":"close","ownerKey":"closing","reason":"Agent disposed"})).unwrap();
    let mut completed = std::collections::HashSet::new();
    for _ in 0..9 {
        let value = output.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(value["type"], "task.completed", "{value}");
        assert_eq!(value["effectState"], "none");
        assert_eq!(value["cleanupConfirmed"], true);
        assert!(completed.insert(value["requestId"].as_str().unwrap().to_owned()));
    }
    assert_eq!(
        receive(&output, "task.ownerClosed", "close")["cleanupConfirmed"],
        true
    );
    // A stale approval cannot revive a command after owner cleanup.
    manager
        .handle(
            &json!({"type":"task.admission","requestId":"head-0","decision":"reject",
        "error":{"code":"LATE","message":"late reply"}}),
        )
        .unwrap();
    execute(&mut manager, "sibling", "new-owner", 30000.0);
    receive(&output, "task.admit", "sibling");
    manager.cancel("sibling").unwrap();
    receive(&output, "task.completed", "sibling");
    manager.shutdown().unwrap();
}

#[test]
fn task_deadlines_keep_the_existing_fractional_timer_contract() {
    assert_eq!(
        protocol::duration(&json!({"graceMs":0.5}), "graceMs").unwrap(),
        Duration::from_micros(500)
    );
    for value in [json!(0), json!(-1), json!(2147483648_u64), json!("1")] {
        assert!(protocol::duration(&json!({"graceMs":value}), "graceMs").is_err());
    }
}
