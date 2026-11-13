use super::{check, owned};
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::System::{
    JobObjects::*,
    Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE},
};

pub(super) struct Job(pub OwnedHandle);
impl Job {
    pub fn new() -> io::Result<Self> {
        // SAFETY: unnamed non-inheritable Job; no external pointers.
        let job = Self(owned(unsafe {
            CreateJobObjectW(std::ptr::null(), std::ptr::null())
        })?);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: exact initialized record remains live throughout the call.
        check(unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        })?;
        Ok(job)
    }
    pub fn contains_handle(&self, process: &OwnedHandle) -> io::Result<bool> {
        let mut member = 0;
        // SAFETY: owned handles and one initialized BOOL output.
        check(unsafe {
            IsProcessInJob(process.as_raw_handle(), self.0.as_raw_handle(), &mut member)
        })?;
        Ok(member != 0)
    }
    pub fn contains_pid(&self, pid: u32) -> io::Result<bool> {
        // Retain the process identity while checking membership; never signal this PID.
        let process = owned(unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        })?;
        self.contains_handle(&process)
    }
    pub fn active(&self) -> io::Result<u32> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: correctly sized output record and owned Job.
        check(unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        })?;
        Ok(info.ActiveProcesses)
    }
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: only this instance's Job, never the outer host Job.
        check(unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) })
    }
    pub fn wait_empty(&self, deadline: Instant) -> io::Result<()> {
        while self.active()? != 0 {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "shell Job quiescence unconfirmed",
                ));
            }
            thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }
}
