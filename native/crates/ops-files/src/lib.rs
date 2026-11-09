#![forbid(unsafe_code)]
use ops_protocol as contract;
pub mod cache_io;
mod file;
pub mod file_path;
pub mod paths;
#[cfg(all(test, unix))]
use cap_std::ambient_authority;
#[cfg(unix)]
use cap_std::fs::Dir;
#[cfg(unix)]
use contract::Result;
pub use file::{
    MAX_FILE_BYTES, MAX_OUTPUT_BYTES, UpdateLock, atomic_write, authorize_write, check_revision,
    dispatch, lock_and_read_for_update, lock_for_update, read_bytes, relative_display, result,
    target,
};

/// Persist a directory's entries after an atomic publish.
///
/// cap-std hands out `O_PATH` directory descriptors on Linux and `fsync` on an
/// `O_PATH` descriptor fails with `EBADF`. Reopening the same directory through
/// `/proc/self/fd` yields an ordinary descriptor, which is how cap-primitives
/// itself works around `O_PATH` handles elsewhere.
#[cfg(unix)]
pub fn sync_directory(dir: &Dir) -> Result<()> {
    let handle = dir.try_clone()?.into_std_file();
    let first = match handle.sync_all() {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        if let Ok(reopened) = std::fs::File::open(format!("/proc/self/fd/{}", handle.as_raw_fd())) {
            return reopened.sync_all().map_err(Into::into);
        }
    }
    Err(first.into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A crash-safe publish replays the barrier on the directory itself, so the
    /// barrier has to work on the handle cap-std hands out.
    #[test]
    fn directory_sync_succeeds_on_ambient_directories() {
        let root = std::env::temp_dir().join(format!("dsh-ops-sync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).expect("create temporary directory");
        let dir =
            Dir::open_ambient_dir(&root, ambient_authority()).expect("open ambient directory");
        sync_directory(&dir).expect("directory sync");
        std::fs::remove_dir(&root).expect("remove temporary directory");
    }
}
