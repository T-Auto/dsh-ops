//! Repository-only kernel task owner. No model tool, host jobs adapter or spill parity claim.
#![forbid(unsafe_code)]
#[cfg(windows)]
mod probe {
    use ops_process::{
        ControlPipe, read_frame,
        shell::{CaptureView, Launch, Range, Retention, signal_console_and_exit},
    };
    use serde_json::{Value, json};
    use std::{
        collections::BTreeMap,
        io::{self, BufReader, Write},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };

    struct Task {
        views: [CaptureView; 2],
        state: Arc<Mutex<Value>>,
        cancel: Arc<AtomicBool>,
        worker: Option<JoinHandle<io::Result<()>>>,
    }
    impl Task {
        fn launch(value: &Value) -> io::Result<Self> {
            let argv = value["argv"]
                .as_array()
                .ok_or_else(|| io::Error::other("argv required"))?
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(Into::into)
                        .ok_or_else(|| io::Error::other("argv string required"))
                })
                .collect::<io::Result<_>>()?;
            let env = value["env"]
                .as_object()
                .ok_or_else(|| io::Error::other("env required"))?
                .iter()
                .map(|(k, v)| {
                    v.as_str()
                        .map(|v| (k.into(), v.into()))
                        .ok_or_else(|| io::Error::other("env string required"))
                })
                .collect::<io::Result<_>>()?;
            let mut range = Range::new()?;
            let pid = range.spawn_with_retention(
                Launch {
                    argv,
                    env,
                    cwd: text(value, "cwd")?.into(),
                    output_cap: value["cap"].as_u64().unwrap_or(64000) as usize,
                },
                Retention::Tail,
            )?;
            let views = range
                .output_views()
                .ok_or_else(|| io::Error::other("missing output views"))?;
            let state = Arc::new(Mutex::new(
                json!({"pid":pid,"rootExit":null,"terminal":false,"cleanupConfirmed":false}),
            ));
            let cancel = Arc::new(AtomicBool::new(false));
            let (state2, cancel2) = (state.clone(), cancel.clone());
            let explicit_background = value["background"] == true;
            let worker = thread::Builder::new()
                .name("ops-task-probe".into())
                .spawn(move || {
                    let result = monitor(&mut range, &state2, &cancel2, explicit_background);
                    let mut state = state2.lock().unwrap();
                    state["terminal"] = json!(true);
                    state["error"] = json!(result.as_ref().err().map(ToString::to_string));
                    result
                })?;
            Ok(Self {
                views,
                state,
                cancel,
                worker: Some(worker),
            })
        }
        fn stop(&mut self) -> io::Result<()> {
            self.cancel.store(true, Ordering::Release);
            self.worker.take().map_or(Ok(()), |worker| {
                worker
                    .join()
                    .unwrap_or_else(|_| Err(io::Error::other("task owner panicked")))
            })
        }
    }
    impl Drop for Task {
        fn drop(&mut self) {
            let _ = self.stop();
        }
    }

    fn monitor(
        range: &mut Range,
        state: &Mutex<Value>,
        cancel: &AtomicBool,
        background: bool,
    ) -> io::Result<()> {
        let watchdog = Instant::now() + Duration::from_secs(30);
        let mut root_observed = None;
        loop {
            let root = range.root_exit()?;
            let active = range.active_processes()?;
            {
                let mut state = state.lock().unwrap();
                state["rootExit"] = json!(root);
                state["active"] = json!(active);
            }
            if root.is_some() {
                root_observed.get_or_insert_with(Instant::now);
            }
            if active == 0 {
                range.wait_empty(Instant::now() + Duration::from_secs(1))?;
                break;
            }
            let fresh_expired = !background
                && root_observed.is_some_and(|when| when.elapsed() >= Duration::from_millis(100));
            if cancel.load(Ordering::Acquire) || fresh_expired || Instant::now() >= watchdog {
                // This fixture's explicit registration alone authorizes background lifetime.
                // Ordinary root exit never promotes descendants into a registered task.
                let attempt = if root.is_none() {
                    Some(
                        range
                            .interrupt(
                                &std::env::current_exe()?,
                                Instant::now() + Duration::from_secs(2),
                            )
                            .map_err(|e| e.to_string()),
                    )
                } else {
                    None
                };
                range.terminate(Instant::now() + Duration::from_secs(5))?;
                let mut state = state.lock().unwrap();
                state["reset"] = json!(true);
                state["signalAttempt"] = json!(attempt);
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let exit_code = range.wait_root_exit(Instant::now() + Duration::from_secs(5))?;
        range.captures()?;
        let mut state = state.lock().unwrap();
        state["rootExit"] = json!(exit_code);
        state["active"] = json!(range.active_processes()?);
        state["cleanupConfirmed"] = json!(true);
        Ok(())
    }
    fn text<'a>(value: &'a Value, key: &str) -> io::Result<&'a str> {
        value[key]
            .as_str()
            .ok_or_else(|| io::Error::other(format!("{key} required")))
    }
    fn execute(value: &Value, tasks: &mut BTreeMap<String, Task>) -> io::Result<Value> {
        let id = text(value, "id")?;
        if value["op"] == "launch" {
            if tasks.len() >= 4 || tasks.contains_key(id) {
                return Err(io::Error::other("probe capacity/duplicate"));
            }
            tasks.insert(id.into(), Task::launch(value)?);
        }
        let task = tasks
            .get_mut(id)
            .ok_or_else(|| io::Error::other("unknown task"))?;
        match text(value, "op")? {
            "launch" | "state" => Ok(task.state.lock().unwrap().clone()),
            "read" => {
                let index = value["stream"].as_u64().unwrap_or(0) as usize;
                let view = task
                    .views
                    .get(index)
                    .ok_or_else(|| io::Error::other("stream invalid"))?;
                let read = view.read_from(value["offset"].as_u64().unwrap_or(0))?;
                Ok(
                    json!({"text":String::from_utf8_lossy(&read.bytes),"offset":read.offset,"nextOffset":read.next_offset,"lossy":read.lossy,"eof":read.eof,"error":read.error}),
                )
            }
            "stop" => {
                task.stop()?;
                Ok(task.state.lock().unwrap().clone())
            }
            "remove" => {
                task.stop()?;
                tasks.remove(id);
                Ok(json!({"removed":true}))
            }
            _ => Err(io::Error::other("unknown operation")),
        }
    }
    pub fn run() -> io::Result<()> {
        if std::env::args().nth(1).as_deref() == Some("--fixture-child") {
            println!("child");
            loop {
                thread::sleep(Duration::from_secs(1));
            }
        }
        if std::env::args().nth(1).as_deref() == Some("--fixture-parent") {
            use std::os::windows::process::CommandExt;
            let child = std::process::Command::new(std::env::current_exe()?)
                .arg("--fixture-child")
                .stdin(std::process::Stdio::null())
                .creation_flags(0x08000000) // CREATE_NO_WINDOW; inherit the owning Job.
                .spawn()?;
            std::fs::write(
                std::env::args()
                    .nth(2)
                    .ok_or_else(|| io::Error::other("pid path required"))?,
                child.id().to_string(),
            )?;
            std::process::exit(23);
        }
        if std::env::args().nth(1).as_deref() == Some("--ops-signal-console") {
            signal_console_and_exit(
                std::env::args()
                    .nth(2)
                    .and_then(|v| v.parse().ok())
                    .ok_or_else(|| io::Error::other("pid required"))?,
            );
        }
        let mut writer = ControlPipe::inherited()?;
        let mut reader = BufReader::new(writer.try_clone()?);
        let mut tasks = BTreeMap::new();
        writeln!(
            writer,
            "{}",
            json!({"type":"ready","pid":std::process::id()})
        )?;
        let result = (|| {
            while let Some(bytes) = read_frame(&mut reader)? {
                let value: Value = serde_json::from_slice(&bytes)?;
                let response = match execute(&value, &mut tasks) {
                    Ok(result) => json!({"ok":true,"result":result}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                };
                writeln!(writer, "{response}")?;
            }
            Ok(())
        })();
        let mut cleanup = None;
        for task in tasks.values_mut() {
            if let Err(error) = task.stop() {
                cleanup.get_or_insert(error);
            }
        }
        result.and(cleanup.map_or(Ok(()), Err))
    }
}
#[cfg(windows)]
fn main() -> std::io::Result<()> {
    probe::run()
}
#[cfg(not(windows))]
fn main() -> std::io::Result<()> {
    Err(ops_process::shell::unsupported())
}
