//! Platform-specific private sibling preparation. Publication and CAS stay in
//! the shared write/copy pipeline; this module never publishes a destination.
use super::*;
use cap_std::fs::{Dir, File, OpenOptions};

pub(super) fn open_update_lock(parent: &Dir, name: &str, conflict: &str) -> Result<std::fs::File> {
    crate::file_path::validate_name(name)?;
    #[cfg(not(windows))]
    let _ = conflict;
    #[cfg(unix)]
    let file = {
        // A single validated sibling beneath an already-held no-follow directory.
        // Avoid cap-std's emulated create/open dance under simultaneous creators.
        let flags = rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC | rustix::fs::OFlags::NONBLOCK;
        // Darwin may return ENOENT to simultaneous non-exclusive O_CREAT opens.
        // Elect one creator with O_EXCL; EEXIST selects the persistent inode.
        // This is create-or-open, not a retry of a failed business operation.
        let created = rustix::fs::openat(parent, name,
            flags | rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR);
        let fd = match created {
            Ok(fd) => fd,
            Err(rustix::io::Errno::EXIST) => rustix::fs::openat(parent, name, flags, rustix::fs::Mode::empty())
                .map_err(|error| Failure::from(std::io::Error::from(error)))?,
            Err(error) => return Err(Failure::from(std::io::Error::from(error))),
        };
        File::from_std(std::fs::File::from(fd))
    };
    #[cfg(windows)]
    let file = parent
        .open_with(
            name,
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .follow(FollowSymlinks::No),
        )
        .map_err(|error| lock_failure(error, conflict))?;
    crate::file_path::regular(&file.metadata()?, false)?;
    Ok(file.into_std())
}

pub(super) fn lock_error(error: std::io::Error, conflict: &str) -> Failure {
    #[cfg(windows)]
    if lock_unsupported(&error) {
        return Failure::new(
            "LOCK_UNSUPPORTED",
            "This filesystem does not support exclusive file locks; nothing was changed. Use a local drive or the shell for this filesystem.",
        );
    }
    let _ = error;
    Failure::new("REVISION_CONFLICT", conflict)
}

/// A filesystem without byte-range locks reports `ERROR_INVALID_FUNCTION`
/// (WSL 9p), `ERROR_NOT_SUPPORTED`, or `ERROR_CALL_NOT_IMPLEMENTED`.
#[cfg(windows)]
fn lock_unsupported(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(1 | 50 | 120))
}

/// Another handle already holds the sidecar, or its byte-range lock.
#[cfg(windows)]
fn lock_failure(error: std::io::Error, conflict: &str) -> Failure {
    if matches!(error.raw_os_error(), Some(32 | 33)) {
        return Failure::new("REVISION_CONFLICT", conflict);
    }
    Failure::from(error)
}

pub fn check_revision(bytes: Option<&[u8]>, expected: &str) -> Result<()> {
    if expected != "absent" && !(expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
        return Err(Failure::new("INVALID_ARGUMENT", "expectedRevision must be absent or lowercase SHA-256"));
    }
    let actual = bytes.map(|bytes| format!("{:x}", Sha256::digest(bytes))).unwrap_or_else(|| "absent".into());
    if actual != expected { return Err(Failure::new("REVISION_CONFLICT", "Revision differs; inspect before preparing a new request")); }
    Ok(())
}

pub fn authorize_write(request: &Request, raw: &str) -> Result<PathBuf> {
    if request.read_only { return Err(Failure::policy("read-only", "User authorization is read-only")); }
    let checked = crate::file_path::checked_leaf(raw, true)?;
    request.authorize_path(&checked.display)?;
    if let Some(roots) = &request.write_roots {
        let parent = fs::canonicalize(checked.display.parent().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "No parent"))?)?;
        let candidate = parent.join(&checked.name);
        if !roots.iter().any(|root| fs::canonicalize(root).is_ok_and(|root| candidate.starts_with(root))) {
            return Err(Failure::policy("write-roots", "Target is outside authorized write roots"));
        }
    }
    Ok(checked.display)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs2::FileExt;
    #[test]
    fn simultaneous_lock_creators_keep_one_live_inode() {
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("ops-lock-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(12));
        let handles: Vec<_> = (0..12).map(|_| {
            let root = root.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                let parent = Dir::open_ambient_dir(root, cap_std::ambient_authority()).unwrap();
                barrier.wait();
                open_update_lock(&parent, ".dsh-ops-lock-test.lock", "held").unwrap()
            })
        }).collect();
        let files: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        FileExt::try_lock_exclusive(&files[0]).unwrap();
        for file in &files[1..] { assert!(FileExt::try_lock_exclusive(file).is_err(), "all creators must share one lock inode"); }
        drop(files);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revision_cas_never_treats_absent_as_a_wildcard() {
        check_revision(None, "absent").unwrap();
        assert_eq!(check_revision(Some(b"old"), "absent").unwrap_err().code, "REVISION_CONFLICT");
        let hash = format!("{:x}", Sha256::digest(b"old"));
        check_revision(Some(b"old"), &hash).unwrap();
        assert_eq!(check_revision(None, &hash).unwrap_err().code, "REVISION_CONFLICT");
        assert_eq!(check_revision(Some(b"new"), &hash).unwrap_err().code, "REVISION_CONFLICT");
        assert_eq!(check_revision(Some(b"old"), &hash.to_uppercase()).unwrap_err().code, "INVALID_ARGUMENT");
    }

    #[cfg(windows)]
    #[test]
    fn unsupported_lock_errors_are_classified_apart_from_contention() {
        for code in [1, 50, 120] {
            assert!(lock_unsupported(&std::io::Error::from_raw_os_error(code)), "raw {code} means the filesystem cannot lock");
            assert_eq!(lock_error(std::io::Error::from_raw_os_error(code), "held").code, "LOCK_UNSUPPORTED");
        }
        for code in [32, 33] {
            assert!(!lock_unsupported(&std::io::Error::from_raw_os_error(code)), "raw {code} means another holder, not a filesystem limit");
            assert_eq!(lock_error(std::io::Error::from_raw_os_error(code), "held").code, "REVISION_CONFLICT");
        }
    }
}


