//! Repository-only acknowledgement fixture using the actual production Manager.
#![forbid(unsafe_code)]
#[cfg(windows)]
#[path = "../src/shell/mod.rs"]
mod shell;
#[cfg(windows)]
mod probe {
    use super::shell;
    use ops_process::{ControlPipe, read_frame, shell::signal_console_and_exit};
    use serde_json::{Value, json};
    use std::{
        io::{self, BufReader, Write},
        path::PathBuf,
        sync::{Arc, Condvar, Mutex},
    };

    struct Gate {
        ready: Option<PathBuf>,
        released: bool,
    }
    fn release(gate: &(Mutex<Gate>, Condvar)) {
        gate.0.lock().unwrap().released = true;
        gate.1.notify_all();
    }
    pub fn run() -> io::Result<()> {
        if std::env::args().nth(1).as_deref() == Some("--ops-signal-console") {
            let pid = std::env::args()
                .nth(2)
                .and_then(|value| value.parse().ok())
                .ok_or_else(|| io::Error::other("signal pid required"))?;
            signal_console_and_exit(pid);
        }
        let pipe = ControlPipe::inherited()?;
        let mut reader = BufReader::new(pipe.try_clone()?);
        let writer = Arc::new(Mutex::new(pipe));
        let gate = Arc::new((
            Mutex::new(Gate {
                ready: None,
                released: true,
            }),
            Condvar::new(),
        ));
        let output = writer.clone();
        let blocked = gate.clone();
        let shutdown = reader.get_ref().try_clone()?;
        let mut manager = shell::Manager::new(
            move |value| {
                if value["type"] == "shell.started" {
                    let mut state = blocked.0.lock().unwrap();
                    if let Some(ready) = state.ready.take() {
                        // Out-of-band evidence that the physical-start write is held.
                        // The normal control reader continues accepting cancellation.
                        std::fs::write(ready, value["requestId"].as_str().unwrap())?;
                        while !state.released {
                            state = blocked.1.wait(state).unwrap();
                        }
                    }
                }
                writeln!(output.lock().unwrap(), "{value}")
            },
            move || {
                let _ = shutdown.shutdown();
            },
        )?;
        writeln!(
            writer.lock().unwrap(),
            "{}",
            json!({"type":"ready","pid":std::process::id(),"capabilities":shell::capabilities()})
        )?;
        let result = (|| {
            while let Some(bytes) = read_frame(&mut reader)? {
                let value: Value = serde_json::from_slice(&bytes)?;
                manager.reap()?;
                match value["type"].as_str().unwrap_or("") {
                    "fixture.arm" => {
                        let ready = PathBuf::from(
                            value["ready"]
                                .as_str()
                                .ok_or_else(|| io::Error::other("ready path required"))?,
                        );
                        if !ready.is_absolute() {
                            return Err(io::Error::other("absolute fixture path required"));
                        }
                        let mut state = gate.0.lock().unwrap();
                        if !state.released {
                            return Err(io::Error::other("fixture gate already armed"));
                        }
                        state.ready = Some(ready);
                        state.released = false;
                    }
                    "fixture.release" => release(&gate),
                    "shutdown" => break,
                    "cancel" => manager.cancel(
                        value["requestId"]
                            .as_str()
                            .ok_or_else(|| io::Error::other("request id required"))?,
                    )?,
                    _ => {
                        if value["type"] == "shell.execute"
                            && manager.contains(value["requestId"].as_str().unwrap_or(""))
                        {
                            return Err(io::Error::other("duplicate fixture request"));
                        }
                        manager.handle(&value)?;
                    }
                }
            }
            Ok(())
        })();
        // Always unblock the test gate before shutdown joins the output worker.
        release(&gate);
        let _ = reader.get_ref().shutdown();
        let cleanup = manager.shutdown();
        result.and(cleanup)
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
