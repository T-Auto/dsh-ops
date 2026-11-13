use super::{
    argv, check, owned,
    security::{self, Security},
    spill_io::{self, Cancellation},
};
use std::{
    io,
    os::windows::{
        fs::MetadataExt,
        io::{AsRawHandle, IntoRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GENERIC_WRITE},
    Storage::FileSystem::*,
};

pub const MAX_SPILL_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Clone)]
pub struct SpillStore(Arc<Store>);
struct Store {
    root: PathBuf,
    directory: Mutex<Option<Result<Directory, String>>>,
    cap: u64,
}
struct Directory {
    path: PathBuf,
    _directory: OwnedHandle,
}
impl SpillStore {
    /// Allocation only: private directory and files are lazy on the output reader.
    pub fn new(root: &Path, cap: u64) -> io::Result<Self> {
        if !(1..=MAX_SPILL_BYTES).contains(&cap) {
            return Err(io::Error::other("spill cap must be 1..64 MiB"));
        }
        if !root.is_absolute() {
            return Err(io::Error::other("absolute spill root required"));
        }
        Ok(Self(Arc::new(Store {
            root: root.into(),
            directory: Mutex::new(None),
            cap,
        })))
    }
    pub fn cap(&self) -> u64 {
        self.0.cap
    }
    fn directory(&self, cancel: &Cancellation) -> io::Result<PathBuf> {
        cancel.operation(None, false, || {
            let mut directory = self.0.directory.lock().unwrap();
            let result = directory.get_or_insert_with(|| {
                Directory::create(&self.0.root).map_err(|error| error.to_string())
            });
            result
                .as_ref()
                .map(|value| value.path.clone())
                .map_err(|error| io::Error::other(error.clone()))
        })
    }
    #[cfg(test)]
    pub(super) fn test_directory(&self) -> PathBuf {
        self.0
            .directory
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .path
            .clone()
    }
    pub(super) fn create(&self, stream: &str, cancel: &Cancellation) -> io::Result<SpillFile> {
        if !matches!(stream, "stdout" | "stderr") {
            return Err(io::Error::other("invalid spill stream"));
        }
        let path = self
            .directory(cancel)?
            .join(format!("{stream}-{}.log", security::random_suffix()?));
        let wide = argv::wide(path.as_os_str())?;
        let security = Security::private()?;
        let file = cancel.operation(None, false, || {
            owned(unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_DELETE,
                    &security.attributes(),
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL
                        | FILE_FLAG_OPEN_REPARSE_POINT
                        | FILE_FLAG_OVERLAPPED
                        | FILE_FLAG_DELETE_ON_CLOSE,
                    std::ptr::null_mut(),
                )
            })
        })?;
        ensure_regular(&file, false)?;
        Ok(SpillFile {
            file: Some(file),
            path,
            store: self.clone(),
            cancel: cancel.clone(),
            written: 0,
            #[cfg(test)]
            fail_seal: false,
        })
    }
}
impl Directory {
    fn create(root: &Path) -> io::Result<Self> {
        physical(root)?;
        let root = std::fs::canonicalize(root)?;
        let root = public_path(&root)?;
        let path = root.join(format!(
            "dsh-ops-native-{}-{}",
            std::process::id(),
            security::random_suffix()?
        ));
        let security = Security::private()?;
        let wide = argv::wide(path.as_os_str())?;
        check(unsafe { CreateDirectoryW(wide.as_ptr(), &security.attributes()) })?;
        let directory = owned(unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        })?;
        ensure_regular(&directory, true)?;
        Ok(Self {
            path,
            _directory: directory,
        })
    }
}

