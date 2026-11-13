//! Exact host-confined worker launches share the existing resident request lifetime.
use serde_json::Value;
use std::{collections::BTreeMap, io};
#[cfg(all(windows, test))]
#[path = "confined_tests.rs"]
mod lifecycle_tests;

pub(super) const LAUNCH_BYTES: usize = 64 * 1024;
pub(super) struct Launch {
    argv: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    #[cfg(windows)]
    deadline: std::time::Instant,
}
pub(super) fn parse(value: &Value, envelope: &Value) -> io::Result<Launch> {
    let timeout = envelope["budget"]["timeoutMs"]
        .as_u64()
        .filter(|value| (1..=2_147_483_647).contains(value))
        .ok_or_else(|| io::Error::other("confined launch requires timeoutMs 1..2147483647"))?;
    #[cfg(not(windows))]
    let _ = timeout;
    if envelope["component"] != "ptc"
        || !matches!(
            envelope["request"]["tool"].as_str(),
            Some("batch" | "result")
        )
    {
        return Err(io::Error::other(
            "confined launch requires a trusted batch/result envelope",
        ));
    }
    if serde_json::to_vec(value)?.len() > LAUNCH_BYTES {
        return Err(io::Error::other("confined launch exceeds 64 KiB"));
    }
    let object = value
        .as_object()
        .ok_or_else(|| io::Error::other("launch must be an object"))?;
    if object.len() != 3
        || object
            .keys()
            .any(|key| !["argv", "cwd", "env"].contains(&key.as_str()))
    {
        return Err(io::Error::other("launch requires only argv, cwd and env"));
    }
    let text = |value: &Value| {
        value
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| io::Error::other("launch values must be strings"))
    };
    let launch = Launch {
        #[cfg(windows)]
        deadline: std::time::Instant::now() + std::time::Duration::from_millis(timeout),
        argv: value["argv"]
            .as_array()
            .ok_or_else(|| io::Error::other("argv must be an array"))?
            .iter()
            .map(text)
            .collect::<io::Result<_>>()?,
        cwd: text(&value["cwd"])?,
        env: value["env"]
            .as_object()
            .ok_or_else(|| io::Error::other("env must be an object"))?
            .iter()
            .map(|(key, value)| Ok((key.clone(), text(value)?)))
            .collect::<io::Result<_>>()?,
    };
    if launch.argv.is_empty()
        || !std::path::Path::new(&launch.argv[0]).is_absolute()
        || !std::path::Path::new(&launch.cwd).is_absolute()
        || launch.argv.iter().any(|value| value.contains('\0'))
        || launch.cwd.contains('\0')
        || launch
            .env
            .iter()
            .any(|(key, value)| key.is_empty() || key.contains(['\0', '=']) || value.contains('\0'))
    {
        return Err(io::Error::other("invalid exact confined launch"));
    }
    #[cfg(not(windows))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "confined worker ownership requires Windows Jobs",
    ));
    #[cfg(windows)]
    Ok(launch)
}

