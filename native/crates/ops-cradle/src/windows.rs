//! Win32 ownership boundary: handles never cross into the scheduling worker.
use std::{
    ffi::OsStr,
    io,
    mem::{size_of, zeroed},
    os::windows::ffi::OsStrExt,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::ReadFile,
    System::{
        IO::{CreateIoCompletionPort, GetQueuedCompletionStatus},
        JobObjects::*,
        Pipes::CreatePipe,
        Threading::*,
    },
};

pub struct Handle(pub HANDLE);
// Each handle has one RAII owner; Windows permits waiting/IO from different threads.
unsafe impl Send for Handle {}
// Completion ports are shared only for blocking dequeue and Job association.
unsafe impl Sync for CompletionPort {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
impl Handle {
    fn checked(value: HANDLE) -> io::Result<Self> {
        if value.is_null() || value == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(value))
        }
    }
}
fn checked(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn quote(arg: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if c == '"' { slashes * 2 + 1 } else { slashes },
        ));
        result.push(c);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
fn pipe() -> io::Result<(Handle, Handle)> {
    let mut read = null_mut();
    let mut write = null_mut();
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    unsafe {
        checked(CreatePipe(&mut read, &mut write, &security, 0))?;
    }
    Ok((Handle(read), Handle(write)))
}
pub fn read(handle: &Handle, bytes: &mut [u8]) -> io::Result<usize> {
    let mut count = 0;
    unsafe {
        if ReadFile(
            handle.0,
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            &mut count,
            null_mut(),
        ) == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(109) {
                return Ok(0);
            }
            return Err(error);
        }
    }
    Ok(count as usize)
}

pub struct CompletionPort(pub Handle);
impl CompletionPort {
    pub fn new() -> io::Result<Self> {
        unsafe {
            Handle::checked(CreateIoCompletionPort(
                INVALID_HANDLE_VALUE,
                null_mut(),
                0,
                1,
            ))
            .map(Self)
        }
    }
    pub fn next(&self) -> io::Result<(u32, usize)> {
        let mut message = 0;
        let mut key = 0;
        let mut overlapped = null_mut();
        unsafe {
            checked(GetQueuedCompletionStatus(
                self.0.0,
                &mut message,
                &mut key,
                &mut overlapped,
                INFINITE,
            ))?;
        }
        Ok((message, key))
    }
}
pub fn open_parent(pid: u32) -> io::Result<Handle> {
    unsafe { Handle::checked(OpenProcess(PROCESS_SYNCHRONIZE, 0, pid)) }
}
pub fn wait(handle: &Handle) -> io::Result<()> {
    unsafe {
        if WaitForSingleObject(handle.0, INFINITE) == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}
pub fn exit_code(handle: &Handle) -> io::Result<u32> {
    let mut code = 0;
    unsafe {
        checked(GetExitCodeProcess(handle.0, &mut code))?;
    }
    Ok(code)
}
pub fn terminate(job: &Handle) -> io::Result<()> {
    unsafe { checked(TerminateJobObject(job.0, 1)) }
}
pub fn exit_owner() -> ! {
    unsafe { ExitProcess(125) }
}

pub struct Task {
    pub job: Handle,
    pub process: Handle,
    pub stdout: Handle,
    pub stderr: Handle,
}

/** Only the three child stdio handles inherit. In particular no Job or parent handle does. */
pub fn spawn(
    argv: &[String],
    cwd: &str,
    env: &[(String, String)],
    port: HANDLE,
    key: usize,
) -> io::Result<Task> {
    let (stdin, stdin_write) = pipe()?;
    drop(stdin_write); // Exact nonpersistent shell stdin semantics: EOF.
    let (stdout, stdout_write) = pipe()?;
    let (stderr, stderr_write) = pipe()?;
    let job = unsafe { Handle::checked(CreateJobObjectW(null(), null()))? };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        checked(SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            size_of_val(&limits) as u32,
        ))?;
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: key as *mut _,
            CompletionPort: port,
        };
        checked(SetInformationJobObject(
            job.0,
            JobObjectAssociateCompletionPortInformation,
            &association as *const _ as _,
            size_of_val(&association) as u32,
        ))?;
    }
    let mut attr_bytes = 0;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attr_bytes);
    }
    // usize alignment is required by the opaque native attribute list.
    let mut storage = vec![0usize; attr_bytes.div_ceil(size_of::<usize>())];
    let attributes = storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    unsafe {
        checked(InitializeProcThreadAttributeList(
            attributes,
            1,
            0,
            &mut attr_bytes,
        ))?;
    }
    struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0);
            }
        }
    }
    let _attributes = Attributes(attributes);
    let handles = [stdin.0, stdout_write.0, stderr_write.0];
    unsafe {
        checked(UpdateProcThreadAttribute(
            attributes,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr() as _,
            size_of_val(&handles),
            null_mut(),
            null_mut(),
        ))?;
    }
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = stdin.0;
    startup.StartupInfo.hStdOutput = stdout_write.0;
    startup.StartupInfo.hStdError = stderr_write.0;
    startup.lpAttributeList = attributes;
    let application = wide(OsStr::new(&argv[0]));
    let mut command = wide(OsStr::new(
        &argv
            .iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(" "),
    ));
    let directory = wide(OsStr::new(cwd));
    let mut environment = Vec::new();
    for (key, value) in env {
        environment.extend(wide(OsStr::new(&format!("{key}={value}"))));
    }
    environment.push(0);
    if env.is_empty() {
        environment.push(0);
    }
    let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        checked(CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr() as _,
            directory.as_ptr(),
            &startup.StartupInfo,
            &mut info,
        ))?;
    }
    let process = Handle(info.hProcess);
    let thread = Handle(info.hThread);
    // Creation has succeeded, but *no user instruction* runs until Job assignment succeeds.
    unsafe {
        if AssignProcessToJobObject(job.0, process.0) == 0 {
            let error = io::Error::last_os_error();
            TerminateProcess(process.0, 125);
            WaitForSingleObject(process.0, INFINITE);
            return Err(error);
        }
        if ResumeThread(thread.0) == u32::MAX {
            let error = io::Error::last_os_error();
            TerminateJobObject(job.0, 125);
            WaitForSingleObject(process.0, INFINITE);
            return Err(error);
        }
    }
    Ok(Task {
        job,
        process,
        stdout,
        stderr,
    })
}
