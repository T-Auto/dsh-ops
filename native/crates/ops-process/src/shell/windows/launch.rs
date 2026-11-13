use super::{argv, channel::Channel, check, job::Job, owned};
use crate::shell::{Capture, CaptureView, Launch, Retention, budget};
use std::{
    fs::File,
    io::{self, Read},
    os::windows::io::{AsRawHandle, OwnedHandle},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Security::SECURITY_ATTRIBUTES,
    System::{Pipes::CreatePipe, Threading::*},
};

type Reader = JoinHandle<io::Result<Capture>>;
pub struct Range {
    pub(super) job: Arc<Job>,
    process: Option<OwnedHandle>,
    pid: Option<u32>,
    readers: Vec<Reader>,
    observed: [Arc<AtomicU64>; 2],
    outputs: Option<[CaptureView; 2]>,
    settled: bool,
}
impl Range {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            job: Arc::new(Job::new()?),
            process: None,
            pid: None,
            readers: Vec::new(),
            observed: std::array::from_fn(|_| Arc::new(AtomicU64::new(0))),
            outputs: None,
            settled: false,
        })
    }
    pub fn channel(&self, cap: usize) -> io::Result<Channel> {
        Channel::new(self.job.clone(), cap)
    }
    pub fn framed_channel(&self, cap: usize, prefix: &[u8], duplex: bool) -> io::Result<Channel> {
        Channel::framed(
            self.job.clone(),
            cap,
            Some(super::channel::Prefix {
                bytes: prefix.to_vec(),
                duplex,
            }),
        )
    }
    pub fn active_processes(&self) -> io::Result<u32> {
        self.job.active()
    }
    pub fn diagnostic_totals(&self) -> [u64; 2] {
        self.observed.each_ref().map(|n| n.load(Ordering::Relaxed))
    }
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }
    pub fn output_views(&self) -> Option<[CaptureView; 2]> {
        self.outputs.clone()
    }
    /// Direct root exit only; descendants and output readers can still be alive.
    pub fn root_exit(&self) -> io::Result<Option<u32>> {
        self.observe_root(0)
    }
    /// Job emptiness can precede the root HANDLE becoming signalled on Windows.
    pub fn wait_root_exit(&self, deadline: Instant) -> io::Result<u32> {
        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min((u32::MAX - 1) as u128) as u32;
        self.observe_root(timeout)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "root exit unconfirmed"))
    }
    fn observe_root(&self, timeout: u32) -> io::Result<Option<u32>> {
        let process = self
            .process
            .as_ref()
            .ok_or_else(|| io::Error::other("shell not started"))?;
        match unsafe { WaitForSingleObject(process.as_raw_handle(), timeout) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                check(unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) })?;
                Ok(Some(code))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }
    pub fn exit_code(&self) -> io::Result<u32> {
        if !self.settled {
            return Err(io::Error::other("shell range is not confirmed empty"));
        }
        self.root_exit()?
            .ok_or_else(|| io::Error::new(io::ErrorKind::WouldBlock, "root exit unconfirmed"))
    }
    pub fn spawn(&mut self, spec: Launch) -> io::Result<u32> {
        self.spawn_with_retention(spec, Retention::Prefix)
    }
    pub fn spawn_with_retention(
        &mut self,
        mut spec: Launch,
        retention: Retention,
    ) -> io::Result<u32> {
        if self.process.is_some() || self.settled {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "shell range already used",
            ));
        }
        budget(spec.output_cap)?;
        let outputs = [
            CaptureView::new(spec.output_cap, retention)?,
            CaptureView::new(spec.output_cap, retention)?,
        ];
        let mut command = argv::command_line(&spec.argv)?;
        let executable = argv::wide(&spec.argv[0])?;
        if !std::path::Path::new(&spec.argv[0]).is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "absolute confined executable required",
            ));
        }
        let cwd = argv::wide(spec.cwd.as_os_str())?;
        spec.env.retain(|(key, _)| {
            !key.to_string_lossy()
                .eq_ignore_ascii_case("DSH_SUBPROCESS_CONTROL")
        });
        let mut environment = argv::environment(&spec.env)?;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        // Match fresh host execution: EOF from a closed pipe, not a NUL device.
        let input = eof_pipe(&sa)?;
        let (out_read, out_write) = pipe(&sa)?;
        let (err_read, err_write) = pipe(&sa)?;
        let inherited = [
            input.as_raw_handle(),
            out_write.as_raw_handle(),
            err_write.as_raw_handle(),
        ];
        let jobs = [self.job.0.as_raw_handle()];
        let mut attributes = Attributes::new()?;
        attributes.set(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited.as_ptr().cast(),
            std::mem::size_of_val(&inherited),
        )?;
        // Atomic assignment also covers kernel death between creation and ResumeThread.
        attributes.set(
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            jobs.as_ptr().cast(),
            std::mem::size_of_val(&jobs),
        )?;
        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        startup.StartupInfo.wShowWindow = 0; // SW_HIDE: private console, never a visible window.
        startup.StartupInfo.hStdInput = inherited[0];
        startup.StartupInfo.hStdOutput = inherited[1];
        startup.StartupInfo.hStdError = inherited[2];
        startup.lpAttributeList = attributes.pointer();
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: argv/env/cwd and attribute backing arrays live across CreateProcess.
        // The explicit handle list excludes fd7, all Jobs and other shell channels.
        check(unsafe {
            CreateProcessW(
                executable.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_NEW_CONSOLE
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT,
                environment.as_mut_ptr().cast(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        })?;
        let process = owned(info.hProcess)?;
        let main_thread = owned(info.hThread)?;
        self.pid = Some(info.dwProcessId);
        self.process = Some(process);
        self.outputs = Some(outputs.clone());
        drop(input);
        drop(out_write);
        drop(err_write);
        let result = (|| {
            if !self.job.contains_handle(self.process.as_ref().unwrap())? {
                return Err(io::Error::other("atomic shell Job assignment failed"));
            }
            self.readers.push(drain(
                out_read,
                outputs[0].clone(),
                self.observed[0].clone(),
            )?);
            self.readers.push(drain(
                err_read,
                outputs[1].clone(),
                self.observed[1].clone(),
            )?);
            if unsafe { ResumeThread(main_thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            Ok(info.dwProcessId)
        })();
        if result.is_err() {
            let _ = self.terminate(Instant::now() + Duration::from_secs(5));
        }
        result
    }
    pub fn terminate(&mut self, deadline: Instant) -> io::Result<()> {
        self.job.terminate()?;
        self.wait_empty(deadline)
    }
    pub fn wait_empty(&mut self, deadline: Instant) -> io::Result<()> {
        self.job.wait_empty(deadline)?;
        if self.process.is_some() {
            self.wait_root_exit(deadline)?;
        }
        self.settled = true;
        Ok(())
    }
    /// Read only after confirmed Job emptiness; descendants cannot retain writers then.
    pub fn captures(&mut self) -> io::Result<Vec<Capture>> {
        if !self.settled {
            return Err(io::Error::other("shell range is not confirmed empty"));
        }
        join_readers(&mut self.readers)
    }
}
impl Drop for Range {
    fn drop(&mut self) {
        if !self.settled {
            let _ = self.terminate(Instant::now() + Duration::from_secs(5));
        }
        // Joining is safe only after observed emptiness; dropping a thread handle
        // after an observation failure must not falsely report successful cleanup.
        if self.settled {
            let _ = self.captures();
        }
    }
}
struct Attributes {
    storage: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut bytes) };
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut this = Self {
            storage: vec![0; bytes.div_ceil(std::mem::size_of::<usize>())],
            initialized: false,
        };
        check(unsafe { InitializeProcThreadAttributeList(this.pointer(), 2, 0, &mut bytes) })?;
        this.initialized = true;
        Ok(this)
    }
    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    fn set(&mut self, key: usize, value: *const std::ffi::c_void, bytes: usize) -> io::Result<()> {
        check(unsafe {
            UpdateProcThreadAttribute(
                self.pointer(),
                0,
                key,
                value,
                bytes,
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { DeleteProcThreadAttributeList(self.pointer()) };
        }
    }
}
fn pipe(sa: &SECURITY_ATTRIBUTES) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    check(unsafe { CreatePipe(&mut read, &mut write, sa, 65536) })?;
    let read = owned(read)?;
    let write = owned(write)?;
    check(unsafe { SetHandleInformation(read.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) })?;
    Ok((read, write))
}
fn eof_pipe(sa: &SECURITY_ATTRIBUTES) -> io::Result<OwnedHandle> {
    let (input, writer) = pipe(sa)?;
    check(unsafe {
        SetHandleInformation(
            input.as_raw_handle(),
            HANDLE_FLAG_INHERIT,
            HANDLE_FLAG_INHERIT,
        )
    })?;
    drop(writer);
    Ok(input)
}
fn drain(handle: OwnedHandle, output: CaptureView, observed: Arc<AtomicU64>) -> io::Result<Reader> {
    thread::Builder::new()
        .name("ops-shell-diagnostic".into())
        .spawn(move || collect(File::from(handle), output, observed))
}
fn collect(
    mut reader: impl Read,
    output: CaptureView,
    observed: Arc<AtomicU64>,
) -> io::Result<Capture> {
    let mut bytes = [0; 8192];
    let result = (|| loop {
        let count = reader.read(&mut bytes)?;
        if count == 0 {
            return Ok(());
        }
        observed.store(output.append(&bytes[..count]), Ordering::Relaxed);
    })();
    let capture = output.finish(&result);
    result.map(|()| capture)
}

