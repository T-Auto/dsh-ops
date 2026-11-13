use std::{
    io,
    process::{Child, Command},
};
// Trusted file leaves never spawn descendants. Preserve the host's outer process
// group so its fallback owner can still reap them after a kernel hard crash.
pub fn prepare(_command: &mut Command) {}
pub struct Scope(libc::pid_t);
impl Scope {
    pub fn attach(child: &Child) -> io::Result<Self> {
        Ok(Self(child.id() as libc::pid_t))
    }
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: this child is not reaped until its owner disables cancellation;
        // its PID cannot be recycled while that identity remains reserved.
        if unsafe { libc::kill(self.0, libc::SIGKILL) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
    pub fn wait_exited(&self) -> io::Result<()> {
        loop {
            // SAFETY: initialized output belongs to this call; WNOWAIT observes
            // exit without releasing the owned child PID for reuse before settlement.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.0 as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            } == 0
            {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}
