//! Platform capability probe: one operation per process.
//!
//! A process that dies on a seccomp `SIGSYS` cannot report anything else, so the
//! driver (`run.sh`) starts a fresh process per operation and reads exactly one
//! line: `OP <name> <verdict> <detail>`. When the kernel kills a call, the
//! handler below prints the syscall number from `siginfo.si_syscall`, which is
//! how the `openat2`/`fchmodat2`/`clone3`/`rseq` denials on OpenHarmony were
//! identified instead of guessed.
//!
//! Nothing here is platform-gated: on a host where everything is allowed the
//! probe simply reports `OK allowed` for each operation, which is the control
//! reading.
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use std::ffi::CString;

extern "C" fn on_sigsys(_sig: i32, info: *mut libc::siginfo_t, _ctx: *mut libc::c_void) {
    // struct siginfo: si_signo(0) si_errno(4) si_code(8) pad(12) union(16);
    // _sigsys = { void* call_addr(16); int syscall(24); unsigned arch(28) }
    let syscall = unsafe { *(info as *const i32).add(6) };
    println!("SIGSYS syscall={syscall}");
    std::process::exit(0);
}

fn c(s: &str) -> CString { CString::new(s).unwrap() }
fn errno() -> i32 { std::io::Error::last_os_error().raw_os_error().unwrap_or(0) }

