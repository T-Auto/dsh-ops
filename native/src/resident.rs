//! One host-owned control loop. Blocking file execution lives in individually
//! terminable leaves, never in this loop or in an abandoned Rust thread.
use dsh_ops_core::contract::{Failure, envelope};
use ops_process::{
    ControlPipe,
    leaf::{Cancel, Execution},
    read_frame_limit,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufReader, Write},
    sync::{Arc, Mutex},
    thread,
};

const WINDOW: usize = 32;
const FRAME_BYTES: usize = envelope::MAX_REQUEST_BYTES + 256;
type Output = Arc<Mutex<ControlPipe>>;
type Active = Arc<Mutex<HashMap<String, Arc<Mutex<RequestState>>>>>;
#[derive(Default)]
struct RequestState {
    cancelled: bool,
    leaf: Option<Cancel>,
}

fn send(output: &Output, value: Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    output
        .lock()
        .map_err(|_| io::Error::other("control writer panicked"))?
        .write_all(&bytes)
}
fn interrupted() -> Value {
    json!({"exitCode":null,"interrupted":true,"readers":true,"lossy":false,"stderr":""})
}
fn refused(code: &str, message: &str) -> Value {
    json!({"exitCode":0,"interrupted":false,"readers":true,"lossy":false,"stderr":"",
        "value":{"status":"error","error":Failure::new(code, message)}})
}
fn cancel(state: &Arc<Mutex<RequestState>>) {
    let mut state = state.lock().unwrap();
    state.cancelled = true;
    if let Some(leaf) = &state.leaf {
        let _ = leaf.cancel();
    }
}
fn execute(input: Vec<u8>, id: &str, state: &Arc<Mutex<RequestState>>, output: &Output) -> Value {
    if state.lock().unwrap().cancelled {
        return interrupted();
    }
    let execution = (|| {
        Execution::spawn(
            &std::env::current_exe()?,
            &std::env::current_dir()?,
            envelope::MAX_OUTPUT_BYTES,
            16 * 1024,
        )
    })();
    let execution = match execution {
        Ok(execution) => execution,
        Err(error) => {
            return refused(
                "EXECUTOR_UNAVAILABLE",
                &format!("Execution leaf could not start: {error}"),
            );
        }
    };
    {
        let mut current = state.lock().unwrap();
        current.leaf = Some(execution.cancellation());
        if current.cancelled {
            let _ = current.leaf.as_ref().unwrap().cancel();
        }
    }
    // From here the caller must conservatively treat an unconfirmed effect as
    // unknown. No request bytes reach the child before ownership is established.
    if send(output, json!({"type":"started","requestId":id})).is_err() {
        cancel(state);
        drop(execution);
        return interrupted();
    }
    let capture = execution.run(input);
    let mut current = state.lock().unwrap();
    current.leaf = None;
    match capture {
        Err(error) => {
            json!({"exitCode":null,"interrupted":true,"readers":true,"lossy":false,"stderr":error.to_string()})
        }
        Ok(capture) => {
            let stopped = current.cancelled || capture.status.code().is_none();
            let mut exchange = json!({"exitCode":capture.status.code(),"interrupted":stopped,"readers":true,
                "lossy":capture.stdout_lossy,"stderr":String::from_utf8_lossy(&capture.stderr)});
            if capture.status.success() && !stopped && !capture.stdout_lossy {
                match serde_json::from_slice::<Value>(&capture.stdout) {
                    Ok(value) if value.is_object() => exchange["value"] = value,
                    Ok(_) => exchange["invalid"] = json!("shape"),
                    Err(_) => exchange["invalid"] = json!("json"),
                }
            }
            exchange
        }
    }
}
fn request_id(value: &Value) -> io::Result<String> {
    value
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
        .map(str::to_owned)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid requestId"))
}

