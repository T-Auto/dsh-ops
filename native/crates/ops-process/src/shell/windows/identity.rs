use super::{Range, check, owned};
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::WAIT_TIMEOUT,
    System::{
        JobObjects::{JobObjectBasicProcessIdList, QueryInformationJobObject},
        Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            WaitForSingleObject,
        },
    },
};

/// Exact bootstrap process identities, retained so a recycled PID cannot match.
pub struct Baseline(Vec<(u32, OwnedHandle)>);
impl Range {
    pub fn baseline(&self, shell_pid: u32) -> io::Result<Baseline> {
        let root = self
            .pid()
            .ok_or_else(|| io::Error::other("shell not started"))?;
        let expected = self.process_ids()?;
        if !expected.contains(&root) || !expected.contains(&shell_pid) {
            return Err(io::Error::other(
                "bootstrap root or shell identity is missing",
            ));
        }
        let mut identities = Vec::new();
        for pid in expected {
            let process = owned(unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                    0,
                    pid,
                )
            })?;
            if !self.job.contains_handle(&process)? {
                return Err(io::Error::other("bootstrap process left its Job"));
            }
            identities.push((pid, process));
        }
        let baseline = Baseline(identities);
        if !baseline.matches(self)? {
            return Err(io::Error::other(
                "bootstrap identities changed during observation",
            ));
        }
        Ok(baseline)
    }
    fn process_ids(&self) -> io::Result<Vec<u32>> {
        #[repr(C)]
        struct Ids {
            assigned: u32,
            listed: u32,
            ids: [usize; 256],
        }
        let mut ids = Ids {
            assigned: 0,
            listed: 0,
            ids: [0; 256],
        };
        // Fixed capacity: an overflowing or changing observation fails closed.
        check(unsafe {
            QueryInformationJobObject(
                self.job.0.as_raw_handle(),
                JobObjectBasicProcessIdList,
                (&mut ids as *mut Ids).cast(),
                std::mem::size_of::<Ids>() as u32,
                std::ptr::null_mut(),
            )
        })?;
        if ids.assigned != ids.listed || ids.listed as usize > ids.ids.len() {
            return Err(io::Error::other("Job process observation exceeds capacity"));
        }
        let mut output = ids.ids[..ids.listed as usize]
            .iter()
            .map(|id| {
                u32::try_from(*id).map_err(|_| io::Error::other("invalid process identifier"))
            })
            .collect::<io::Result<Vec<_>>>()?;
        output.sort_unstable();
        Ok(output)
    }
}
impl Baseline {
    pub fn matches(&self, range: &Range) -> io::Result<bool> {
        for (_, process) in &self.0 {
            if unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } != WAIT_TIMEOUT {
                return Ok(false);
            }
        }
        Ok(range.process_ids()? == self.0.iter().map(|(pid, _)| *pid).collect::<Vec<_>>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Launch;
    use std::{
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[test]
    #[ignore = "child fixture, explicitly invoked by the identity lifecycle test"]
    fn child() {
        if let Some(trigger) = std::env::var_os("OPS_IDENTITY_TRIGGER") {
            let mut members = [0u32; 8];
            assert!(
                unsafe {
                    windows_sys::Win32::System::Console::GetConsoleProcessList(
                        members.as_mut_ptr(),
                        8,
                    )
                } > 0
            );
            std::fs::write(std::path::Path::new(&trigger).with_extension("ready"), []).unwrap();
            while !std::path::Path::new(&trigger).exists() {
                thread::sleep(Duration::from_millis(2));
            }
            let _child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "shell::windows::identity::tests::child",
                ])
                .env_remove("OPS_IDENTITY_TRIGGER")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            std::process::exit(0);
        } else {
            loop {
                thread::sleep(Duration::from_secs(60));
            }
        }
    }

    #[test]
    fn equal_process_counts_cannot_replace_held_bootstrap_identities() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("ops-identity-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let trigger = directory.join("replace-parent");
        let mut range = Range::new().unwrap();
        let root = range
            .spawn(Launch {
                argv: vec![
                    std::env::current_exe().unwrap().into_os_string(),
                    "--ignored".into(),
                    "--exact".into(),
                    "shell::windows::identity::tests::child".into(),
                ],
                cwd: directory.clone(),
                env: vec![("OPS_IDENTITY_TRIGGER".into(), trigger.as_os_str().into())],
                output_cap: 1024,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !trigger.with_extension("ready").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(trigger.with_extension("ready").exists());
        let baseline = range.baseline(root).unwrap();
        let original_count = baseline.0.len() as u32;
        assert!(baseline.matches(&range).unwrap());
        std::fs::write(&trigger, []).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while baseline.matches(&range).unwrap() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        while range.active_processes().unwrap() != original_count && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            range.active_processes().unwrap(),
            original_count,
            "process count is unchanged after parent replacement"
        );
        assert!(
            !baseline.matches(&range).unwrap(),
            "count equality must not authenticate a different process"
        );
        range
            .terminate(Instant::now() + Duration::from_secs(3))
            .unwrap();
        range.captures().unwrap();
        assert_eq!(range.active_processes().unwrap(), 0);
        std::fs::remove_file(trigger.with_extension("ready")).unwrap();
        std::fs::remove_file(trigger).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
