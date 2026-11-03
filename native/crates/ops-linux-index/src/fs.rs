// Design informed by mustafaahci/goz (MIT).
//! File-system classification for the Linux index source.
//!
//! Not every mounted file system can back an index that this crate is allowed
//! to serve. Network file systems (NFS) and FUSE mounts have no local event
//! source that survives a worker process, procfs and sysfs are kernel-generated
//! pseudo file systems whose entries are not stable file identities at all, and
//! a snapshot over any of them cannot be kept consistent. For all of them the
//! source must report `Offline` ([`ops_index::SourceState::Unavailable`]) so the
//! caller falls back to the existing walk instead of trusting a snapshot.
//!
//! # Why the mount table, not `statfs(2)`
//!
//! The crate is `#![forbid(unsafe_code)]` and takes no `libc`/`rustix`
//! dependency, so it cannot issue the `statfs` syscall directly. The kernel's
//! mount table at [`MOUNT_TABLE_PATH`] carries exactly the classification that
//! `statfs` would report (`f_type` mapped to a name) plus the mount point
//! needed to decide which entry owns a root; reading it is plain file I/O. If a
//! later slice takes a dependency-reviewed syscall wrapper, only
//! [`classify_root`] needs to change: everything below it is pure table logic
//! and is tested with synthetic tables.
//!
//! The classification is deliberately conservative. Any `fuse*` type is
//! treated as FUSE (including `fusectl`) and any `nfs*` type as NFS (including
//! the kernel's `nfsd` pseudo file system): a false `Offline` only costs the
//! caller the walk it already had, while a false index-backed answer would be a
//! correctness bug.
//!
//! # Mount table format
//!
//! `/proc/self/mounts` is the older, six-field form:
//!
//! ```text
//! <source> <mount point> <fs type> <options> <dump> <pass>
//! ```
//!
//! The mount point escapes space, tab, newline and backslash as `\040`,
//! `\011`, `\012` and `\134` (three octal digits after a backslash);
//! [`parse_mounts`] decodes exactly that. Malformed lines are skipped rather
//! than failing the whole classification: a kernel-generated table is
//! well-formed, so a skipped line can only mean a format this crate does not
//! understand, and one unclassifiable line must not make every root unindexable.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The kernel mount table read for classification.
pub const MOUNT_TABLE_PATH: &str = "/proc/self/mounts";

/// File-system families this crate refuses to index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnsupportedFs {
    /// Network file system (`nfs`, `nfs4`, and the conservative `nfs*` family).
    Nfs,
    /// FUSE-backed file system (`fuse`, `fuse.sshfs`, `fusectl`, ...).
    Fuse,
    /// Kernel process pseudo file system.
    Procfs,
    /// Kernel device pseudo file system.
    Sysfs,
}

impl UnsupportedFs {
    /// Classifies a mount table file-system type name.
    pub fn from_fs_type(fs_type: &str) -> Option<Self> {
        if fs_type.starts_with("nfs") {
            return Some(Self::Nfs);
        }
        if fs_type == "fuse" || fs_type.starts_with("fuse") {
            return Some(Self::Fuse);
        }
        match fs_type {
            "proc" => Some(Self::Procfs),
            "sysfs" => Some(Self::Sysfs),
            _ => None,
        }
    }

    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::Nfs => "INDEX_FS_NFS",
            Self::Fuse => "INDEX_FS_FUSE",
            Self::Procfs => "INDEX_FS_PROCFS",
            Self::Sysfs => "INDEX_FS_SYSFS",
        }
    }

    /// Canonical family name for diagnostics.
    pub fn name(self) -> &'static str {
        match self {
            Self::Nfs => "nfs",
            Self::Fuse => "fuse",
            Self::Procfs => "procfs",
            Self::Sysfs => "sysfs",
        }
    }
}

/// One row of the kernel mount table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountPoint {
    /// Decoded mount point path.
    pub path: PathBuf,
    /// File-system type name exactly as the kernel prints it.
    pub fs_type: String,
}