pub(super) struct SpillFile {
    file: Option<OwnedHandle>,
    pub path: PathBuf,
    store: SpillStore,
    cancel: Cancellation,
    written: u64,
    #[cfg(test)]
    pub fail_seal: bool,
}
impl SpillFile {
    pub fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() as u64 > self.store.cap().saturating_sub(self.written) {
            return Err(io::Error::other("spill cap exceeded"));
        }
        spill_io::write(
            self.file.as_ref().unwrap().as_raw_handle(),
            self.written,
            bytes,
            &self.cancel,
        )?;
        self.written += bytes.len() as u64;
        Ok(())
    }
    pub fn close(&mut self, keep: bool) -> io::Result<PathBuf> {
        #[cfg(test)]
        if keep && std::mem::take(&mut self.fail_seal) {
            return Err(io::Error::other("fixture seal failed"));
        }
        if let Some(file) = &self.file {
            let handle = file.as_raw_handle();
            let disposition = FILE_DISPOSITION_INFO_EX {
                Flags: FILE_DISPOSITION_FLAG_ON_CLOSE
                    | if keep {
                        0
                    } else {
                        FILE_DISPOSITION_FLAG_DELETE
                    },
            };
            // EX with ON_CLOSE and without DELETE clears the original delete-on-close
            // state. The old FILE_DISPOSITION_INFO does not clear that creation flag.
            self.cancel.operation(Some(handle), true, || {
                check(unsafe {
                    SetFileInformationByHandle(
                        handle,
                        FileDispositionInfoEx,
                        (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
                        std::mem::size_of_val(&disposition) as u32,
                    )
                })
            })?;
        }
        let handle = self.file.as_ref().unwrap().as_raw_handle();
        self.cancel
            .operation(None, true, || check(unsafe { CloseHandle(handle) }))?;
        // Close succeeded. Disarm OwnedHandle only after that observation.
        let _ = self.file.take().unwrap().into_raw_handle();
        Ok(self.path.clone())
    }
}
impl Drop for SpillFile {
    fn drop(&mut self) {
        if self.file.is_some() && self.close(false).is_err() {
            // Retain the handle even on an unwinding reader. captures_until will
            // poison the owner rather than silently detach this failed cleanup.
            loop {
                std::thread::park();
            }
        }
    }
}

fn ensure_regular(handle: &OwnedHandle, directory: bool) -> io::Result<()> {
    let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { std::mem::zeroed() };
    check(unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            FileAttributeTagInfo,
            (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    })?;
    if unsafe { GetFileType(handle.as_raw_handle()) } != FILE_TYPE_DISK
        || info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
    {
        return Err(io::Error::other(
            "spill requires a physical directory and regular file",
        ));
    }
    Ok(())
}
fn physical(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::other("absolute spill root required"));
    }
    for ancestor in path.ancestors() {
        let entry = std::fs::symlink_metadata(ancestor)?;
        if !entry.is_dir() || entry.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::other(
                "spill ancestors must be physical directories",
            ));
        }
    }
    Ok(())
}
fn public_path(path: &Path) -> io::Result<PathBuf> {
    let value = path
        .to_str()
        .ok_or_else(|| io::Error::other("spill path must be Unicode"))?;
    Ok(if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{value}"))
    } else {
        PathBuf::from(value.strip_prefix(r"\\?\").unwrap_or(value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lazy_initialization_refuses_a_junction_ancestor() {
        let root =
            std::env::temp_dir().join(format!("spill-link-{}", security::random_suffix().unwrap()));
        let target = root.join("target");
        let link = root.join("link");
        std::fs::create_dir_all(target.join("nested")).unwrap();
        let created = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            created.status.success(),
            "{}",
            String::from_utf8_lossy(&created.stderr)
        );
        let store = SpillStore::new(&link.join("nested"), 1024).unwrap();
        let cancel = Cancellation::default();
        cancel.register().unwrap();
        let error = store.create("stdout", &cancel).err().unwrap();
        assert!(error.to_string().contains("physical directories"));
        assert_eq!(std::fs::read_dir(target.join("nested")).unwrap().count(), 0);
        drop(store);
        std::fs::remove_dir(link).unwrap();
        std::fs::remove_dir(target.join("nested")).unwrap();
        std::fs::remove_dir(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn live_file_is_readable_and_only_sealing_preserves_it_after_close() {
        let root = std::env::temp_dir();
        let store = SpillStore::new(
            &public_path(&std::fs::canonicalize(root).unwrap()).unwrap(),
            1024,
        )
        .unwrap();
        let cancel = Cancellation::default();
        cancel.register().unwrap();
        let mut file = store.create("stdout", &cancel).unwrap();
        file.write(b"live").unwrap();
        assert_eq!(std::fs::read(&file.path).unwrap(), b"live");
        let path = file.close(true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"live");
        std::fs::remove_file(path).unwrap();
        let mut discarded = store.create("stderr", &cancel).unwrap();
        discarded.write(b"discard").unwrap();
        let path = discarded.close(false).unwrap();
        assert!(!path.exists());
        let directory = store.test_directory();
        drop(file);
        drop(discarded);
        drop(store);
        std::fs::remove_dir(directory).unwrap();
    }
}
