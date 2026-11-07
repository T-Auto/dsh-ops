//! Private no-follow cache objects. These helpers never alter business-file permissions.
use crate::contract::{Failure, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions};

pub fn verify(file: &File, directory: bool, write_sid: Option<&str>) -> Result<()> {
    #[cfg(not(windows))]
    let _ = write_sid;
    let metadata = file.metadata()?;
    crate::file_path::regular(&metadata, directory)?;
    if !directory && (!metadata.is_file() || metadata.nlink() != 1) {
        return Err(Failure::new(
            "PATH_RESTRICTED",
            "Cache files must be regular single-link objects",
        ));
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        if metadata.uid() != rustix::process::geteuid().as_raw() || metadata.mode() & 0o077 != 0 {
            return Err(Failure::new(
                "PATH_RESTRICTED",
                "Cache objects must be private to the current user",
            ));
        }
    }
    #[cfg(windows)]
    dsh_ops_windows_metadata::verify_cache(&file.try_clone()?.into_std(), write_sid)
        .map_err(|error| Failure::new("PATH_RESTRICTED", error))?;
    Ok(())
}
pub fn directory(parent: &Dir, name: &str, create: bool, write_sid: Option<&str>) -> Result<Dir> {
    crate::file_path::validate_name(name)?;
    if create {
        #[cfg(windows)]
        let created = dsh_ops_windows_metadata::create_cache_object(
            &parent.try_clone()?.into_std_file(),
            name,
            true,
            write_sid,
        )
        .map(|_| ());
        #[cfg(unix)]
        let created = {
            use cap_std::fs::DirBuilderExt;
            let mut builder = cap_std::fs::DirBuilder::new();
            builder.mode(0o700);
            parent.create_dir_with(name, &builder)
        };
        match created {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
    }
    crate::file_path::regular(&parent.symlink_metadata(name)?, true)?;
    let directory = parent.open_dir_nofollow(name)?;
    verify(
        &File::from_std(directory.try_clone()?.into_std_file()),
        true,
        write_sid,
    )?;
    Ok(directory)
}
pub fn create_file(parent: &Dir, name: &str, write_sid: Option<&str>) -> Result<File> {
    crate::file_path::validate_name(name)?;
    #[cfg(windows)]
    let file = dsh_ops_windows_metadata::create_cache_object(
        &parent.try_clone()?.into_std_file(),
        name,
        false,
        write_sid,
    )
    .map(File::from_std)
    .map_err(Failure::from)?;
    #[cfg(unix)]
    let file = {
        use cap_std::fs::OpenOptionsExt;
        parent.open_with(
            name,
            OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .follow(FollowSymlinks::No),
        )?
    };
    verify(&file, false, write_sid)?;
    Ok(file)
}
pub fn open_file(
    parent: &Dir,
    name: &str,
    writable: bool,
    write_sid: Option<&str>,
) -> Result<File> {
    crate::file_path::validate_name(name)?;
    crate::file_path::regular(&parent.symlink_metadata(name)?, false)?;
    let file = parent.open_with(
        name,
        OpenOptions::new()
            .read(true)
            .write(writable)
            .follow(FollowSymlinks::No),
    )?;
    verify(&file, false, write_sid)?;
    Ok(file)
}
/// Exclusive creation elects one stable lock inode. Never unlink a live lock.
pub fn lock_file(parent: &Dir, writable: bool, write_sid: Option<&str>) -> Result<File> {
    if writable {
        match create_file(parent, "lock", write_sid) {
            Ok(file) => return Ok(file),
            Err(error) if error.code == "REVISION_CONFLICT" => (),
            Err(error) => return Err(error),
        }
    }
    open_file(parent, "lock", writable, write_sid)
}