fn main() {
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = on_sigsys as usize;
        sa.sa_flags = libc::SA_SIGINFO;
        libc::sigaction(libc::SIGSYS, &sa, std::ptr::null_mut());
    }
    let op = std::env::args().nth(1).unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    // Scratch space for the probe's own fixture; overridable for read-only homes.
    let base = std::env::var("DSH_OPS_PROBE_DIR").unwrap_or_else(|_| format!("{home}/.dsh-ops-syscall-probe"));
    let _ = std::fs::create_dir_all(format!("{base}/sub"));
    let _ = std::fs::write(format!("{base}/sub/a.txt"), "hi\n");
    let file_abs = format!("{base}/sub/a.txt");
    let dir_abs = format!("{base}/sub");
    let cf = c(&file_abs);
    let cd = c(&dir_abs);
    let dirfd = || unsafe { libc::syscall(libc::SYS_openat, libc::AT_FDCWD, cd.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY) };

    let dir = match Dir::open_ambient_dir(&base, ambient_authority()) {
        Ok(dir) => dir,
        Err(error) => { println!("OP {op} SETUP_FAILED {error:?}"); return }
    };
    let result = match op.as_str() {
        // Absolute std / cap-std operations: what the worker's entry path needs.
        "ambient_open_abs_dir" => Dir::open_ambient_dir(&dir_abs, ambient_authority()).map(|_| "opened".to_string()),
        "entries_on_ambient_dir" => dir.entries().map(|e| format!("{} entries", e.count())),
        "dir_metadata_fstat" => dir.dir_metadata().map(|m| format!("is_dir={}", m.is_dir())),
        "std_lstat_abs" => std::fs::symlink_metadata(&file_abs).map(|m| format!("len={}", m.len())),
        "std_open_abs_file" => std::fs::File::open(&file_abs).map(|_| "opened".to_string()),
        "std_read_dir_abs" => std::fs::read_dir(&base).map(|e| format!("{} entries", e.count())),
        // Directory-relative cap-std operations: what handle-based resolution needs.
        "cap_open_dir_relative" => dir.open_dir("sub").map(|_| "opened".to_string()),
        "cap_open_dir_nofollow_relative" => dir.open_dir_nofollow("sub").map(|_| "opened".to_string()),
        "cap_open_with_relative" => {
            let mut options = OpenOptions::new();
            options.read(true).follow(FollowSymlinks::No);
            dir.open_with("sub/a.txt", &options).map(|_| "opened".to_string())
        }
        "cap_symlink_metadata_relative" => dir.symlink_metadata("sub/a.txt").map(|m| format!("len={}", m.len())),
        "cap_read_dir_relative" => dir.read_dir("sub").map(|e| format!("{} entries", e.count())),
        "cap_canonicalize_relative" => dir.canonicalize("sub/a.txt").map(|p| format!("{p:?}")),
        // Raw syscalls: what the platform policy itself decides.
        "raw_openat_abs" => unsafe { let fd = libc::syscall(libc::SYS_openat, libc::AT_FDCWD, cf.as_ptr(), libc::O_RDONLY); if fd >= 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_openat_dirfd" => unsafe { let d = dirfd(); let n = c("a.txt"); let fd = libc::syscall(libc::SYS_openat, d, n.as_ptr(), libc::O_RDONLY); if fd >= 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_fstatat_dirfd" => unsafe { let d = dirfd(); let n = c("a.txt"); let mut st: libc::stat = std::mem::zeroed(); let r = libc::syscall(libc::SYS_newfstatat, d, n.as_ptr(), &mut st as *mut _, 0); if r == 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_statx_abs" => unsafe { let mut st: libc::statx = std::mem::zeroed(); let r = libc::syscall(291, libc::AT_FDCWD, cf.as_ptr(), 0, 0x7ffu32, &mut st as *mut _); if r == 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_getdents64" => unsafe { let d = dirfd(); let mut buf = [0u8; 1024]; let r = libc::syscall(61, d, buf.as_mut_ptr(), buf.len()); if r > 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_renameat2" => unsafe { let dst = c(&format!("{base}/sub/b.txt")); let r = libc::syscall(276, libc::AT_FDCWD, cf.as_ptr(), libc::AT_FDCWD, dst.as_ptr(), 0); if r == 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_faccessat2" => unsafe { let r = libc::syscall(439, libc::AT_FDCWD, cf.as_ptr(), libc::R_OK, 0); if r == 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_getrandom" => unsafe { let mut b = [0u8; 8]; let r = libc::syscall(278, b.as_mut_ptr(), b.len(), 0); if r == 8 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_openat2_abs" => unsafe { let how = [libc::O_RDONLY as u64, 0u64, 0u64]; let r = libc::syscall(437, libc::AT_FDCWD, cf.as_ptr(), how.as_ptr(), 24usize); if r >= 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_openat2_dirfd" => unsafe { let d = dirfd(); let n = c("a.txt"); let how = [libc::O_RDONLY as u64, 0u64, 0x08u64]; let r = libc::syscall(437, d, n.as_ptr(), how.as_ptr(), 24usize); if r >= 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_fchmodat2" => unsafe { let r = libc::syscall(452, libc::AT_FDCWD, cf.as_ptr(), 0o644, 0); if r == 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_rseq" => unsafe { let r = libc::syscall(293, std::ptr::null_mut::<u8>(), 0u32, 0u32, 0u32); if r == 0 || errno() == 22 || errno() == 38 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        "raw_clone3" => unsafe { let r = libc::syscall(435, std::ptr::null_mut::<u8>(), 0u64); if r >= 0 { Ok("allowed".into()) } else { Err(std::io::Error::from_raw_os_error(errno())) } },
        // Which directories can be opened at all: this is the anchor question for
        // every absolute-path resolution.
        "root_openable_root" => match Dir::open_ambient_dir("/", ambient_authority()) { Ok(_) => Ok("openable".into()), Err(error) => Err(error) },
        "root_openable_storage" => match Dir::open_ambient_dir("/storage", ambient_authority()) { Ok(_) => Ok("openable".into()), Err(error) => Err(error) },
        "root_openable_lib" => match Dir::open_ambient_dir("/lib", ambient_authority()) { Ok(_) => Ok("openable".into()), Err(error) => Err(error) },
        "root_openable_home" => match Dir::open_ambient_dir(&home, ambient_authority()) { Ok(_) => Ok("openable".into()), Err(error) => Err(error) },
        "root_stat_root" => std::fs::symlink_metadata("/").map(|_| "stat allowed".into()),
        other => { println!("OP {other} UNKNOWN"); return }
    };
    match result {
        Ok(detail) => println!("OP {op} OK {detail}"),
        Err(error) => println!("OP {op} ERR {error}"),
    }
}
