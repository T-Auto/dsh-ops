use super::{protocol, session};
use ops_process::shell::ChannelView;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const RECORDS: usize = 32;
type Output = Arc<dyn Fn(Value) -> io::Result<()> + Send + Sync>;
type Started = Arc<dyn Fn(Value) -> io::Result<mpsc::Receiver<io::Result<()>>> + Send + Sync>;
type Response = (Value, Option<mpsc::SyncSender<io::Result<()>>>);
pub(super) struct State {
    pub output: Output,
    pub started: Started,
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub requests: Mutex<HashMap<String, Arc<Request>>>,
    pub controls: Mutex<HashSet<String>>,
    pub closing: Arc<AtomicBool>,
}
pub(super) struct Session {
    pub key: String,
    pub queue: Mutex<Queue>,
    pub wake: Condvar,
}
#[derive(Default)]
pub(super) struct Queue {
    pub requests: VecDeque<Arc<Request>>,
    pub active: Option<Arc<Request>>,
    pub controls: Vec<Control>,
    pub closing: bool,
    pub terminal_cleanup: Option<bool>,
}
pub(super) struct Control {
    pub id: String,
    pub close: bool,
}
pub(super) struct Request {
    pub id: String,
    pub command: String,
    pub caps: [usize; 2],
    pub deadline: Instant,
    pub session: Arc<Session>,
    pub cancelled: AtomicBool,
    pub expired: AtomicBool,
    pub data: Mutex<Data>,
    pub wake: Condvar,
}
#[derive(Default)]
pub(super) struct Data {
    pub awaiting: bool,
    pub has_shell: bool,
    pub admission: Option<Value>,
    pub started: bool,
    pub completed: bool,
    pub views: Option<[ChannelView; 2]>,
}
pub struct Manager {
    state: Arc<State>,
    tasks: Vec<JoinHandle<io::Result<()>>>,
}
impl Manager {
    pub fn new(
        output: impl Fn(Value) -> io::Result<()> + Send + Sync + 'static,
        fatal: impl Fn() + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let closing = Arc::new(AtomicBool::new(false));
        let writer_closing = closing.clone();
        let fatal = Arc::new(fatal);
        let writer_fatal = fatal.clone();
        // One response writer keeps the input reader responsive to EOF even if
        // the peer stops consuming output. The window covers every admitted
        // request, both stream reads and all owner controls, without unbounded
        // writer threads. Sending beyond that window is a protocol violation.
        let (sender, receiver) = mpsc::sync_channel::<Response>(256);
        let writer = thread::Builder::new()
            .name("ops-shell-output".into())
            .spawn(move || {
                while !writer_closing.load(Ordering::Acquire) {
                    match receiver.recv_timeout(Duration::from_millis(50)) {
                        Ok((value, delivered)) => {
                            let result = output(value);
                            if let Some(delivered) = delivered {
                                let receipt = result.as_ref().map(|_| ()).map_err(|error| {
                                    io::Error::new(error.kind(), error.to_string())
                                });
                                let _ = delivered.send(receipt);
                            }
                            if let Err(error) = result {
                                writer_fatal();
                                return Err(error);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                Ok(())
            })?;
        let started_sender = sender.clone();
        let started_fatal = fatal.clone();
        Ok(Self {
            state: Arc::new(State {
                output: Arc::new(move |value| {
                    sender.try_send((value, None)).map_err(|error| {
                        // A deadline/session completion can fail after the last
                        // input frame. Wake the reader now; reap cannot wait for
                        // another request to notice that a reply was lost.
                        fatal();
                        io::Error::other(format!("shell response window unavailable: {error}"))
                    })
                }),
                // Only the session worker waits here. Publish started on the
                // physical pipe before any command bytes enter the shell.
                started: Arc::new(move |value| {
                    let (delivered, receipt) = mpsc::sync_channel(1);
                    started_sender
                        .try_send((value, Some(delivered)))
                        .map_err(|error| {
                            started_fatal();
                            io::Error::other(format!("shell response window unavailable: {error}"))
                        })?;
                    Ok(receipt)
                }),
                sessions: Mutex::default(),
                requests: Mutex::default(),
                controls: Mutex::default(),
                closing,
            }),
            tasks: vec![writer],
        })
    }
    pub fn contains(&self, id: &str) -> bool {
        self.state.requests.lock().unwrap().contains_key(id)
            || self.state.controls.lock().unwrap().contains(id)
    }
    pub fn reap(&mut self) -> io::Result<()> {
        let mut index = 0;
        while index < self.tasks.len() {
            if self.tasks[index].is_finished() {
                self.tasks
                    .swap_remove(index)
                    .join()
                    .map_err(|_| io::Error::other("shell lifecycle thread panicked"))??;
            } else {
                index += 1;
            }
        }
        Ok(())
    }
    pub fn cancel(&self, id: &str) -> io::Result<()> {
        let request = self.state.requests.lock().unwrap().get(id).cloned();
        if let Some(request) = request {
            cancel(&self.state, &request)?;
        }
        Ok(())
    }
    pub fn handle(&mut self, value: &Value) -> io::Result<()> {
        let id = protocol::id(value, "requestId")?;
        match value["type"].as_str() {
            Some("shell.execute") => self.execute(id, value),
            Some("shell.admission") => {
                let request = self.state.requests.lock().unwrap().get(&id).cloned();
                if let Some(request) = request {
                    let mut data = request.data.lock().unwrap();
                    if data.completed || request.cancelled.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    if !data.awaiting || data.admission.is_some() {
                        return Err(protocol::invalid("unexpected shell admission reply"));
                    }
                    protocol::admission(value, data.has_shell)?;
                    data.admission = Some(value.clone());
                    request.wake.notify_all();
                }
                Ok(())
            }
            Some("shell.retire" | "shell.close") => self.control(id, value),
            Some("shell.read") => self.read(id, value),
            Some("shell.release") => {
                let mut requests = self.state.requests.lock().unwrap();
                let request = requests
                    .get(&id)
                    .ok_or_else(|| protocol::invalid("unknown shell release"))?;
                if !request.data.lock().unwrap().completed {
                    return Err(protocol::invalid("shell released before completion"));
                }
                requests.remove(&id);
                Ok(())
            }
            _ => Err(protocol::invalid("unknown shell message")),
        }
    }
    fn execute(&mut self, id: String, value: &Value) -> io::Result<()> {
        if self.contains(&id) {
            return Err(protocol::invalid("duplicate shell request identity"));
        }
        let command = protocol::text(value, "command", 1024 * 1024)?.to_owned();
        if command.trim().is_empty() {
            return Err(protocol::invalid("empty shell command"));
        }
        let key = protocol::id(value, "sessionKey")?;
        let timeout = protocol::number(value, "timeoutMs", 1, 2_147_483_647)?;
        let caps = [
            protocol::number(value, "stdoutBytes", 1, 128 * 1024)? as usize,
            protocol::number(value, "stderrBytes", 1, 128 * 1024)? as usize,
        ];
        if self.state.requests.lock().unwrap().len() >= RECORDS {
            return Err(protocol::invalid("shell record capacity exceeded"));
        }
        let (session, created) = {
            let mut sessions = self.state.sessions.lock().unwrap();
            if let Some(session) = sessions.get(&key) {
                (session.clone(), false)
            } else {
                if sessions.len() >= RECORDS {
                    return Err(protocol::invalid("shell session capacity exceeded"));
                }
                let session = Arc::new(Session {
                    key: key.clone(),
                    queue: Mutex::default(),
                    wake: Condvar::new(),
                });
                sessions.insert(key, session.clone());
                (session, true)
            }
        };
        let request = Arc::new(Request {
            id: id.clone(),
            command,
            caps,
            deadline: Instant::now() + Duration::from_millis(timeout),
            session: session.clone(),
            cancelled: AtomicBool::new(false),
            expired: AtomicBool::new(false),
            data: Mutex::default(),
            wake: Condvar::new(),
        });
        self.state
            .requests
            .lock()
            .unwrap()
            .insert(id, request.clone());
        {
            let mut queue = session.queue.lock().unwrap();
            if queue.closing {
                let cleanup = queue.terminal_cleanup.unwrap_or(false);
                drop(queue);
                return finish(
                    &self.state,
                    &request,
                    "rejected",
                    None,
                    true,
                    cleanup,
                    Some(("OWNER_CLOSED", "Shell owner is closed".into())),
                );
            }
            queue.requests.push_back(request.clone());
            session.wake.notify_all();
        }
        if created {
            let (state, session) = (self.state.clone(), session.clone());
            self.tasks.push(
                thread::Builder::new()
                    .name("ops-shell-session".into())
                    .spawn(move || session::run(state, session))?,
            );
        }
        let state = self.state.clone();
        self.tasks.push(
            thread::Builder::new()
                .name("ops-shell-deadline".into())
                .spawn(move || {
                    let mut data = request.data.lock().unwrap();
                    while !data.completed && !state.closing.load(Ordering::Acquire) {
                        let remaining = request.deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            request.expired.store(true, Ordering::Release);
                            drop(data);
                            return cancel(&state, &request);
                        }
                        data = request.wake.wait_timeout(data, remaining).unwrap().0;
                    }
                    Ok(())
                })?,
        );
        Ok(())
    }
    fn control(&mut self, id: String, value: &Value) -> io::Result<()> {
        if self.contains(&id) {
            return Err(protocol::invalid("duplicate shell control identity"));
        }
        let key = protocol::id(value, "sessionKey")?;
        protocol::text(value, "reason", 4096)?;
        let close = value["type"] == "shell.close";
        let session = self.state.sessions.lock().unwrap().get(&key).cloned();
        let Some(session) = session else {
            return (self.state.output)(
                json!({"type":"shell.closed","requestId":id,"cleanupConfirmed":true}),
            );
        };
        let mut queue = session.queue.lock().unwrap();
        if let Some(confirmed) = queue.terminal_cleanup {
            drop(queue);
            let mut frame =
                json!({"type":"shell.closed","requestId":id,"cleanupConfirmed":confirmed});
            if !confirmed {
                frame["error"] = json!({"code":"CLEANUP_UNKNOWN","message":"Previous owner cleanup was not confirmed"});
            }
            return (self.state.output)(frame);
        }
        let mut controls = self.state.controls.lock().unwrap();
        if controls.len() >= 64 {
            return Err(protocol::invalid("shell control capacity exceeded"));
        }
        controls.insert(id.clone());
        drop(controls);
        queue.closing |= close;
        queue.controls.push(Control { id, close });
        if let Some(active) = &queue.active {
            let _data = active.data.lock().unwrap();
            active.cancelled.store(true, Ordering::Release);
            active.wake.notify_all();
        }
        session.wake.notify_all();
        Ok(())
    }
    fn read(&self, id: String, value: &Value) -> io::Result<()> {
        let stream = protocol::text(value, "stream", 8)?;
        let index = match stream {
            "stdout" => 0,
            "stderr" => 1,
            _ => return Err(protocol::invalid("invalid shell stream")),
        };
        let offset = protocol::number(value, "offset", 0, 9_007_199_254_740_991)?;
        let max = protocol::number(value, "maxBytes", 1, 65536)? as usize;
        let request = self
            .state
            .requests
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| protocol::invalid("unknown shell output request"))?;
        let data = request.data.lock().unwrap();
        let snapshot = data.views.as_ref().map(|views| views[index].snapshot());
        let completed = data.completed;
        let started = data.started;
        drop(data);
        let mut response = json!({"type":"shell.output","requestId":id,"stream":stream,"offset":offset,"nextOffset":offset,
            "bytesBase64":"","lossy":false,"eof":false});
        if let Some(snapshot) = snapshot {
            let start = usize::try_from(offset)
                .unwrap_or(usize::MAX)
                .min(snapshot.bytes.len());
            let end = start.saturating_add(max).min(snapshot.bytes.len());
            let bytes = &snapshot.bytes[start..end];
            let mut next = offset + bytes.len() as u64;
            if end == snapshot.bytes.len() && snapshot.truncated {
                next = next.max(snapshot.observed);
            }
            response["nextOffset"] = json!(next);
            response["bytesBase64"] = json!(protocol::base64(bytes));
            response["lossy"] = json!(snapshot.truncated);
            response["eof"] = json!(
                (snapshot.writer_eof || (!started && completed && snapshot.observed == 0))
                    && next == snapshot.observed
            );
            let error = snapshot.errors.first().cloned().or_else(|| {
                (offset > snapshot.observed
                    || (completed
                        && !response["eof"].as_bool().unwrap()
                        && bytes.is_empty()
                        && next == offset))
                    .then(|| "Output did not reach a confirmed EOF".into())
            });
            if let Some(error) = error {
                response["error"] = json!({"code":"OUTPUT_INCOMPLETE","message":error});
            }
        } else {
            response["eof"] = json!(completed && offset == 0);
            if offset != 0 {
                response["error"] = json!({"code":"OUTPUT_INCOMPLETE","message":"Output offset exceeds the observed stream"});
            }
        }
        (self.state.output)(response)
    }
    pub fn shutdown(&mut self) -> io::Result<()> {
        self.state.closing.store(true, Ordering::Release);
        for request in self.state.requests.lock().unwrap().values() {
            let _data = request.data.lock().unwrap();
            request.cancelled.store(true, Ordering::Release);
            request.wake.notify_all();
        }
        for session in self.state.sessions.lock().unwrap().values() {
            let _queue = session.queue.lock().unwrap();
            session.wake.notify_all();
        }
        let mut error = None;
        for task in self.tasks.drain(..) {
            if let Err(failure) = task
                .join()
                .unwrap_or_else(|_| Err(io::Error::other("shell lifecycle thread panicked")))
            {
                error.get_or_insert(failure);
            }
        }
        for session in self.state.sessions.lock().unwrap().values() {
            let mut queue = session.queue.lock().unwrap();
            queue.requests.clear();
            queue.active = None;
        }
        self.state.requests.lock().unwrap().clear();
        self.state.sessions.lock().unwrap().clear();
        error.map_or(Ok(()), Err)
    }
}
impl Drop for Manager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub(super) fn cancel(state: &State, request: &Arc<Request>) -> io::Result<()> {
    {
        let _data = request.data.lock().unwrap();
        request.cancelled.store(true, Ordering::Release);
        request.wake.notify_all();
    }
    let mut queue = request.session.queue.lock().unwrap();
    let removed = queue
        .requests
        .iter()
        .position(|queued| Arc::ptr_eq(queued, request))
        .and_then(|index| queue.requests.remove(index))
        .is_some();
    drop(queue);
    if removed {
        let (code, message) = cancellation(request);
        finish(
            state,
            request,
            "cancelled",
            None,
            false,
            true,
            Some((code, message.into())),
        )?;
    }
    Ok(())
}
pub(super) fn cancellation(request: &Request) -> (&'static str, &'static str) {
    if request.expired.load(Ordering::Acquire) || Instant::now() >= request.deadline {
        ("TIMEOUT", "Shell request deadline exceeded")
    } else {
        ("CANCELLED", "Shell request cancelled")
    }
}
pub(super) fn finish(
    state: &State,
    request: &Request,
    status: &str,
    exit_code: Option<i32>,
    reset: bool,
    cleanup: bool,
    error: Option<(&str, String)>,
) -> io::Result<()> {
    let mut data = request.data.lock().unwrap();
    if data.completed {
        return Ok(());
    }
    data.completed = true;
    data.awaiting = false;
    request.wake.notify_all();
    let totals = data
        .views
        .as_ref()
        .map(|views| views.each_ref().map(|view| view.snapshot().observed))
        .unwrap_or([0, 0]);
    let started = data.started;
    drop(data);
    let mut value = json!({"type":"shell.completed","requestId":request.id,"status":status,"exitCode":exit_code,
        "effectState":if started {"unknown"} else {"none"},"shellState":if reset {"reset"} else {"preserved"},
        "cleanupConfirmed":cleanup,"stdoutTotal":totals[0],"stderrTotal":totals[1]});
    if let Some((code, message)) = error {
        value["error"] = json!({"code":code,"message":message});
    }
    if state.closing.load(Ordering::Acquire) {
        Ok(())
    } else {
        (state.output)(value)
    }
}