/// Where a root lives and whether the index may serve it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classification {
    mount_point: Option<PathBuf>,
    fs_type: Option<String>,
    unsupported: Option<UnsupportedFs>,
}

impl Classification {
    /// Mount point that owns the root, when the table knew it.
    pub fn mount_point(&self) -> Option<&Path> {
        self.mount_point.as_deref()
    }

    /// File-system type name of that mount point.
    pub fn fs_type(&self) -> Option<&str> {
        self.fs_type.as_deref()
    }

    /// Unsupported family, when the root must stay `Offline`.
    pub fn unsupported(&self) -> Option<UnsupportedFs> {
        self.unsupported
    }

    /// Whether the source must report `Offline` for this root.
    pub fn is_offline(&self) -> bool {
        self.unsupported.is_some()
    }
}

/// Classifies `root` by reading the kernel mount table.
///
/// A read failure is returned as an I/O error; the caller decides whether to
/// treat an unreadable table as `Offline` (the safe choice) or as no
/// classification at all.
pub fn classify_root(root: &Path) -> io::Result<Classification> {
    let table = fs::read_to_string(MOUNT_TABLE_PATH)?;
    Ok(classify_mounts(root, &table))
}

/// Classifies `root` against a mount table body.
///
/// Pure: this is the function the tests drive with synthetic tables.
pub fn classify_mounts(root: &Path, table: &str) -> Classification {
    let mounts = parse_mounts(table);
    let owner = mounts
        .iter()
        .filter(|mount| root.starts_with(&mount.path))
        .max_by_key(|mount| mount.path.components().count());
    match owner {
        Some(owner) => {
            let unsupported = UnsupportedFs::from_fs_type(&owner.fs_type);
            Classification {
                mount_point: Some(owner.path.clone()),
                fs_type: Some(owner.fs_type.clone()),
                unsupported,
            }
        }
        // No mount owns the path: do not invent an offline reason. The source
        // treats this like any other unclassified local root.
        None => Classification {
            mount_point: None,
            fs_type: None,
            unsupported: None,
        },
    }
}

/// Parses a mount table body, skipping lines that do not have at least the
/// three fields this module needs.
pub fn parse_mounts(table: &str) -> Vec<MountPoint> {
    table.lines().filter_map(parse_mount_line).collect()
}

fn parse_mount_line(line: &str) -> Option<MountPoint> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut fields = line.split_whitespace();
    let _source = fields.next()?;
    let mount_point = fields.next()?;
    let fs_type = fields.next()?;
    if mount_point.is_empty() || fs_type.is_empty() {
        return None;
    }
    Some(MountPoint {
        path: decode_mount_path(mount_point),
        fs_type: fs_type.to_owned(),
    })
}

/// Decodes the kernel escape form of a mount point.
///
/// A backslash followed by exactly three octal digits is the byte they name;
/// any other backslash is kept literally (the kernel only escapes whitespace
/// and backslash, so this cannot silently corrupt a valid path).
fn decode_mount_path(raw: &str) -> PathBuf {
    let mut decoded = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\\' {
            decoded.push(character);
            continue;
        }
        let mut digits = String::with_capacity(3);
        while digits.len() < 3 {
            match chars.peek() {
                Some(next) if next.is_ascii_digit() && *next < '8' => {
                    digits.push(*next);
                    chars.next();
                }
                _ => break,
            }
        }
        if digits.len() == 3 {
            // The kernel escapes one byte, so values above 0xFF are not a
            // kernel escape and stay literal (see the module docs).
            let decoded_escape = u32::from_str_radix(&digits, 8)
                .ok()
                .filter(|value| *value <= u32::from(u8::MAX))
                .and_then(char::from_u32);
            if let Some(character) = decoded_escape {
                decoded.push(character);
                continue;
            }
        }
        decoded.push('\\');
        decoded.push_str(&digits);
    }
    PathBuf::from(decoded)
}

#[cfg(test)]
#[path = "fs_tests.rs"]
mod fs_tests;
