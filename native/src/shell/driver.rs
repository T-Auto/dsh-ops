//! One owned persistent shell. Scheduling and policy admission belong to its caller.
use ops_process::shell::{Baseline, Channel, ChannelPool, ChannelView, Launch, Range, SpillStore};
use serde_json::{Value, json};
use std::{
    io,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub struct Driver {
    range: Range,
    command: Channel,
    startup: Channel,
    pools: [ChannelPool; 3],
    baseline: Option<Baseline>,
    diagnostics: [u64; 2],
    startup_bytes: u64,
    stopped: bool,
    spill: Option<SpillStore>,
}
pub struct Call {
    id: String,
    channels: [Channel; 3],
}
fn failure(message: impl std::fmt::Display) -> io::Error {
    io::Error::other(message.to_string())
}
fn check_deadline(deadline: Instant, cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Acquire) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "shell request cancelled",
        ));
    }
    if Instant::now() >= deadline {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "shell request deadline exceeded",
        ));
    }
    Ok(())
}
fn check_startup_environment(launch: &Launch) -> io::Result<()> {
    let configured: Vec<_> = ["NIU_ENV", "BASH_ENV", "ENV"]
        .into_iter()
        .filter(|name| {
            launch.env.iter().any(|(key, value)| {
                key.to_string_lossy().eq_ignore_ascii_case(name) && !value.is_empty()
            })
        })
        .collect();
    if configured.is_empty() {
        Ok(())
    } else {
        Err(failure(format!(
            "unsupported shell startup environment: {}",
            configured.join(", ")
        )))
    }
}
impl Driver {
    pub fn prepare() -> io::Result<Self> {
        Self::prepare_with_spill(None)
    }
    pub fn prepare_with_spill(spill: Option<SpillStore>) -> io::Result<Self> {
        let range = Range::new()?;
        let command = range.framed_channel(1024, b"COMMAND_READY\n", true)?;
        let startup = range.framed_channel(1024, b"SHELL_READY:", false)?;
        let pools = [
            range.channel_pool()?,
            range.channel_pool()?,
            range.channel_pool()?,
        ];
        Ok(Self {
            pools,
            range,
            command,
            startup,
            baseline: None,
            diagnostics: [0; 2],
            startup_bytes: 0,
            stopped: false,
            spill,
        })
    }
    pub fn bootstrap(&self) -> Value {
        json!({"commandPipe":self.command.name().to_string_lossy(),"receiptPipe":self.startup.name().to_string_lossy()})
    }
    pub fn launch(
        &mut self,
        launch: Launch,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> io::Result<()> {
        check_startup_environment(&launch)?;
        self.range.spawn(launch)?;
        loop {
            check_deadline(deadline, cancel)?;
            let command = self.command.snapshot();
            let startup = self.startup.snapshot();
            if !command.errors.is_empty() || !startup.errors.is_empty() {
                return Err(failure("bootstrap channel identity or prefix failed"));
            }
            if self.range.active_processes()? == 0 {
                self.range.wait_empty(deadline)?;
                let diagnostics = self.range.captures()?;
                let details = diagnostics
                    .iter()
                    .map(|capture| String::from_utf8_lossy(&capture.bytes))
                    .collect::<Vec<_>>()
                    .join("; ");
                return Err(failure(format!(
                    "shell exited before bootstrap completed: {details}"
                )));
            }
            if command.writer_eof || startup.writer_eof {
                return Err(failure("shell exited before bootstrap completed"));
            }
            if command.ready && startup.ready && startup.bytes.ends_with(b"\n") {
                let pid: u32 = std::str::from_utf8(&startup.bytes)
                    .map_err(failure)?
                    .trim()
                    .parse()
                    .map_err(failure)?;
                self.baseline = Some(self.range.baseline(pid)?);
                self.diagnostics = self.range.diagnostic_totals();
                self.startup_bytes = startup.observed;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
    pub fn call(&self, id: &str, stdout: usize, stderr: usize) -> io::Result<Call> {
        self.check_live()?;
        let channels = [
            self.output_channel(stdout, format!("OUT:{id}\n").as_bytes(), "stdout")?,
            self.output_channel(stderr, format!("ERR:{id}\n").as_bytes(), "stderr")?,
            self.pools[2].framed(4096, format!("BEGIN:{id}\n").as_bytes())?,
        ];
        Ok(Call {
            id: id.into(),
            channels,
        })
    }
    fn output_channel(
        &self,
        cap: usize,
        prefix: &[u8],
        stream: &'static str,
    ) -> io::Result<Channel> {
        let pool = &self.pools[usize::from(stream == "stderr")];
        match &self.spill {
            Some(store) => pool.spilling(cap, prefix, store.clone(), stream),
            None => pool.framed(cap, prefix),
        }
    }
    /// On failure the caller MUST stop this range, then drain Call, before settling.
    pub fn run(
        &mut self,
        call: &mut Call,
        command: &str,
        cwd: Option<&str>,
        deadline: Instant,
        cancel: &AtomicBool,
    ) -> io::Result<i32> {
        check_deadline(deadline, cancel)?;
        self.check_live()?;
        if command.contains('\0') || cwd.is_some_and(|value| value.contains('\0')) {
            return Err(failure("shell records cannot contain NUL"));
        }
        let mut fields = vec![call.id.clone()];
        fields.extend(
            call.channels
                .iter()
                .map(|channel| channel.name().to_string_lossy().into_owned()),
        );
        fields.push(encoded(cwd.unwrap_or("")));
        fields.push(encoded(command));
        self.command.write(
            format!("{}\n", fields.join("\n")).as_bytes(),
            deadline,
            cancel,
        )?;
        let mut settlement = None;
        loop {
            check_deadline(deadline, cancel)?;
            self.check_control()?;
            if call.cleanup_unconfirmed() {
                return Err(failure("output cleanup unconfirmed"));
            }
            let outputs = call.channels.each_ref().map(Channel::snapshot);
            if outputs
                .iter()
                .any(|value| !value.errors.is_empty() || value.cleanup_unconfirmed)
            {
                return Err(failure("request output observation failed"));
            }
            let receipt = &outputs[2];
            if receipt.truncated {
                return Err(failure("command receipt exceeded its bound"));
            }
            if let Some(code) = receipt_code(&call.id, &receipt.bytes)? {
                if outputs.iter().any(|value| {
                    value.storage_pending || (value.writer_closed && !value.writer_eof)
                }) {
                    // Known storage work is not evidence of a surviving shell job.
                    // The independent request deadline above remains authoritative.
                    settlement = Some(deadline.min(Instant::now() + Duration::from_millis(500)));
                }
                let limit = *settlement.get_or_insert_with(|| {
                    deadline.min(Instant::now() + Duration::from_millis(500))
                });
                if outputs.iter().all(|value| value.ready && value.writer_eof)
                    && self.baseline.as_ref().unwrap().matches(&self.range)?
                {
                    call.drain(deadline)?;
                    return Ok(code);
                }
                if Instant::now() >= limit {
                    return Err(failure(
                        "request retained output descriptors or surviving descendants; shell reset required",
                    ));
                }
            } else if receipt.writer_eof || self.range.active_processes()? == 0 {
                return Err(failure(
                    "shell exited or closed its receipt before completion",
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
    pub fn stop(&mut self) -> io::Result<()> {
        if self.stopped {
            return Ok(());
        }
        if self.range.active_processes()? != 0 {
            let _ = self.range.interrupt(
                &std::env::current_exe()?,
                Instant::now() + Duration::from_secs(2),
            );
            if self
                .range
                .wait_empty(Instant::now() + Duration::from_millis(100))
                .is_err()
            {
                self.range
                    .terminate(Instant::now() + Duration::from_secs(5))?;
            }
        } else {
            self.range
                .wait_empty(Instant::now() + Duration::from_secs(1))?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        self.command.close_until(deadline)?;
        self.startup.close_until(deadline)?;
        self.range.captures()?;
        self.stopped = true;
        Ok(())
    }
    pub fn cleanup_unconfirmed(&self) -> bool {
        self.range.cleanup_unconfirmed()
            || self.command.cleanup_unconfirmed()
            || self.startup.cleanup_unconfirmed()
    }
    pub fn stopped(&self) -> bool {
        self.stopped
    }
    /// Check before reuse admission. An idle failure must be reported, not relaunched silently.
    pub fn check_live(&self) -> io::Result<()> {
        if self.cleanup_unconfirmed() {
            return Err(failure("shell cleanup unconfirmed"));
        }
        let baseline = self
            .baseline
            .as_ref()
            .filter(|_| !self.stopped)
            .ok_or_else(|| failure("persistent shell is not ready"))?;
        self.check_control()?;
        if !baseline.matches(&self.range)? {
            return Err(failure("persistent shell bootstrap identities changed"));
        }
        Ok(())
    }
    fn check_control(&self) -> io::Result<()> {
        let input = self.command.snapshot();
        let startup = self.startup.snapshot();
        if input.writer_eof
            || startup.writer_eof
            || input.observed != 0
            || startup.observed != self.startup_bytes
            || !input.errors.is_empty()
            || !startup.errors.is_empty()
        {
            return Err(failure("persistent control synchronization lost"));
        }
        if self.range.diagnostic_totals() != self.diagnostics {
            return Err(failure("unregistered shell stdout/stderr observed"));
        }
        Ok(())
    }
}
impl Call {
    pub fn cleanup_unconfirmed(&self) -> bool {
        self.channels.iter().any(Channel::cleanup_unconfirmed)
    }
    pub fn views(&self) -> [ChannelView; 2] {
        [self.channels[0].view(), self.channels[1].view()]
    }
    pub fn drain(&mut self, deadline: Instant) -> io::Result<()> {
        // Even an errored stream must not leave sibling reader threads unjoined.
        let mut first = None;
        for channel in &mut self.channels {
            if let Err(error) = channel.drain(deadline) {
                first.get_or_insert(error);
            }
        }
        first.map_or(Ok(()), Err)
    }
}
fn encoded(value: &str) -> String {
    value.bytes().map(|byte| format!("\\0{byte:03o}")).collect()
}
fn receipt_code(id: &str, bytes: &[u8]) -> io::Result<Option<i32>> {
    let text = std::str::from_utf8(bytes).map_err(failure)?;
    if !text.ends_with(&format!("DONE:{id}\n")) {
        return Ok(None);
    }
    let lines: Vec<_> = text.lines().collect();
    let code = lines
        .first()
        .and_then(|line| line.strip_prefix(&format!("END:{id}:")))
        .ok_or_else(|| failure("invalid command receipt"))?
        .parse()
        .map_err(failure)?;
    if lines.len() != 2 {
        return Err(failure(
            "unregistered shell background jobs remain; shell reset required",
        ));
    }
    Ok(Some(code))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_scripts_are_rejected_before_spawn_without_disclosing_values() {
        for name in ["NIU_ENV", "bash_env", "Env"] {
            let mut launch = Launch {
                argv: vec![],
                cwd: std::path::PathBuf::new(),
                env: vec![(name.into(), "secret-startup-path".into())],
                output_cap: 1,
            };
            let error = check_startup_environment(&launch).unwrap_err().to_string();
            assert!(error.contains(&name.to_uppercase()));
            assert!(!error.contains("secret-startup-path"));
            launch.env[0].1.clear();
            assert!(check_startup_environment(&launch).is_ok());
        }
    }
    #[test]
    fn receipts_are_private_complete_and_background_free() {
        assert_eq!(receipt_code("id", b"END:id:1\nDONE:id\n").unwrap(), Some(1));
        assert_eq!(receipt_code("id", b"END:id:0\n").unwrap(), None);
        assert!(receipt_code("id", b"END:id:0\n123\nDONE:id\n").is_err());
        assert!(receipt_code("id", b"END:other:0\nDONE:id\n").is_err());
        assert_eq!(encoded("a\n"), "\\0141\\0012");
    }
}
