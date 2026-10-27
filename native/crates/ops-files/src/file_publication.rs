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

    #[cfg(target_os = "macos")]
    #[test]
    fn plain_clone_is_available_without_the_acl_flag() {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("ops-clone-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source_path = root.join("source");
        std::fs::write(&source_path, b"payload").unwrap();
        let source = crate::file_path::checked(source_path.to_str().unwrap()).unwrap();
        let original = crate::file_path::read_file(&source).unwrap();
        let parent = Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap();
        // macOS 13+ takes the CLONE_ACL branch; macOS 12 takes the plain retry.
        clone_macos_source(&original, &parent, "clone").unwrap();
        // The fallback body (plain clone plus the post-clone ACL re-check) must
        // work on every supported macOS, including the CI macOS 15 runner.
        clone_macos_source_fallback(&original, &parent, "clone-plain").unwrap();
        for name in ["clone", "clone-plain"] {
            assert_eq!(std::fs::read(root.join(name)).unwrap(), b"payload");
        }
        drop(original);
        drop(parent);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "macos")]
    mod macos_fallback {
        use super::*;

        struct Fixture {
            root: PathBuf,
            original: File,
            parent: Dir,
        }

        impl Fixture {
            fn new() -> Self {
                let root = std::fs::canonicalize(std::env::temp_dir()).unwrap()
                    .join(format!("ops-clone-acl-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir(&root).unwrap();
                let source = root.join("source");
                std::fs::write(&source, b"private payload").unwrap();
                let target = crate::file_path::checked(source.to_str().unwrap()).unwrap();
                let original = crate::file_path::read_file(&target).unwrap();
                rustix::fs::fchmod(&original, rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR).unwrap();
                let parent = Dir::open_ambient_dir(&root, cap_std::ambient_authority()).unwrap();
                Self { root, original, parent }
            }

            fn add_acl(&self, name: &str, entry: &str) {
                let path = self.root.join(name);
                assert!(std::process::Command::new("/bin/chmod")
                    .args(["+a", entry]).arg(&path).status().unwrap().success());
                let file = std::fs::File::open(&path).unwrap();
                assert!(dsh_ops_darwin_metadata::require_no_extended_acl(&file).is_err(),
                    "the fixture must have a real extended ACL");
            }

            fn clone_plain(&self) {
                clone_macos_source_plain(&self.original, &self.parent, "clone").unwrap();
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                // Clear fixture deny-delete entries even when an assertion panics.
                for path in std::iter::once(self.root.clone()).chain(
                    std::fs::read_dir(&self.root).unwrap().map(|entry| entry.unwrap().path()),
                ) {
                    let _ = std::process::Command::new("/bin/chmod")
                        .arg("-N").arg(path).status();
                }
                std::fs::remove_dir_all(&self.root).unwrap();
            }
        }

        #[test]
        fn directory_acl_is_refused_before_plain_clone() {
            let fixture = Fixture::new();
            fixture.add_acl("", "everyone allow read,file_inherit,directory_inherit");
            let error = clone_macos_source_fallback(&fixture.original, &fixture.parent, "clone")
                .unwrap_err();
            assert_eq!(error.code, "METADATA_UNSUPPORTED");
            assert_eq!(&*error.effect_state, "none");
            assert!(!fixture.root.join("clone").exists());
            assert_eq!(std::fs::read(fixture.root.join("source")).unwrap(), b"private payload");
        }

        #[test]
        fn clone_acl_is_refused_and_the_clone_is_removed() {
            let fixture = Fixture::new();
            fixture.clone_plain();
            fixture.add_acl("clone", "everyone allow read");
            let error = recheck_macos_clone(&fixture.original, &fixture.parent, "clone").unwrap_err();
            assert_eq!(error.code, "METADATA_UNSUPPORTED");
            assert!(!fixture.root.join("clone").exists());
        }

        #[test]
        fn source_acl_added_after_cloning_removes_the_clone() {
            let fixture = Fixture::new();
            fixture.clone_plain();
            fixture.add_acl("source", "everyone deny delete");
            let error = recheck_macos_clone(&fixture.original, &fixture.parent, "clone").unwrap_err();
            assert_eq!(error.code, "METADATA_UNSUPPORTED");
            assert_eq!(&*error.effect_state, "none");
            assert!(!fixture.root.join("clone").exists());
        }

        #[test]
        fn failed_clone_cleanup_reports_remaining_effects() {
            let fixture = Fixture::new();
            fixture.clone_plain();
            fixture.add_acl("source", "everyone deny delete");
            fixture.add_acl("clone", "everyone deny delete");
            let error = recheck_macos_clone(&fixture.original, &fixture.parent, "clone").unwrap_err();
            assert_eq!(error.code, "CLEANUP_FAILED");
            assert_eq!(&*error.phase, "cleanup");
            assert_eq!(&*error.effect_state, "unknown");
            assert!(error.next_action.contains("Inspect"));
            assert!(fixture.root.join("clone").exists());
        }

        #[test]
        fn missing_clone_fails_the_metadata_recheck() {
            let fixture = Fixture::new();
            let error = recheck_macos_clone(&fixture.original, &fixture.parent, "clone").unwrap_err();
            assert_eq!(error.code, "METADATA_UNSUPPORTED");
            assert_eq!(&*error.effect_state, "none");
        }

        #[test]
        fn clone_recheck_never_follows_a_substituted_symlink() {
            let fixture = Fixture::new();
            std::os::unix::fs::symlink("source", fixture.root.join("clone")).unwrap();
            let error = recheck_macos_clone(&fixture.original, &fixture.parent, "clone").unwrap_err();
            assert_eq!(error.code, "METADATA_UNSUPPORTED");
            assert!(!fixture.root.join("clone").exists());
            assert_eq!(std::fs::read(fixture.root.join("source")).unwrap(), b"private payload");
        }

        #[test]
        fn plain_clone_failure_keeps_an_existing_destination() {
            let fixture = Fixture::new();
            std::fs::write(fixture.root.join("clone"), b"existing").unwrap();
            let error = clone_macos_source_fallback(&fixture.original, &fixture.parent, "clone")
                .unwrap_err();
            assert_eq!(error.code, "METADATA_UNSUPPORTED");
            assert_eq!(std::fs::read(fixture.root.join("clone")).unwrap(), b"existing");
        }
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
        clone_macos_source(&original, parent, temporary)?;
        let prepared = (|| -> Result<File> {
            let cloned = parent.open_with(
                temporary,
                OpenOptions::new().read(true).follow(FollowSymlinks::No),
            )?;
            // Restrict mode bits before writing; chmod does not remove Darwin ACLs.
            // The plain-clone fallback checks ACLs separately. The caller restores
            // the captured original mode before publication.
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
        return match prepared {
            Ok(file) => Ok(file),
            Err(error) => reject_macos_clone(parent, temporary, error),
        }
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

/// Clone a source that the caller has already accepted after checking it has no
/// extended ACL. macOS 13+ implements `CLONE_ACL`; macOS 12 (`xnu-8020`) returns
/// `EINVAL` for that flag. The plain retry also requires an ACL-free destination
/// directory and rechecks both source and clone before the caller writes.
#[cfg(target_os = "macos")]
fn clone_macos_source(original: &File, parent: &Dir, temporary: &str) -> Result<()> {
    // CLONE_ACL (0x0004) is an Apple public flag not named by rustix 1.1.
    const CLONE_ACL: u32 = 0x0004;
    match rustix::fs::fclonefileat(
        original,
        parent,
        temporary,
        rustix::fs::CloneFlags::from_bits_retain(CLONE_ACL),
    ) {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::INVAL) => {
            clone_macos_source_fallback(original, parent, temporary)
        }
        Err(error) => Err(clone_macos_failure(error)),
    }
}

#[cfg(target_os = "macos")]
fn clone_macos_source_fallback(original: &File, parent: &Dir, temporary: &str) -> Result<()> {
    // A plain clone inherits the destination directory ACL, even if the source
    // has none. Refuse before copying any source bytes into inherited grants.
    let directory = parent.try_clone()
        .map_err(|error| Failure::new("METADATA_UNSUPPORTED", error))?
        .into_std_file();
    dsh_ops_darwin_metadata::require_no_extended_acl(&directory)
        .map_err(|error| Failure::new("METADATA_UNSUPPORTED",
            format!("Plain APFS clone requires a destination directory without an extended ACL: {error}")))?;
    clone_macos_source_plain(original, parent, temporary)?;
    recheck_macos_clone(original, parent, temporary)
}

#[cfg(target_os = "macos")]
fn recheck_macos_clone(original: &File, parent: &Dir, temporary: &str) -> Result<()> {
    // The source may have gained an ACL, or the clone may have inherited one
    // since the directory probe. Neither is safe to publish. chmod cannot fix it.
    let recheck = (|| -> std::io::Result<()> {
        dsh_ops_darwin_metadata::require_no_extended_acl(&original.try_clone()?.into_std())?;
        let cloned = parent.open_with(temporary,
            OpenOptions::new().read(true).follow(FollowSymlinks::No))?;
        dsh_ops_darwin_metadata::require_no_extended_acl(&cloned.into_std())
    })().map_err(|error| Failure::new("METADATA_UNSUPPORTED",
        format!("Post-clone metadata check failed; destination not published: {error}")));
    if let Err(error) = recheck {
        return reject_macos_clone(parent, temporary, error);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn reject_macos_clone<T>(parent: &Dir, temporary: &str, error: Failure) -> Result<T> {
    if let Err(cleanup) = parent.remove_file(temporary) {
        if cleanup.kind() != std::io::ErrorKind::NotFound {
            let mut failure = Failure::new("CLEANUP_FAILED",
                format!("{}; could not remove staging sibling {temporary}: {cleanup}", error.message));
            failure.phase = "cleanup".into();
            failure.effect_state = "unknown".into();
            failure.next_action = "Inspect the staging sibling and target before retrying; unpublished bytes may remain.".into();
            return Err(failure);
        }
    }
    Err(error)
}

#[cfg(target_os = "macos")]
fn clone_macos_source_plain(original: &File, parent: &Dir, temporary: &str) -> Result<()> {
    rustix::fs::fclonefileat(original, parent, temporary, rustix::fs::CloneFlags::empty())
        .map_err(clone_macos_failure)
}

#[cfg(target_os = "macos")]
fn clone_macos_failure(error: rustix::io::Errno) -> Failure {
    Failure::new(
        "METADATA_UNSUPPORTED",
        format!("APFS metadata-preserving clone is required; nothing published: {error}"),
    )
}

#[cfg(windows)]
fn metadata_error(error: std::io::Error) -> Failure {
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