pub(super) fn create_sibling(
    parent: &Dir,
    temporary: &str,
    source: Option<&crate::file_path::Target>,
) -> Result<File> {
    #[cfg(windows)]
    {
        let _ = source;
        let parent = parent.try_clone()?.into_std_file();
        dsh_ops_windows_metadata::create_private(&parent, temporary)
            .map(File::from_std)
            .map_err(metadata_error)
    }
    #[cfg(target_os = "macos")]
    if let Some(source) = source {
        // Darwin ACLs are not the Linux POSIX ACL xattr. APFS cloning keeps the
        // original ACL and xattrs; unsupported filesystems must fail closed.
        let original = crate::file_path::read_file(source)?;
        dsh_ops_darwin_metadata::require_no_extended_acl(&original.try_clone()?.into_std())
            .map_err(|error| Failure::new("METADATA_UNSUPPORTED", error))?;
        // CLONE_ACL (0x0004) is an Apple public flag not named by rustix 1.1.
        // Without it clonefile inherits the destination ACL and drops source denies.
        rustix::fs::fclonefileat(
            &original,
            parent,
            temporary,
            rustix::fs::CloneFlags::from_bits_retain(0x0004),
        )
        .map_err(|error| {
            Failure::new(
                "METADATA_UNSUPPORTED",
                format!("APFS metadata-preserving clone is required; nothing published: {error}"),
            )
        })?;
        let prepared = (|| -> Result<File> {
            let cloned = parent.open_with(
                temporary,
                OpenOptions::new().read(true).follow(FollowSymlinks::No),
            )?;
            // Mask inherited grants before writing new bytes. The caller restores
            // the captured original mode after writing, before publication.
            rustix::fs::fchmod(&cloned, rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR)
                .map_err(|error| Failure::new("METADATA_UNSUPPORTED", error))?;
            Ok(parent.open_with(
                temporary,
                OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .follow(FollowSymlinks::No),
            )?)
        })();
        if prepared.is_err() {
            let _ = parent.remove_file(temporary);
        }
        return prepared;
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = source;
    #[cfg(not(windows))]
    let mut options = OpenOptions::new();
    #[cfg(not(windows))]
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(windows))]
    {
        Ok(parent.open_with(temporary, &options)?)
    }
}

#[cfg(windows)]
pub(super) fn metadata_error(error: std::io::Error) -> Failure {
    // The source was opened separately: failures inside capture/restore prove
    // metadata cannot be guaranteed, not that the DSH selector denied a write.
    Failure::new("METADATA_UNSUPPORTED", error)
}
#[cfg(windows)]
pub(super) struct Preserved(dsh_ops_windows_metadata::Metadata);
#[cfg(windows)]
impl Preserved {
    pub fn capture(source: &crate::file_path::Target, replacing: bool) -> Result<Self> {
        let file = crate::file_path::read_file(source)?.into_std();
        let metadata =
            dsh_ops_windows_metadata::Metadata::capture(&file).map_err(metadata_error)?;
        if replacing && metadata.readonly() {
            return Err(Failure::new(
                "ACCESS_DENIED",
                "Readonly files cannot be overwritten",
            ));
        }
        Ok(Self(metadata))
    }
    pub fn restore(&self, file: &File) -> Result<(Value, Vec<String>)> {
        self.0
            .restore(&file.try_clone()?.into_std())
            .map_err(metadata_error)?;
        Ok((
            json!({"owner":true,"group":true,"dacl":true,"attributes":true}),
            vec![],
        ))
    }
    pub fn verify(&self, parent: &Dir, name: &str) -> Result<()> {
        let verification = (|| -> Result<()> {
            let file = parent
                .open_with(
                    name,
                    OpenOptions::new().read(true).follow(FollowSymlinks::No),
                )?
                .into_std();
            self.0.verify(&file).map_err(metadata_error)
        })();
        verification.map_err(|mut failure| {
            failure.phase = "publish".into();
            failure.effect_state = "applied".into();
            failure.next_action =
                "The file is already published. Inspect metadata; do not blindly retry.".into();
            failure
        })
    }
}

/// Remove our exact staging link while its DELETE-capable handle is still owned.
/// Never change permissions: a copy may already share this inode with its target.
pub(super) fn discard_sibling(parent: &Dir, name: &str, file: File) -> Result<()> {
    #[cfg(windows)]
    let removed = dsh_ops_windows_metadata::discard(&file.into_std());
    #[cfg(not(windows))]
    drop(file);
    #[cfg(windows)]
    if removed.is_ok() { return Ok(()); }
    parent.remove_file(name).map_err(|error| {
        let mut failure = Failure::new("CLEANUP_FAILED", format!("Could not remove staging sibling {name}: {error}"));
        failure.phase = "cleanup".into();
        failure.effect_state = "unknown".into();
        failure.next_action = "Inspect the staging sibling and target before retrying; unpublished bytes may remain.".into();
        failure
    })
}
