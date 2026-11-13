use super::{protocol, worker};
use ops_process::shell::{CaptureView, Range};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const RECORDS: usize = 32;
type Output = Arc<dyn Fn(Value) -> io::Result<()> + Send + Sync>;
pub(super) struct State {
    pub output: Output,
    pub fatal: Arc<dyn Fn() + Send + Sync>,
    pub requests: Mutex<HashMap<String, Arc<Request>>>,
    pub owners: Mutex<HashMap<String, Arc<Owner>>>,
    pub controls: Mutex<HashSet<String>>,
    pub queue: Mutex<VecDeque<Arc<Request>>>,
    pub wake: Condvar,
    pub closing: AtomicBool,
}
pub(super) struct Owner {
    pub key: String,
    pub data: Mutex<OwnerData>,
}
#[derive(Default)]
pub(super) struct OwnerData {
    pub pending: HashSet<String>,
    pub controls: Vec<String>,
    pub closed: bool,
    pub unconfirmed: bool,
}
pub(super) struct Request {
    pub id: String,
    pub owner: Arc<Owner>,
    pub deadline: Option<Instant>,
    pub grace: Duration,
    pub cancelled: AtomicBool,
    pub data: Mutex<Data>,
    pub wake: Condvar,
}
#[derive(Default, Eq, PartialEq)]
pub(super) enum Phase {
    #[default]
    Queued,
    Admitting,
    Launching,
    Running,
    Cleaning,
    Completed,
}
#[derive(Default)]
pub(super) struct Data {
    pub phase: Phase,
    pub admission: Option<Value>,
    pub job: bool,
    pub effects_possible: bool,
    pub views: Option<[CaptureView; 2]>,
    pub terminal: Option<Value>,
    pub poison: Option<Range>,
}
pub struct Manager {
    state: Arc<State>,
    tasks: Vec<JoinHandle<io::Result<()>>>,
}
impl Manager {
    pub fn new(output: Output, fatal: impl Fn() + Send + Sync + 'static) -> io::Result<Self> {
        let mut manager = Self {
            state: Arc::new(State {
                output,
                fatal: Arc::new(fatal),
                requests: Mutex::default(),
                owners: Mutex::default(),
                controls: Mutex::default(),
                queue: Mutex::default(),
                wake: Condvar::new(),
                closing: AtomicBool::new(false),
            }),
            tasks: Vec::new(),
        };
        for _ in 0..8 {
            let state = manager.state.clone();
            manager.tasks.push(
                thread::Builder::new()
                    .name("ops-task".into())
                    .spawn(move || worker::run(state))?,
            );
        }
        Ok(manager)
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
                    .map_err(|_| io::Error::other("task lifecycle thread panicked"))??;
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
            Some("task.execute") => self.execute(id, value),
            Some("task.closeOwner") => self.close_owner(id, value),
            Some("task.read") => self.read(id, value),
            Some("task.release") => {
                let mut requests = self.state.requests.lock().unwrap();
                let request = requests
                    .get(&id)
                    .ok_or_else(|| protocol::invalid("unknown task release"))?;
                if request.data.lock().unwrap().phase != Phase::Completed {
                    return Err(protocol::invalid("task released before completion"));
                }
                requests.remove(&id);
                Ok(())
            }
            Some("task.admission" | "task.promote") => {
                let request = self
                    .state
                    .requests
                    .lock()
                    .unwrap()
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| protocol::invalid("unknown task request"))?;
                let mut data = request.data.lock().unwrap();
                if value["type"] == "task.promote" {
                    let accepted = data.phase == Phase::Running
                        && !request.cancelled.load(Ordering::Acquire)
                        && !request
                            .deadline
                            .is_some_and(|deadline| Instant::now() >= deadline);
                    if accepted {
                        data.job = true;
                    }
                    drop(data);
                    return (self.state.output)(
                        json!({"type":"task.promoted","requestId":id,"accepted":accepted}),
                    );
                }
                if data.phase == Phase::Completed || request.cancelled.load(Ordering::Acquire) {
                    return Ok(());
                }
                if data.phase != Phase::Admitting || data.admission.is_some() {
                    return Err(protocol::invalid("unexpected task admission"));
                }
                protocol::admission(value)?;
                data.admission = Some(value.clone());
                request.wake.notify_all();
                Ok(())
            }
            _ => Err(protocol::invalid("unknown task message")),
        }
    }
    fn execute(&mut self, id: String, value: &Value) -> io::Result<()> {
        if self.contains(&id) {
            return Err(protocol::invalid("duplicate task request identity"));
        }
        let key = protocol::id(value, "ownerKey")?;
        let grace = protocol::duration(value, "graceMs")?;
        let deadline = if value["timeoutMs"].is_null() {
            None
        } else {
            Some(Instant::now() + protocol::duration(value, "timeoutMs")?)
        };
        let job = match value["lifetime"].as_str() {
            Some("foreground") => false,
            Some("job") => true,
            _ => return Err(protocol::invalid("invalid task lifetime")),
        };
        protocol::number(&value["output"], "memoryBytes", 64000, 64000)?;
        protocol::number(&value["output"], "spillBytes", 67108864, 67108864)?;
        if self.state.requests.lock().unwrap().len() >= RECORDS {
            return Err(protocol::invalid("task record capacity exceeded"));
        }
        let owner = {
            let mut owners = self.state.owners.lock().unwrap();
            if let Some(owner) = owners.get(&key) {
                owner.clone()
            } else {
                if owners.len() >= RECORDS {
                    return Err(protocol::invalid("task owner capacity exceeded"));
                }
                let owner = Arc::new(Owner {
                    key: key.clone(),
                    data: Mutex::default(),
                });
                owners.insert(key, owner.clone());
                owner
            }
        };
        let request = Arc::new(Request {
            id: id.clone(),
            owner: owner.clone(),
            deadline,
            grace,
            cancelled: AtomicBool::new(false),
            data: Mutex::new(Data {
                job,
                ..Data::default()
            }),
            wake: Condvar::new(),
        });
        self.state
            .requests
            .lock()
            .unwrap()
            .insert(id.clone(), request.clone());
        let (closed, cleanup) = {
            let mut data = owner.data.lock().unwrap();
            data.pending.insert(id);
            (data.closed, !data.unconfirmed)
        };
        if closed {
            return finish(
                &self.state,
                &request,
                "rejected",
                None,
                cleanup,
                Some(("OWNER_CLOSED", "Task owner is closed".into())),
            );
        }
        {
            let mut queue = self.state.queue.lock().unwrap();
            queue.push_back(request.clone());
            self.state.wake.notify_one();
        }
        if let Some(deadline) = deadline {
            let state = self.state.clone();
            self.tasks.push(
                thread::Builder::new()
                    .name("ops-task-deadline".into())
                    .spawn(move || {
                        let mut data = request.data.lock().unwrap();
                        while data.phase != Phase::Completed
                            && !state.closing.load(Ordering::Acquire)
                        {
                            let remaining = deadline.saturating_duration_since(Instant::now());
                            if remaining.is_zero() {
                                drop(data);
                                return cancel(&state, &request);
                            }
                            data = request.wake.wait_timeout(data, remaining).unwrap().0;
                        }
                        Ok(())
                    })?,
            );
        }
        Ok(())
    }
    fn close_owner(&self, id: String, value: &Value) -> io::Result<()> {
        if self.contains(&id) {
            return Err(protocol::invalid("duplicate task control identity"));
        }
        let key = protocol::id(value, "ownerKey")?;
        protocol::text(value, "reason", 4096)?;
        let owner = self.state.owners.lock().unwrap().get(&key).cloned();
        let Some(owner) = owner else {
            return (self.state.output)(
                json!({"type":"task.ownerClosed","requestId":id,"cleanupConfirmed":true}),
            );
        };
        {
            let mut controls = self.state.controls.lock().unwrap();
            if controls.len() >= 64 {
                return Err(protocol::invalid("task owner control capacity exceeded"));
            }
            controls.insert(id.clone());
        }
        let ids = {
            let mut data = owner.data.lock().unwrap();
            data.closed = true;
            data.controls.push(id);
            data.pending.iter().cloned().collect::<Vec<_>>()
        };
        for id in ids {
            self.cancel(&id)?;
        }
        acknowledge(&self.state, &owner)
    }
    fn read(&self, id: String, value: &Value) -> io::Result<()> {
        let stream = protocol::text(value, "stream", 8)?;
        let index = match stream {
            "stdout" => 0,
            "stderr" => 1,
            _ => return Err(protocol::invalid("invalid task stream")),
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
            .ok_or_else(|| protocol::invalid("unknown task output"))?;
        let data = request.data.lock().unwrap();
        let snapshot = data.views.as_ref().map(|views| views[index].snapshot());
        let completed = data.phase == Phase::Completed;
        let effects = data.effects_possible;
        drop(data);
        let mut result = json!({"type":"task.output","requestId":id,"stream":stream,"offset":offset,
            "retainedOffset":offset,"nextOffset":offset,"bytesBase64":"","lossy":false,"eof":false});
        if let Some(snapshot) = snapshot {
            if offset > snapshot.observed {
                result["error"] = json!({"code":"OUTPUT_INCOMPLETE","message":"Task output cursor exceeds observed bytes"});
                return (self.state.output)(result);
            }
            let start = offset.max(snapshot.retained_offset).min(snapshot.observed);
            let relative =
                (start - snapshot.retained_offset).min(snapshot.bytes.len() as u64) as usize;
            let available = &snapshot.bytes[relative..];
            // A bounded snapshot returns the newest bytes if a smaller caller cap
            // cannot fit the full suffix; the skipped bytes are explicitly lossy.
            let skip = available.len().saturating_sub(max);
            result["retainedOffset"] = json!(start + skip as u64);
            result["nextOffset"] = json!(snapshot.observed);
            result["bytesBase64"] = json!(protocol::base64(&available[skip..]));
            result["lossy"] = json!(start > offset || skip != 0);
            result["eof"] = json!(snapshot.eof);
            let error = snapshot.error.or_else(|| {
                (completed && !snapshot.eof)
                    .then(|| "Task output did not reach confirmed EOF".into())
            });
            if let Some(error) = error {
                result["error"] = json!({"code":"OUTPUT_INCOMPLETE","message":error});
            }
        } else {
            result["eof"] = json!(completed && !effects && offset == 0);
            if offset != 0 || (completed && effects) {
                result["error"] =
                    json!({"code":"OUTPUT_INCOMPLETE","message":"Task output was not available"});
            }
        }
        (self.state.output)(result)
    }
    pub fn shutdown(&mut self) -> io::Result<()> {
        self.state.closing.store(true, Ordering::Release);
        for request in self.state.requests.lock().unwrap().values() {
            let _data = request.data.lock().unwrap();
            request.cancelled.store(true, Ordering::Release);
            request.wake.notify_all();
        }
        {
            let _queue = self.state.queue.lock().unwrap();
            self.state.wake.notify_all();
        }
        let mut failure = None;
        for task in self.tasks.drain(..) {
            if let Err(error) = task
                .join()
                .unwrap_or_else(|_| Err(io::Error::other("task lifecycle thread panicked")))
            {
                failure.get_or_insert(error);
            }
        }
        self.state.queue.lock().unwrap().clear();
        self.state.requests.lock().unwrap().clear();
        self.state.owners.lock().unwrap().clear();
        failure.map_or(Ok(()), Err)
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
    let removed = {
        let mut queue = state.queue.lock().unwrap();
        queue
            .iter()
            .position(|queued| Arc::ptr_eq(queued, request))
            .and_then(|index| queue.remove(index))
            .is_some()
    };
    if removed {
        let (code, message) = cancellation(request);
        finish(
            state,
            request,
            "cancelled",
            None,
            true,
            Some((code, message.into())),
        )?;
    }
    Ok(())
}
pub(super) fn cancellation(request: &Request) -> (&'static str, &'static str) {
    if request
        .deadline
        .is_some_and(|deadline| Instant::now() >= deadline)
    {
        ("TIMEOUT", "Task deadline exceeded")
    } else {
        ("CANCELLED", "Task cancelled")
    }
}
pub(super) fn finish(
    state: &State,
    request: &Request,
    status: &str,
    exit_code: Option<u32>,
    cleanup: bool,
    error: Option<(&str, String)>,
) -> io::Result<()> {
    let mut data = request.data.lock().unwrap();
    if data.phase == Phase::Completed {
        return Ok(());
    }
    let totals = data
        .views
        .as_ref()
        .map(|views| views.each_ref().map(|view| view.snapshot().observed))
        .unwrap_or([0, 0]);
    let mut value = json!({"type":"task.completed","requestId":request.id,"status":status,"exitCode":exit_code,"signal":null,
        "effectState":if data.effects_possible {"unknown"} else {"none"},"cleanupConfirmed":cleanup,"stdoutTotal":totals[0],"stderrTotal":totals[1]});
    if let Some((code, message)) = error {
        value["error"] = json!({"code":code,"message":message});
    }
    data.phase = Phase::Completed;
    data.terminal = Some(value.clone());
    request.wake.notify_all();
    drop(data);
    let publication = if state.closing.load(Ordering::Acquire) {
        Ok(())
    } else {
        (state.output)(value)
    };
    {
        let mut owner = request.owner.data.lock().unwrap();
        owner.pending.remove(&request.id);
        owner.unconfirmed |= !cleanup;
    }
    publication?;
    acknowledge(state, &request.owner)
}
fn acknowledge(state: &State, owner: &Arc<Owner>) -> io::Result<()> {
    let (controls, confirmed) = {
        let mut data = owner.data.lock().unwrap();
        if !data.closed || !data.pending.is_empty() {
            return Ok(());
        }
        (std::mem::take(&mut data.controls), !data.unconfirmed)
    };
    for id in controls {
        state.controls.lock().unwrap().remove(&id);
        if !state.closing.load(Ordering::Acquire) {
            let mut reply =
                json!({"type":"task.ownerClosed","requestId":id,"cleanupConfirmed":confirmed});
            if !confirmed {
                reply["error"] = json!({"code":"CLEANUP_UNKNOWN","message":"Task owner cleanup was not confirmed"});
            }
            (state.output)(reply)?;
        }
    }
    if confirmed {
        let mut owners = state.owners.lock().unwrap();
        if owners
            .get(&owner.key)
            .is_some_and(|current| Arc::ptr_eq(current, owner))
        {
            owners.remove(&owner.key);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sealed_owner_queued_before_request_cancel_never_requests_admission() {
        let (send, receive) = std::sync::mpsc::channel();
        let mut manager = Manager::new(
            Arc::new(move |value| send.send(value).map_err(io::Error::other)),
            || {},
        )
        .unwrap();
        let owner = Arc::new(Owner {
            key: "sealed-owner".into(),
            data: Mutex::new(OwnerData {
                closed: true,
                pending: HashSet::from(["queued".into()]),
                ..OwnerData::default()
            }),
        });
        let request = Arc::new(Request {
            id: "queued".into(),
            owner: owner.clone(),
            deadline: None,
            grace: Duration::ZERO,
            cancelled: AtomicBool::new(false),
            data: Mutex::new(Data::default()),
            wake: Condvar::new(),
        });
        manager
            .state
            .owners
            .lock()
            .unwrap()
            .insert(owner.key.clone(), owner);
        manager
            .state
            .requests
            .lock()
            .unwrap()
            .insert(request.id.clone(), request.clone());
        // Seal the owner before close_owner reaches this request's cancel flag.
        manager.state.queue.lock().unwrap().push_back(request);
        manager.state.wake.notify_one();
        let first = receive.recv_timeout(Duration::from_secs(5));
        // Join even a broken admission waiter before asserting the first frame.
        manager.shutdown().unwrap();
        let first = first.expect("queued request must publish without approval");
        assert_eq!(first["type"], "task.completed", "{first}");
        assert_eq!(first["requestId"], "queued");
        assert_eq!(first["effectState"], "none");
        assert_eq!(first["cleanupConfirmed"], true);
    }

    #[test]
    fn uncertain_owner_cleanup_has_a_structured_error_and_keeps_the_owner_poisoned() {
        let replies = Arc::new(Mutex::new(Vec::new()));
        let output = replies.clone();
        let mut manager = Manager::new(
            Arc::new(move |value| {
                output.lock().unwrap().push(value);
                Ok(())
            }),
            || {},
        )
        .unwrap();
        let owner = Arc::new(Owner {
            key: "failed-owner".into(),
            data: Mutex::new(OwnerData {
                closed: true,
                unconfirmed: true,
                controls: vec!["close".into()],
                ..OwnerData::default()
            }),
        });
        manager
            .state
            .owners
            .lock()
            .unwrap()
            .insert(owner.key.clone(), owner.clone());
        manager
            .state
            .controls
            .lock()
            .unwrap()
            .insert("close".into());
        acknowledge(&manager.state, &owner).unwrap();
        let reply = replies.lock().unwrap()[0].clone();
        assert_eq!(reply["type"], "task.ownerClosed");
        assert_eq!(reply["cleanupConfirmed"], false);
        assert_eq!(reply["error"]["code"], "CLEANUP_UNKNOWN");
        assert!(
            manager
                .state
                .owners
                .lock()
                .unwrap()
                .contains_key(&owner.key)
        );
        assert!(!manager.contains("close"));
        manager.shutdown().unwrap();
    }
}
