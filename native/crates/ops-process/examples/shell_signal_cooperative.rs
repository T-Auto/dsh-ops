//! Repository-only target with a declared cooperative console baseline.
#![deny(unsafe_op_in_unsafe_fn)]
#[cfg(windows)]
fn main() {
    use windows_sys::Win32::System::Console::{CTRL_C_EVENT, SetConsoleCtrlHandler};
    unsafe extern "system" fn protect_wrapper(event: u32) -> i32 {
        i32::from(event == CTRL_C_EVENT)
    }
    assert_eq!(
        std::env::args().nth(1).as_deref(),
        Some("--cooperative-shell-fixture")
    );
    // Git Bash may start this probe with inherited Ctrl+C ignore enabled. Define
    // this target's baseline explicitly; never change the resident kernel's.
    // SAFETY: these changes affect only this disposable test process; the custom
    // handler protects its waiter and is not inherited by the child shell.
    assert_ne!(unsafe { SetConsoleCtrlHandler(None, 0) }, 0);
    assert_ne!(
        unsafe { SetConsoleCtrlHandler(Some(protect_wrapper), 1) },
        0
    );
    let mut args = std::env::args_os().skip(2);
    let status = std::process::Command::new(args.next().expect("shell executable"))
        .args(args)
        .status()
        .expect("cooperative fixture shell");
    std::process::exit(status.code().unwrap_or(1));
}
#[cfg(not(windows))]
fn main() {
    panic!("Windows-only cooperative console fixture");
}
