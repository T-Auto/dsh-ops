//! Repository-only Driver vertical. No scheduler or model-facing session API.
#![forbid(unsafe_code)]
#[cfg(windows)]
#[path = "../src/shell/driver.rs"]
mod driver;
#[cfg(windows)]
mod probe {
    use super::driver::Driver;
    use ops_process::{
        ControlPipe, read_frame,
        shell::{Launch, MAX_SPILL_BYTES, SpillStore, signal_console_and_exit},
    };
    use serde_json::{Value, json};
    use std::{
        collections::BTreeMap,
        io::{self, BufReader, Write},
        sync::atomic::AtomicBool,
        time::{Duration, Instant},
    };

    fn text<'a>(value: &'a Value, name: &str) -> io::Result<&'a str> {
        value[name]
            .as_str()
            .ok_or_else(|| io::Error::other(format!("{name} string required")))
    }
    fn execute(
        value: &Value,
        drivers: &mut BTreeMap<String, Driver>,
        store: Option<&SpillStore>,
        fatal: &ControlPipe,
    ) -> io::Result<Value> {
        let id = text(value, "id")?;
        if value["op"] == "prepare" {
            if drivers.len() >= 4 || drivers.contains_key(id) {
                return Err(io::Error::other("probe capacity/duplicate"));
            }
            let driver = match store {
                Some(store) => Driver::prepare_with_spill(Some(store.clone()))?,
                None => Driver::prepare()?,
            };
            let endpoints = driver.bootstrap();
            drivers.insert(id.into(), driver);
            return Ok(endpoints);
        }
        let driver = drivers
            .get_mut(id)
            .ok_or_else(|| io::Error::other("unknown driver"))?;
        match text(value, "op")? {
            "launch" => {
                let argv = value["argv"]
                    .as_array()
                    .ok_or_else(|| io::Error::other("argv required"))?
                    .iter()
                    .map(|arg| {
                        arg.as_str()
                            .map(Into::into)
                            .ok_or_else(|| io::Error::other("argument string required"))
                    })
                    .collect::<io::Result<Vec<_>>>()?;
                let env = value["env"]
                    .as_object()
                    .ok_or_else(|| io::Error::other("env required"))?
                    .iter()
                    .map(|(key, value)| {
                        value
                            .as_str()
                            .map(|value| (key.into(), value.into()))
                            .ok_or_else(|| io::Error::other("env string required"))
                    })
                    .collect::<io::Result<Vec<_>>>()?;
                let result = driver.launch(
                    Launch {
                        argv,
                        env,
                        cwd: text(value, "cwd")?.into(),
                        output_cap: 4096,
                    },
                    &AtomicBool::new(false),
                    Instant::now() + Duration::from_secs(10),
                );
                if let Err(error) = result {
                    let cleanup = driver.stop();
                    if driver.cleanup_unconfirmed() {
                        fatal.shutdown()?;
                    }
                    return Err(io::Error::other(format!("{error}; cleanup={cleanup:?}")));
                }
                Ok(json!({"ready":true}))
            }
            "call" => {
                let deadline = Instant::now()
                    + Duration::from_millis(
                        value["timeoutMs"].as_u64().unwrap_or(5000).clamp(1, 10000),
                    );
                let mut call = driver.call(text(value, "requestId")?, 1024, 1024)?;
                let views = call.views();
                let outcome = driver.run(
                    &mut call,
                    text(value, "command")?,
                    value["commandCwd"].as_str(),
                    deadline,
                    &AtomicBool::new(false),
                );
                let mut cleanup = None;
                if outcome.is_err() {
                    cleanup = driver.stop().err().map(|error| error.to_string());
                    if let Err(error) = call.drain(Instant::now() + Duration::from_secs(5)) {
                        cleanup.get_or_insert(error.to_string());
                    }
                }
                if driver.cleanup_unconfirmed() || call.cleanup_unconfirmed() {
                    // Independent transport shutdown precedes Drop, which retains
                    // every unjoined channel reader until the public host kills us.
                    fatal.shutdown()?;
                    return Err(io::Error::other(
                        "channel cleanup unconfirmed; host teardown required",
                    ));
                }
                let outputs: Vec<_> = views.iter().map(|view| { let snapshot = view.snapshot();
                    let mut value = json!({"text":String::from_utf8_lossy(&snapshot.bytes),"observed":snapshot.observed,
                        "truncated":snapshot.truncated,"ready":snapshot.ready,"eof":snapshot.writer_eof,"errors":snapshot.errors});
                    if let Some(spill) = snapshot.spill { value["spillPath"]=json!(spill.path); value["spillOrigin"]=json!("ops-native-v1"); value["spillPid"]=json!(spill.pid); value["spillSealed"]=json!(spill.sealed); }
                    if let Some(error) = snapshot.spill_error { value["spillError"]=json!(error); }
                    value }).collect();
                Ok(
                    json!({"exitCode":outcome.as_ref().ok(),"error":outcome.err().map(|error|error.to_string()),
                    "reset":driver.stopped(),"cleanupError":cleanup,"outputs":outputs}),
                )
            }
            "live" => {
                driver.check_live()?;
                Ok(json!({"live":true}))
            }
            "stop" => {
                driver.stop()?;
                let stopped = driver.stopped();
                drivers.remove(id);
                Ok(json!({"stopped":stopped}))
            }
            _ => Err(io::Error::other("unknown operation")),
        }
    }
    pub fn run() -> io::Result<()> {
        if std::env::args().nth(1).as_deref() == Some("--ops-signal-console") {
            let pid = std::env::args()
                .nth(2)
                .and_then(|value| value.parse().ok())
                .ok_or_else(|| io::Error::other("target pid required"))?;
            signal_console_and_exit(pid);
        }
        let mut writer = ControlPipe::inherited()?;
        let mut reader = BufReader::new(writer.try_clone()?);
        let mut drivers = BTreeMap::new();
        let store = std::env::args()
            .any(|arg| arg == "--spill")
            .then(|| SpillStore::new(&std::env::temp_dir(), MAX_SPILL_BYTES))
            .transpose()?;
        writeln!(
            writer,
            "{}",
            json!({"type":"ready","pid":std::process::id()})
        )?;
        let outcome = (|| {
            while let Some(bytes) = read_frame(&mut reader)? {
                let value: Value = serde_json::from_slice(&bytes)?;
                let response = match execute(&value, &mut drivers, store.as_ref(), &writer) {
                    Ok(result) => json!({"ok":true,"result":result}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                };
                writeln!(writer, "{response}")?;
            }
            Ok(())
        })();
        let mut cleanup = None;
        for driver in drivers.values_mut() {
            if let Err(error) = driver.stop() {
                cleanup.get_or_insert(error);
            }
        }
        outcome.and(cleanup.map_or(Ok(()), Err))
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
