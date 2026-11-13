use super::{Range, check};
use crate::shell::Launch;
use std::{io, path::Path, time::Instant};
use windows_sys::Win32::System::Console::{
    AttachConsole, CTRL_C_EVENT, FreeConsole, GenerateConsoleCtrlEvent, GetStdHandle,
    STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetConsoleCtrlHandler, SetStdHandle,
};

impl Range {
    /// Fixed trusted executable implementing signal_console_and_exit, never model argv.
    /// Success proves an OS signal attempt, not target cooperation or range emptiness.
    pub fn interrupt(&self, controller: &Path, deadline: Instant) -> io::Result<()> {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "signal deadline exceeded",
            ));
        }
        let pid = self
            .pid()
            .ok_or_else(|| io::Error::other("shell not started"))?;
        let mut helper = Range::new()?;
        helper.spawn(Launch {
            argv: vec![
                controller.as_os_str().into(),
                "--ops-signal-console".into(),
                pid.to_string().into(),
            ],
            cwd: controller
                .parent()
                .ok_or_else(|| io::Error::other("controller parent missing"))?
                .into(),
            env: Vec::new(),
            output_cap: 1024,
        })?;
        if let Err(error) = helper.wait_empty(deadline) {
            // Always join this cancellation-only helper, even if it stalls or crashes.
            helper.terminate(Instant::now() + std::time::Duration::from_secs(5))?;
            let captured = helper.captures()?;
            return Err(io::Error::new(
                error.kind(),
                format!(
                    "{error}; controller: {}",
                    String::from_utf8_lossy(&captured[1].bytes)
                ),
            ));
        }
        let captured = helper.captures()?;
        if helper.exit_code()? != 0
            || captured[0].bytes != b"CTRL_C_SENT\n"
            || captured.iter().any(|value| value.truncated)
        {
            return Err(io::Error::other(format!(
                "console signal failed: {}",
                String::from_utf8_lossy(&captured[1].bytes)
            )));
        }
        Ok(())
    }
}

/// Entry point only for the fixed, short-lived signal controller. It cannot return
/// into a resident kernel or launch children with its temporary ignore attribute.
pub fn signal_console_and_exit(pid: u32) -> ! {
    let result = (|| -> io::Result<()> {
        let selectors = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE];
        let saved = selectors.map(|key| unsafe { GetStdHandle(key) });
        check(unsafe { FreeConsole() })?;
        check(unsafe { AttachConsole(pid) })?;
        for (selector, handle) in selectors.into_iter().zip(saved) {
            check(unsafe { SetStdHandle(selector, handle) })?;
        }
        check(unsafe { SetConsoleCtrlHandler(None, 1) })?;
        check(unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) })
    })();
    match result {
        Ok(()) => {
            println!("CTRL_C_SENT");
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    // Never FreeConsole after signalling: delivery is asynchronous and resetting
    // handlers/ignore state could terminate a long-lived caller on a late signal.
}
