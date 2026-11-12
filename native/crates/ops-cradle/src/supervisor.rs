//! One supervisor owns task Jobs. The resident worker only validates launch data.
use crate::{protocol, windows as os, worker};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io,
    sync::{
        Arc,
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_TASKS: usize = 32;
const IDLE: Duration = Duration::from_secs(300);
enum Event {
    Request(Value),
    Prepared(u64, io::Result<worker::Launch>),
    Launch(u64),
    Exit(u64, io::Result<u32>),
    Empty(u64),
    Drained(u64, usize, bool),
}
struct Output {
    value: Value,
    drained: Option<(u64, usize, bool)>,
}
struct OwnedTask {
    job: Option<os::Handle>,
    prepared: Option<io::Result<worker::Launch>>,
    exit: Option<u32>,
    empty: bool,
    drained: [bool; 2],
    output_error: bool,
    cancelled: bool,
    settled: bool,
}
impl OwnedTask {
    fn queued() -> Self {
        Self {
            job: None,
            prepared: None,
            exit: None,
            empty: false,
            drained: [false; 2],
            output_error: false,
            cancelled: false,
            settled: false,
        }
    }
}
fn send(output: &SyncSender<Output>, value: Value) -> io::Result<()> {
    // Control must never wait behind a client that stopped consuming output.
    output
        .try_send(Output {
            value,
            drained: None,
        })
        .map_err(|_| io::Error::other("cradle control backpressure"))
}
fn workers(events: SyncSender<Event>) -> SyncSender<(u64, Value)> {
    let (input, requests) = mpsc::sync_channel::<(u64, Value)>(MAX_TASKS);
    thread::spawn(move || {
        for (id, value) in requests {
            // A failed scheduling computation never owns (or replays) a launched task.
            let prepared = std::panic::catch_unwind(|| worker::prepare(value))
                .unwrap_or_else(|_| Err(io::Error::other("cradle worker failed before launch")));
            if events.send(Event::Prepared(id, prepared)).is_err() {
                break;
            }
        }
    });
    input
}
fn stream(id: u64, channel: usize, handle: os::Handle, output: SyncSender<Output>) {
    thread::spawn(move || {
        let mut bytes = [0; 8192];
        let mut failed = false;
        loop {
            match os::read(&handle, &mut bytes) {
                Ok(0) => break,
                Ok(count) => {
                    // Bounded queue propagates backpressure to the task's pipe, not to control.
                    if output.send(Output { value: json!({"v":1,"type":"output","id":id,"channel":channel,"hex":protocol::hex(&bytes[..count])}), drained: None }).is_err() { return; }
                }
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
        let _ = output.send(Output {
            value: json!({"v":1,"type":"streamEnd","id":id,"channel":channel,"failed":failed}),
            drained: Some((id, channel, failed)),
        });
    });
}
fn request_id(value: &Value) -> io::Result<u64> {
    value["id"]
        .as_u64()
        .filter(|id| *id > 0 && *id <= 9_007_199_254_740_991)
        .ok_or_else(|| io::Error::other("invalid request id"))
}

pub fn run(parent: u32, nonce: String) -> io::Result<()> {
    if nonce.len() != 32 || !nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(io::Error::other("invalid instance nonce"));
    }
    // Open once before hello. The private inherited connection completes identity proof; no PID polling.
    let parent = os::open_parent(parent)?;
    thread::spawn(move || {
        let _ = os::wait(&parent);
        os::exit_owner();
    });
    let (events, receiver) = mpsc::sync_channel(256);
    let (output, outgoing) = mpsc::sync_channel::<Output>(256);
    let writer_events = events.clone();
    thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        for message in outgoing {
            if protocol::write(&mut stdout, &message.value).is_err() {
                os::exit_owner();
            }
            if let Some((id, channel, failed)) = message.drained {
                if writer_events
                    .send(Event::Drained(id, channel, failed))
                    .is_err()
                {
                    return;
                }
            }
        }
    });
    let input_events = events.clone();
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            match protocol::read(&mut stdin) {
                Ok(Some(value)) => {
                    if input_events.send(Event::Request(value)).is_err() {
                        return;
                    }
                }
                // A broken control connection is an explicit termination event, not a heartbeat timeout.
                _ => os::exit_owner(),
            }
        }
    });
    let port = Arc::new(os::CompletionPort::new()?);
    let observer = port.clone();
    let job_events = events.clone();
    thread::spawn(move || {
        loop {
            match observer.next() {
                Ok((4, id)) => {
                    if job_events.send(Event::Empty(id as u64)).is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(_) => os::exit_owner(),
            }
        }
    });
    let worker = workers(events.clone());
    send(&output, json!({"v":1,"type":"hello","nonce":nonce}))?;
    serve(receiver, events, output, worker, port, &nonce)
}
fn serve(
    receiver: Receiver<Event>,
    events: SyncSender<Event>,
    output: SyncSender<Output>,
    worker: SyncSender<(u64, Value)>,
    port: Arc<os::CompletionPort>,
    nonce: &str,
) -> io::Result<()> {
    let mut tasks: HashMap<u64, OwnedTask> = HashMap::new();
    let mut authenticated = false;
    let mut last_id = 0;
    let mut idle_since = Instant::now();
    loop {
        let event = if tasks.is_empty() {
            match receiver.recv_timeout(IDLE.saturating_sub(idle_since.elapsed())) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    send(&output, json!({"v":1,"type":"draining"}))?;
                    return Ok(());
                }
                Err(_) => return Ok(()),
            }
        } else {
            receiver.recv().map_err(io::Error::other)?
        };
        match event {
            Event::Request(value) => {
                if value["v"] != 1 {
                    return Err(io::Error::other("cradle protocol mismatch"));
                }
                let kind = value["type"].as_str().unwrap_or("");
                if !authenticated {
                    if kind != "hello" || value["nonce"] != nonce {
                        return Err(io::Error::other("cradle handshake refused"));
                    }
                    authenticated = true;
                    send(&output, json!({"v":1,"type":"ready"}))?;
                    idle_since = Instant::now();
                    continue;
                }
                if kind == "shutdown" {
                    return Ok(());
                }
                let id = request_id(&value)?;
                match kind {
                    "start" => {
                        if id <= last_id {
                            return Err(io::Error::other(
                                "request ids must increase; replay forbidden",
                            ));
                        }
                        last_id = id;
                        if tasks.len() >= MAX_TASKS {
                            send(
                                &output,
                                json!({"v":1,"type":"rejected","id":id,"error":"cradle capacity exhausted","effectState":"none"}),
                            )?;
                            continue;
                        }
                        tasks.insert(id, OwnedTask::queued());
                        send(&output, json!({"v":1,"type":"accepted","id":id}))?;
                        worker
                            .try_send((id, value))
                            .map_err(|_| io::Error::other("cradle worker queue unavailable"))?;
                    }
                    "commit" => {
                        if !tasks.get(&id).is_some_and(|task| task.prepared.is_some()) {
                            return Err(io::Error::other("invalid launch commit"));
                        }
                        events
                            .try_send(Event::Launch(id))
                            .map_err(io::Error::other)?;
                    }
                    "cancel" => {
                        if let Some(task) = tasks.get_mut(&id) {
                            task.cancelled = true;
                            if let Some(job) = &task.job {
                                os::terminate(job)?;
                            } else if task.prepared.is_some() {
                                events
                                    .try_send(Event::Launch(id))
                                    .map_err(io::Error::other)?;
                            }
                        }
                    }
                    "ack" => {
                        if !tasks.get(&id).is_some_and(|task| task.settled) {
                            return Err(io::Error::other("invalid result acknowledgement"));
                        }
                        tasks.remove(&id);
                        if tasks.is_empty() {
                            idle_since = Instant::now();
                        }
                    }
                    _ => return Err(io::Error::other("unknown cradle request")),
                }
            }
            Event::Prepared(id, launch) => {
                let task = tasks
                    .get_mut(&id)
                    .ok_or_else(|| io::Error::other("unknown prepared task"))?;
                task.prepared = Some(launch);
                if task.cancelled {
                    events
                        .try_send(Event::Launch(id))
                        .map_err(io::Error::other)?;
                } else {
                    send(&output, json!({"v":1,"type":"prepared","id":id}))?;
                }
            }
            Event::Launch(id) => {
                let Some(task) = tasks.get_mut(&id) else {
                    return Err(io::Error::other("unknown prepared task"));
                };
                // A queued cancel and commit can both wake this task; only the first consumes it.
                let Some(launch) = task.prepared.take() else {
                    continue;
                };
                let launch = if task.cancelled {
                    Err(io::Error::other("cancelled before launch"))
                } else {
                    launch
                };
                match launch.and_then(|launch| {
                    os::spawn(
                        &launch.argv,
                        &launch.cwd,
                        &launch.env,
                        port.0.0,
                        id as usize,
                    )
                }) {
                    Ok(child) => {
                        task.job = Some(child.job);
                        send(&output, json!({"v":1,"type":"started","id":id}))?;
                        stream(id, 0, child.stdout, output.clone());
                        stream(id, 1, child.stderr, output.clone());
                        let events = events.clone();
                        thread::spawn(move || {
                            let result = os::wait(&child.process)
                                .and_then(|()| os::exit_code(&child.process));
                            let _ = events.send(Event::Exit(id, result));
                        });
                    }
                    Err(error) => {
                        task.settled = true;
                        send(
                            &output,
                            json!({"v":1,"type":"settled","id":id,"error":error.to_string(),"effectState":"none","cancelled":task.cancelled}),
                        )?;
                    }
                }
            }
            Event::Exit(id, result) => {
                let task = tasks
                    .get_mut(&id)
                    .ok_or_else(|| io::Error::other("unknown process exit"))?;
                let code = result?;
                task.exit = Some(code);
                send(
                    &output,
                    json!({"v":1,"type":"targetExit","id":id,"exitCode":code}),
                )?;
            }
            Event::Empty(id) => {
                if let Some(task) = tasks.get_mut(&id) {
                    task.empty = true;
                }
            }
            Event::Drained(id, channel, failed) => {
                let task = tasks
                    .get_mut(&id)
                    .ok_or_else(|| io::Error::other("unknown output completion"))?;
                task.drained[channel] = true;
                task.output_error |= failed;
            }
        }
        for (id, task) in &mut tasks {
            if !task.settled && task.empty && task.exit.is_some() && task.drained == [true, true] {
                task.settled = true;
                task.job.take();
                send(
                    &output,
                    json!({"v":1,"type":"settled","id":id,"exitCode":task.exit,"cancelled":task.cancelled,
                    "treeSettled":true,"outputError":task.output_error}),
                )?;
            }
        }
    }
}
