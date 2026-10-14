//! Absolute host-resolved paths, opened component-by-component with no-follow.
use crate::contract::{Failure, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
#[cfg(windows)]
use cap_fs_ext::OsMetadataExt;
use cap_std::{ambient_authority, fs::{Dir, File, Metadata, OpenOptions}};
use std::path::{Component, Path, PathBuf};

pub struct Target { pub parent: Dir, pub name: String, pub display: PathBuf }
pub fn checked(raw: &str) -> Result<Target> {
    let path = Path::new(raw);
    if !path.is_absolute() || raw.len() > 4096 || raw.contains('\0') {
        return Err(Failure::new("INVALID_ARGUMENT", "Expected one absolute, bounded host-resolved path"));
    }
    let mut anchor = PathBuf::new(); let mut names = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                #[cfg(windows)]
                if !matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::UNC(_, _)) {
                    return Err(Failure::new("INVALID_ARGUMENT", "Device and verbatim paths are unsupported"));
                }
                anchor.push(prefix.as_os_str());
            }
            Component::RootDir => anchor.push(component.as_os_str()),
            Component::Normal(name) => {
                let name = name.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
                validate_name(name)?; names.push(name.to_owned());
            }
            _ => return Err(Failure::new("INVALID_ARGUMENT", "Worker paths must be lexically normalized")),
        }
    }
    let name = names.pop().unwrap_or_else(|| ".".into());
    // OHOS (target_env = "ohos") denies opening "/" and "/storage" outright
    // (EACCES/EPERM), so the upstream root anchor fails for every request. Walk from
    // the deepest openable ancestor prefix instead and continue the usual no-follow
    // checks on the remaining components. Every other target compiles the upstream
    // statements verbatim below; the fallback is compiled on OHOS targets only.
    #[cfg(not(target_env = "ohos"))]
    let mut parent = Dir::open_ambient_dir(&anchor, ambient_authority())?;
    #[cfg(not(target_env = "ohos"))]
    for component in names {
        regular(&parent.symlink_metadata(&component)?, true)?;
        parent = parent.open_dir_nofollow(&component)?;
    }
    #[cfg(target_env = "ohos")]
    let parent = {
        let mut opened: Option<(Dir, usize)> = None;
        let mut last_error: Option<std::io::Error> = None;
        for split in 0..=names.len() {
            let mut probe = anchor.clone();
            for component in names.iter().take(split) { probe.push(component); }
            match Dir::open_ambient_dir(&probe, ambient_authority()) {
                Ok(dir) => { opened = Some((dir, split)); break }
                Err(error) => last_error = Some(error),
            }
        }
        let (mut dir, split) = match opened {
            Some(value) => value,
            None => return Err(last_error.expect("at least one candidate anchor").into()),
        };
        for component in names.into_iter().skip(split) {
            regular(&dir.symlink_metadata(&component)?, true)?;
            dir = dir.open_dir_nofollow(&component)?;
        }
        dir
    };
    regular(&parent.dir_metadata()?, true)?;
    regular(&parent.symlink_metadata(&name)?, false)?;
    Ok(Target { parent, name, display: path.to_path_buf() })
}
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains('\0') {
        return Err(Failure::new("INVALID_ARGUMENT", format!("Invalid path component {name:?}")));
    }
    #[cfg(windows)]
    {
        let base = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        let port = base.strip_prefix("COM").or_else(|| base.strip_prefix("LPT"));
        if name.ends_with(['.', ' ']) || name.contains([':', '*', '?', '<', '>', '|', '"'])
            || matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
            || port.is_some_and(|p| matches!(p, "1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"¹"|"²"|"³"))
        { return Err(Failure::new("INVALID_ARGUMENT", format!("Reserved, ambiguous or device path component {name:?}"))); }
    }
    Ok(())
}
pub fn link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 { return true; }
    false
}
pub fn regular(metadata: &Metadata, directory: bool) -> Result<()> {
    if link(metadata) || (!metadata.is_file() && !metadata.is_dir()) || (directory && !metadata.is_dir()) {
        return Err(Failure::new("POLICY_DENIED", "Links, reparse points and special objects are not traversed; inspect the target path for the offending entry"));
    }
    Ok(())
}
pub fn read_file(target: &Target) -> Result<File> {
    let metadata = target.parent.symlink_metadata(&target.name)?;
    regular(&metadata, false)?;
    if !metadata.is_file() { return Err(Failure::new("IS_DIRECTORY", "Expected a regular file; use ops_glob for a directory")); }
    let mut options = OpenOptions::new(); options.read(true).follow(FollowSymlinks::No);
    let file = target.parent.open_with(&target.name, &options)?;
    regular(&file.metadata()?, false)?;
    Ok(file)
}