#[cfg(windows)]
pub(super) fn execute(
    input: Vec<u8>,
    launch: Launch,
    id: &str,
    state: &std::sync::Arc<std::sync::Mutex<super::RequestState>>,
    started: &crate::shell::Started,
    fatal: &dyn Fn(),
) -> Value {
    use ops_process::shell::{Range, Retention};
    use serde_json::json;
    use std::{
        thread,
        time::{Duration, Instant},
    };
    let mut range = match Range::new() {
        Ok(range) => range,
        Err(error) => return super::refused("EXECUTOR_UNAVAILABLE", &error.to_string()),
    };
    let result = (|| -> io::Result<Option<u32>> {
        check(state, launch.deadline)?;
        range.spawn_with_stdin(
            ops_process::shell::Launch {
                argv: launch.argv.into_iter().map(Into::into).collect(),
                cwd: launch.cwd.into(),
                env: launch
                    .env
                    .into_iter()
                    .map(|(key, value)| (key.into(), value.into()))
                    .collect(),
                output_cap: dsh_ops_core::contract::envelope::MAX_OUTPUT_BYTES,
            },
            Retention::Tail,
            16 * 1024,
        )?;
        {
            let mut current = state.lock().unwrap();
            current.leaf = Some(super::Running::Confined(range.cancellation()));
            if current.cancelled {
                current.leaf.as_ref().unwrap().cancel();
            }
        }
        // Ownership precedes the physical start receipt, which precedes every stdin byte.
        let receipt = started(json!({"type":"started","requestId":id}))?;
        loop {
            check(state, launch.deadline)?;
            match receipt.recv_timeout(Duration::from_millis(2)) {
                Ok(result) => {
                    result?;
                    break;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        check(state, launch.deadline)?;
        range.write_input(input)?;
        loop {
            check(state, launch.deadline)?;
            if let Some(code) = range.root_exit()? {
                return Ok(Some(code));
            }
            thread::sleep(Duration::from_millis(2));
        }
    })();
    // Both cleanup phases run even after a spawn/input/capture error. A poisoned owner
    // is retained by Drop; close independent control first so the host kills the kernel.
    let stop = range.terminate(Instant::now() + Duration::from_secs(5));
    let captures = range.captures_until(Instant::now() + Duration::from_secs(5));
    if stop.is_err() || range.cleanup_unconfirmed() {
        fatal();
    }
    let mut current = state.lock().unwrap();
    current.leaf = None;
    match result.and_then(|exit| {
        stop?;
        Ok((exit, captures?))
    }) {
        Ok((exit, captures)) => {
            let stopped = current.cancelled || (exit == Some(0) && range.input_error().is_some());
            let mut exchange = json!({"exitCode":exit,"interrupted":stopped,"readers":true,
                "lossy":captures[0].truncated,"stderr":String::from_utf8_lossy(&captures[1].bytes)});
            if exit == Some(0) && !stopped && !captures[0].truncated {
                match serde_json::from_slice::<Value>(&captures[0].bytes) {
                    Ok(value) if value.is_object() => exchange["value"] = value,
                    Ok(_) => exchange["invalid"] = json!("shape"),
                    Err(_) => exchange["invalid"] = json!("json"),
                }
            }
            exchange
        }
        Err(error) if range.pid().is_none() => {
            super::refused("EXECUTOR_UNAVAILABLE", &error.to_string())
        }
        Err(error) => {
            json!({"exitCode":null,"interrupted":true,"readers":true,"lossy":false,"stderr":error.to_string()})
        }
    }
}

#[cfg(windows)]
fn check(
    state: &std::sync::Mutex<super::RequestState>,
    deadline: std::time::Instant,
) -> io::Result<()> {
    if std::time::Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "confined worker deadline expired",
        ));
    }
    if state.lock().unwrap().cancelled {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "confined worker cancelled",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn launch_is_bounded_and_cannot_change_the_protocol_shape() {
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let valid = json!({"argv":[exe],"cwd":cwd,"env":{}});
        let envelope =
            json!({"component":"ptc","request":{"tool":"batch"},"budget":{"timeoutMs":1000}});
        if cfg!(windows) {
            assert!(parse(&valid, &envelope).is_ok());
        } else {
            assert_eq!(
                parse(&valid, &envelope).err().unwrap().kind(),
                io::ErrorKind::Unsupported
            );
        }
        let mut extra = valid.clone();
        extra["command"] = json!("untrusted");
        assert!(parse(&extra, &envelope).is_err());
        let mut large = valid.clone();
        large["env"] = json!({"x":"a".repeat(LAUNCH_BYTES)});
        assert!(parse(&large, &envelope).is_err());
        let mut relative = valid.clone();
        relative["argv"] = json!(["worker"]);
        assert!(parse(&relative, &envelope).is_err());
        assert!(
            parse(
                &valid,
                &json!({"component":"file","request":{"tool":"read"},"budget":{"timeoutMs":1000}})
            )
            .is_err()
        );
        for timeout in [
            json!(0),
            json!(-1),
            json!(2_147_483_648u64),
            json!(1.5),
            json!(null),
        ] {
            let mut invalid = envelope.clone();
            invalid["budget"]["timeoutMs"] = timeout;
            assert!(parse(&valid, &invalid).is_err());
        }
    }
}
