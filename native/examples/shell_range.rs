//! Repository-only vertical probe. The host supplies already-confined argv and full env.
#![forbid(unsafe_code)]
#[cfg(windows)]
mod probe {
    use ops_process::{
        ControlPipe, read_frame,
        shell::{Capture, Channel, Launch, Range, signal_console_and_exit},
    };
    use serde_json::{Value, json};
    use std::{
        collections::BTreeMap,
        ffi::OsString,
        io::{self, BufReader, Write},
        time::{Duration, Instant},
    };
    struct Shell {
        range: Range,
        channels: Vec<Channel>,
    }
    fn capture(value: &Capture) -> Value {
        json!({"text":String::from_utf8_lossy(&value.bytes),"observed":value.observed,"truncated":value.truncated})
    }
    fn snapshot(shell: &Shell) -> io::Result<Value> {
        let channels: Vec<Value> = shell.channels.iter().map(|channel| { let value = channel.snapshot();
            json!({"text":String::from_utf8_lossy(&value.bytes),"observed":value.observed,"truncated":value.truncated,
                "accepted":value.accepted,"eof":value.eof,"rejected":value.rejected,"errors":value.errors}) }).collect();
        Ok(
            json!({"pid":shell.range.pid(),"active":shell.range.active_processes()?,"channels":channels}),
        )
    }
    fn execute(value: &Value, shells: &mut BTreeMap<String, Shell>) -> io::Result<Value> {
        let id = value["id"]
            .as_str()
            .ok_or_else(|| io::Error::other("id required"))?;
        match value["op"].as_str().unwrap_or("") {
            "ping" => {
                println!("shell-range stdout diagnostic");
                eprintln!("shell-range stderr diagnostic");
                return Ok(json!({"pong":true,"pid":std::process::id()}));
            }
            "prepare" => {
                if shells.len() >= 4 || shells.contains_key(id) {
                    return Err(io::Error::other("probe range capacity/duplicate"));
                }
                let range = Range::new()?;
                let channels = (0..3)
                    .map(|_| range.channel(1024))
                    .collect::<io::Result<Vec<_>>>()?;
                let names: Vec<_> = channels
                    .iter()
                    .map(|c| c.name().to_string_lossy().into_owned())
                    .collect();
                shells.insert(id.into(), Shell { range, channels });
                return Ok(json!({"names":names}));
            }
            _ => {}
        }
        let shell = shells
            .get_mut(id)
            .ok_or_else(|| io::Error::other("unknown range"))?;
        match value["op"].as_str().unwrap_or("") {
            "spawn" => {
                let argv = value["argv"]
                    .as_array()
                    .ok_or_else(|| io::Error::other("argv required"))?
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(OsString::from)
                            .ok_or_else(|| io::Error::other("argv string required"))
                    })
                    .collect::<io::Result<Vec<_>>>()?;
                let env = value["env"]
                    .as_object()
                    .ok_or_else(|| io::Error::other("env required"))?
                    .iter()
                    .map(|(k, v)| {
                        v.as_str()
                            .map(|v| (OsString::from(k), OsString::from(v)))
                            .ok_or_else(|| io::Error::other("env string required"))
                    })
                    .collect::<io::Result<Vec<_>>>()?;
                let cwd = value["cwd"]
                    .as_str()
                    .ok_or_else(|| io::Error::other("cwd required"))?
                    .into();
                Ok(json!({"pid":shell.range.spawn(Launch {argv,cwd,env,output_cap:1024})?}))
            }
            "snapshot" => snapshot(shell),
            "interrupt" => {
                shell.range.interrupt(
                    &std::env::current_exe()?,
                    Instant::now() + Duration::from_secs(2),
                )?;
                Ok(json!({"attempted":true}))
            }
            "interrupt-fault" => {
                let controller = value["controller"]
                    .as_str()
                    .ok_or_else(|| io::Error::other("fixture controller required"))?;
                shell.range.interrupt(
                    std::path::Path::new(controller),
                    Instant::now() + Duration::from_millis(500),
                )?;
                Err(io::Error::other("fault controller unexpectedly succeeded"))
            }
            "stop" | "finish" => {
                let deadline = Instant::now() + Duration::from_secs(5);
                if value["op"] == "stop" {
                    shell.range.terminate(deadline)?;
                } else {
                    shell.range.wait_empty(deadline)?;
                }
                for channel in &mut shell.channels {
                    channel.drain(deadline)?;
                }
                let outputs: Vec<_> = shell.range.captures()?.iter().map(capture).collect();
                let mut result = snapshot(shell)?;
                result["outputs"] = json!(outputs);
                result["exitCode"] = json!(shell.range.exit_code()?);
                shells.remove(id);
                Ok(result)
            }
            _ => Err(io::Error::other("unknown operation")),
        }
    }
    pub fn run() -> io::Result<()> {
        if std::env::args().nth(1).as_deref() == Some("--ops-signal-console") {
            let pid = std::env::args()
                .nth(2)
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| io::Error::other("signal target required"))?;
            signal_console_and_exit(pid);
        }
        let mut writer = ControlPipe::inherited()?;
        let mut reader = BufReader::new(writer.try_clone()?);
        let mut shells = BTreeMap::new();
        writeln!(
            writer,
            "{}",
            json!({"type":"ready","pid":std::process::id()})
        )?;
        while let Some(frame) = read_frame(&mut reader)? {
            let value: Value = serde_json::from_slice(&frame)?;
            let output = match execute(&value, &mut shells) {
                Ok(result) => json!({"ok":true,"result":result}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            };
            writeln!(writer, "{output}")?;
        }
        Ok(())
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
