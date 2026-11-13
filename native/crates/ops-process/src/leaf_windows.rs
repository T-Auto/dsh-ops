use std::{
    io,
    os::windows::{
        io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command},
    ptr::null_mut,
};
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::{CREATE_NO_WINDOW, INFINITE, WaitForSingleObject},
    },
};
pub fn prepare(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}
pub struct Scope {
    job: OwnedHandle,
    process: OwnedHandle,
}
impl Scope {
    pub fn attach(child: &Child) -> io::Result<Self> {
        // SAFETY: unnamed, non-inheritable Job. No breakaway limit is enabled.
        let raw = unsafe { CreateJobObjectW(null_mut(), null_mut()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful CreateJobObjectW transferred one owned Job handle.
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        // SAFETY: zero-initialized limit record has no pointer members to dereference.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: fixed-size initialized limits; child is already in the outer host
        // Job and receives no request bytes until nested ownership succeeds.
        if unsafe {
            SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(raw, child.as_raw_handle()) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            job,
            process: child.as_handle().try_clone_to_owned()?,
        })
    }
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: this owned Job contains only this execution; never target the host Job.
        if unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn wait_exited(&self) -> io::Result<()> {
        // SAFETY: process handle stays owned throughout the wait, independently of cancellation.
        if unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