pub fn serve() -> io::Result<()> {
    let pipe = ControlPipe::inherited()?;
    let mut reader = BufReader::new(pipe.try_clone()?);
    let output = Arc::new(Mutex::new(pipe));
    let shell_output = output.clone();
    let shell_shutdown = reader.get_ref().try_clone()?;
    let mut shells = crate::shell::Manager::new(
        move |value| send(&shell_output, value),
        move || {
            let _ = shell_shutdown.shutdown();
        },
    )?;
    let task_shutdown = reader.get_ref().try_clone()?;
    let mut task_manager = crate::task::Manager::new(shells.output(), move || {
        let _ = task_shutdown.shutdown();
    })?;
    #[cfg(windows)]
    {
        let spill_store = ops_process::shell::SpillStore::new(
            &std::env::temp_dir(),
            ops_process::shell::MAX_SPILL_BYTES,
        )?;
        task_manager.enable_spill(spill_store.clone())?;
        shells.enable_spill(spill_store)?;
    }
    let active: Active = Arc::default();
    let mut tasks: Vec<thread::JoinHandle<()>> = Vec::new();
    let mut capabilities = crate::shell::capabilities();
    #[cfg(windows)]
    capabilities
        .as_array_mut()
        .unwrap()
        .push(json!("shell-spill-v1"));
    capabilities
        .as_array_mut()
        .unwrap()
        .extend(crate::task::capabilities().iter().map(|value| json!(value)));
    send(
        &output,
        json!({"type":"ready","version":1,"pid":std::process::id(),"capabilities":capabilities}),
    )?;
    let result = (|| {
        while let Some(frame) = read_frame_limit(&mut reader, FRAME_BYTES)? {
            shells.reap()?;
            task_manager.reap()?;
            // Join finished executions without keeping one thread handle per past call.
            let mut index = 0;
            while index < tasks.len() {
                if tasks[index].is_finished() {
                    let _ = tasks.swap_remove(index).join();
                } else {
                    index += 1;
                }
            }
            let message: Value = serde_json::from_slice(&frame)?;
            match message["type"].as_str() {
                Some("execute") => {
                    let envelope = &message["envelope"];
                    let id = request_id(&envelope["requestId"])?;
                    if shells.contains(&id) || task_manager.contains(&id) {
                        return Err(io::Error::other("duplicate kernel requestId"));
                    }
                    let input = serde_json::to_vec(envelope)?;
                    if input.len() > envelope::MAX_REQUEST_BYTES {
                        return Err(io::Error::other("request exceeds 2 MiB"));
                    }
                    let state = Arc::new(Mutex::new(RequestState::default()));
                    {
                        let mut requests = active.lock().unwrap();
                        // Overflow and duplicate active IDs are protocol violations, not
                        // requests to replay or an invitation to accumulate an idle queue.
                        if requests.len() >= WINDOW || requests.contains_key(&id) {
                            return Err(io::Error::other(
                                "request window full or duplicate requestId",
                            ));
                        }
                        requests.insert(id.clone(), state.clone());
                    }
                    let (output, active) = (output.clone(), active.clone());
                    tasks.push(thread::spawn(move || {
                        let exchange = execute(input, &id, &state, &output);
                        // Release the admission slot BEFORE publishing completion.
                        // Holding the writer limits removed-but-blocked replies to one;
                        // other slow replies retain their slots and apply backpressure.
                        let mut writer = output.lock().unwrap();
                        active.lock().unwrap().remove(&id);
                        if let Ok(mut bytes) = serde_json::to_vec(
                            &json!({"type":"completed","requestId":id,"exchange":exchange}),
                        ) {
                            bytes.push(b'\n');
                            let _ = writer.write_all(&bytes);
                        }
                    }));
                }
                Some("cancel") => {
                    let id = request_id(&message["requestId"])?;
                    let state = active.lock().unwrap().get(&id).cloned();
                    if let Some(state) = state {
                        cancel(&state);
                    }
                    shells.cancel(&id)?;
                    task_manager.cancel(&id)?;
                }
                Some("shutdown") => break,
                Some(kind) if kind.starts_with("shell.") => {
                    let id = request_id(&message["requestId"])?;
                    if active.lock().unwrap().contains_key(&id) || task_manager.contains(&id) {
                        return Err(io::Error::other(
                            "shell requestId conflicts with a file request",
                        ));
                    }
                    shells.handle(&message)?;
                }
                Some(kind) if kind.starts_with("task.") => {
                    let id = request_id(&message["requestId"])?;
                    if active.lock().unwrap().contains_key(&id) || shells.contains(&id) {
                        return Err(io::Error::other(
                            "task requestId conflicts with another kernel request",
                        ));
                    }
                    task_manager.handle(&message)?;
                }
                _ => return Err(io::Error::other("unknown kernel control message")),
            }
        }
        Ok(())
    })();
    // A peer may half-close input while refusing to drain replies. Cancel I/O
    // through the independently held reader handle before joining blocked writers.
    // Future writes also fail, so teardown cannot race a newly started reply.
    let shutdown = reader.get_ref().shutdown();
    // EOF belongs to the owning host connection, not a page, heartbeat or call.
    // Keep the control loop responsive during filesystem operations; each leaf
    // has its own cancellation range and must settle before this owner exits.
    let states: Vec<_> = active.lock().unwrap().values().cloned().collect();
    for state in states {
        cancel(&state);
    }
    let task_shutdown = task_manager.shutdown();
    let shell_shutdown = shells.shutdown();
    for task in tasks {
        let _ = task.join();
    }
    result.and(shutdown).and(task_shutdown).and(shell_shutdown)
}