fn join_readers(readers: &mut Vec<Reader>) -> io::Result<Vec<Capture>> {
    let mut captures = Vec::with_capacity(readers.len());
    let mut first_error = None;
    for reader in readers.drain(..) {
        match reader
            .join()
            .unwrap_or_else(|_| Err(io::Error::other("shell output thread panicked")))
        {
            Ok(capture) => captures.push(capture),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(captures),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };

    #[test]
    fn default_input_is_a_closed_pipe_not_a_nul_device() {
        use windows_sys::Win32::Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType};
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let input = eof_pipe(&sa).unwrap();
        assert_eq!(
            unsafe { GetFileType(input.as_raw_handle()) },
            FILE_TYPE_PIPE
        );
        assert_eq!(File::from(input).read(&mut [0]).unwrap(), 0);
    }
    #[test]
    fn failed_reader_keeps_partial_live_bytes_without_claiming_eof() {
        struct Failed(bool);
        impl Read for Failed {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                if self.0 {
                    return Err(io::Error::other("fixture read failed"));
                }
                self.0 = true;
                bytes[..3].copy_from_slice(b"abc");
                Ok(3)
            }
        }
        let view = CaptureView::new(4, Retention::Tail).unwrap();
        let observed = Arc::new(AtomicU64::new(0));
        assert!(collect(Failed(false), view.clone(), observed.clone()).is_err());
        let snapshot = view.snapshot();
        assert_eq!(snapshot.bytes, b"abc");
        assert_eq!(snapshot.observed, 3);
        assert_eq!(observed.load(Ordering::Relaxed), 3);
        assert!(!snapshot.eof);
        assert_eq!(snapshot.error.as_deref(), Some("fixture read failed"));
    }

    fn check_failure_still_joins_later_readers(panic_first: bool) {
        let (release, gate) = mpsc::channel();
        let completed = Arc::new(AtomicBool::new(false));
        let later_completed = completed.clone();
        let mut readers: Vec<Reader> = vec![
            thread::spawn(move || {
                if panic_first {
                    panic!("first reader panicked");
                }
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "first capture failed",
                ))
            }),
            thread::spawn(move || {
                gate.recv().unwrap();
                later_completed.store(true, Ordering::Release);
                Err(io::Error::other("later capture failed"))
            }),
        ];
        let (started, starting) = mpsc::channel();
        let (finished, result) = mpsc::channel();
        let joiner = thread::spawn(move || {
            started.send(()).unwrap();
            let result = join_readers(&mut readers);
            finished.send((result, readers.is_empty())).unwrap();
        });
        starting.recv_timeout(Duration::from_secs(1)).unwrap();
        let early = result.recv_timeout(Duration::from_millis(100));
        let returned_early = early.is_ok();
        release.send(()).unwrap();
        let (result, empty) = match early {
            Ok(value) => value,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                result.recv_timeout(Duration::from_secs(2)).unwrap()
            }
            Err(error) => panic!("join worker disconnected: {error}"),
        };
        joiner.join().unwrap();
        assert!(
            !returned_early,
            "the first failure detached a still-running later reader"
        );
        assert!(completed.load(Ordering::Acquire));
        assert!(empty);
        let error = result.unwrap_err();
        if panic_first {
            assert_eq!(error.to_string(), "shell output thread panicked");
        } else {
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(error.to_string(), "first capture failed");
        }
    }

    #[test]
    fn reader_error_does_not_detach_later_readers() {
        check_failure_still_joins_later_readers(false);
    }

    #[test]
    fn reader_panic_does_not_detach_later_readers() {
        check_failure_still_joins_later_readers(true);
    }
}
