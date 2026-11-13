//! One trusted file worker per execution; no shell, scheduler, restart or authority resolution.
use std::{
    io::{self, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
};
#[cfg(unix)]
#[path = "leaf_unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "leaf_windows.rs"]
mod platform;

struct State {
    child: Child,
    status: Option<ExitStatus>,
}
struct Owner {
    state: Mutex<State>,
    scope: platform::Scope,
}
/// Clones address the same execution; cancellation after settlement is a no-op.
#[derive(Clone)]
pub struct Cancel(Arc<Owner>);
impl Cancel {
    pub fn cancel(&self) -> io::Result<()> {
        let state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.status.is_none() {
            self.0.scope.terminate()?;
        }
        Ok(())
    }
    fn wait(&self) -> io::Result<ExitStatus> {
        self.0.scope.wait_exited()?;
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Reap and disable cancellation under the same lock. POSIX WNOWAIT kept
        // the process identity reserved while wait_exited blocked without this lock.
        let status = state.child.wait()?;
        state.status = Some(status);
        Ok(status)
    }
}
type Reader = JoinHandle<io::Result<(Vec<u8>, bool)>>;
pub struct Execution {
    cancel: Cancel,
    stdin: Option<ChildStdin>,
    input: Option<JoinHandle<io::Result<()>>>,
    stdout: Option<Reader>,
    stderr: Option<Reader>,
    settled: bool,
}
pub struct Captured {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_lossy: bool,
    pub stderr_lossy: bool,
}
impl Execution {
    /// The trusted worker must wait for stdin EOF before effects and never launch descendants.
    /// The caller supplies its fixed worker path, not model-authored executable/argv.
    pub fn spawn(
        file: &Path,
        cwd: &Path,
        stdout_cap: usize,
        stderr_cap: usize,
    ) -> io::Result<Self> {
        let mut command = Command::new(file);
        command.current_dir(cwd);
        Self::start(command, stdout_cap, stderr_cap)
    }
    fn start(mut command: Command, stdout_cap: usize, stderr_cap: usize) -> io::Result<Self> {
        if !(1..=128 * 1024).contains(&stdout_cap) || !(1..=16 * 1024).contains(&stderr_cap) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid leaf output caps",
            ));
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("DSH_SUBPROCESS_CONTROL");
        platform::prepare(&mut command);
        let mut child = command.spawn()?;
        let scope = match platform::Scope::attach(&child) {
            Ok(scope) => scope,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("piped child stdout");
        let stderr = child.stderr.take().expect("piped child stderr");
        let cancel = Cancel(Arc::new(Owner {
            state: Mutex::new(State {
                child,
                status: None,
            }),
            scope,
        }));
        let mut execution = Self {
            cancel,
            stdin,
            input: None,
            stdout: None,
            stderr: None,
            settled: false,
        };
        execution.stdout = Some(drain(stdout, stdout_cap)?);
        execution.stderr = Some(drain(stderr, stderr_cap)?);
        Ok(execution)
    }
    pub fn cancellation(&self) -> Cancel {
        self.cancel.clone()
    }
    /// Call only after publishing cancellation() into the owning request lifecycle.
    /// The caller owns deadlines. A killed child is an outcome, not a retry instruction.
    pub fn run(mut self, input: Vec<u8>) -> io::Result<Captured> {
        if input.len() > 2 * 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "leaf input exceeds 2 MiB",
            ));
        }
        let mut stdin = self.stdin.take().expect("input sent once");
        self.input = Some(
            thread::Builder::new()
                .name("ops-leaf-input".into())
                .spawn(move || stdin.write_all(&input))?,
        );
        let status = self.cancel.wait()?;
        self.settled = true;
        let sent = joined(self.input.take().unwrap());
        let (stdout, stdout_lossy) = joined(self.stdout.take().unwrap())?;
        let (stderr, stderr_lossy) = joined(self.stderr.take().unwrap())?;
        if status.success() {
            sent?;
        }
        Ok(Captured {
            status,
            stdout,
            stderr,
            stdout_lossy,
            stderr_lossy,
        })
    }
}
fn joined<T>(handle: JoinHandle<io::Result<T>>) -> io::Result<T> {
    handle
        .join()
        .map_err(|_| io::Error::other("leaf I/O thread panicked"))?
}
fn drain(mut stream: impl Read + Send + 'static, cap: usize) -> io::Result<Reader> {
    thread::Builder::new()
        .name("ops-leaf-output".into())
        .spawn(move || {
            let mut bytes = Vec::with_capacity(cap);
            let mut lossy = false;
            let mut chunk = [0u8; 8192];
            loop {
                let read = match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                };
                let overflow = (bytes.len() + read).saturating_sub(cap);
                lossy |= overflow != 0;
                if read >= cap {
                    bytes.clear();
                    bytes.extend_from_slice(&chunk[read - cap..read]);
                } else {
                    bytes.drain(..overflow);
                    bytes.extend_from_slice(&chunk[..read]);
                }
            }
            Ok((bytes, lossy))
        })
}
impl Drop for Execution {
    fn drop(&mut self) {
        self.stdin.take();
        if !self.settled {
            let _ = self.cancel.cancel();
            let _ = self.cancel.wait();
        }
        if let Some(input) = self.input.take() {
            let _ = input.join();
        }
        if let Some(stdout) = self.stdout.take() {
            let _ = stdout.join();
        }
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
    }
}

#[cfg(test)]
#[path = "leaf_tests.rs"]
mod tests;
