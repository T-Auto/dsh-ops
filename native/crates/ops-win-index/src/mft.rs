// Design informed by mustafaahci/goz (MIT).
//! Cold enumeration of one root through FSCTL_ENUM_USN_DATA.
//!
//! usn-journal-rs gives us a stream of MftEntry values, each carrying a file id,
//! a parent file id, a name and attribute flags. Paths are not in the MFT, so
//! this module rebuilds them fully in memory: it indexes the nodes by parent id
//! and breadth-first descends the children map from the requested root, whose
//! file id is the directory's own cap-fs-ext ino(). That keeps the cold path to
//! one kernel enumeration instead of one syscall per entry, it never resolves
//! paths by reopening files, and no short (8.3) or case-folded caller path can
//! change which directory is indexed.
//!
//! Budget rules mirror the macOS cold source so callers see one contract:
//!
//! - max_entries bounds what the caller receives; the scan stops as soon as it
//!   has that many candidates and reports truncated. Because the MFT yields
//!   records in a stable order for an unchanged volume, the cut is reproducible.
//! - max_depth prunes a subtree at the limit and reports truncated; max_depth
//!   of 0 returns no entry (the volume root itself is depth 0).
//! - an expired deadline returns SourceError::Budget rather than a partial set;
//!   a partial set would only be a second full scan for the caller.
//!
//! The MFT enumeration is volume-wide even when the root is a small directory.
//! Budgets bound the returned candidates and the deadline aborts mid-scan, but
//! peak memory is the volume's file count, not the requested page. That is the
//! price of the single kernel pass; W2 replaces it with a journal-backed
//! incremental path.
//!
//! Duplicate MFT records for one file id (a hard link seen twice, or a short
//! name next to a long one) are collapsed to the first record. The link
//! reconciliation slice (W4) is what makes every name visible; W1 must not
//! invent links it cannot prove.
//!
//! Identity is cap-fs-ext's identity: Candidate.key.file is the full 64-bit
//! nFileIndex (the MFT file reference, record number in the low 48 bits and
//! sequence in the high 16) and Candidate.key.volume is the volume serial
//! number read through cap-std from the volume root's directory metadata. A
//! candidate key therefore compares equal to cap-fs-ext's (dev, ino), which is
//! what lets the integration trust an indexed hit without an id-drift fallback.

use cap_fs_ext::MetadataExt;
use ops_index::{Candidate, CandidateSet, EntryKind, EnumBudget, FileKey, SourceError};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use usn_journal_rs::{Fid, FileAttributes, UsnError, volume::Volume};

/// How many enumerated or assembled nodes run between two deadline checks.
pub const DEADLINE_CHECK_EVERY: usize = 4096;

/// Hard cap on the whole-volume MFT node map this crate will build.
///
/// A query is one-shot and must not allocate without limit for a multi-million
/// record volume; exceeding the cap answers SourceError::Budget so the caller
/// falls back to its own traversal.
pub const MAX_MFT_NODES: usize = 1 << 20;

/// One MFT record reduced to what path assembly needs.
#[derive(Clone, Debug)]
pub(crate) struct MftNode {
    pub(crate) fid: Fid,
    pub(crate) parent: Fid,
    pub(crate) name: OsString,
    pub(crate) attributes: FileAttributes,
}

/// Result of the pure assembly step, before it becomes a CandidateSet.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ColdBatch {
    pub(crate) entries: Vec<Candidate>,
    pub(crate) truncated: bool,
}

/// A volume opened for one request plus the identity read from its root.
pub(crate) struct OpenedVolume {
    pub(crate) volume: Volume,
    pub(crate) volume_serial: u64,
    pub(crate) root_fid: u64,
}

/// Opens the volume that hosts root and reads the root's identity.
///
/// The identity is read through cap-std/cap-fs-ext, the same layer the
/// integration uses: dev() is the volume serial and ino() is the root
/// directory's full 64-bit nFileIndex, which is also its MFT file id. That
/// makes the whole subtree directly addressable without walking path
/// components, and it keeps a short-name or case-folded caller path from
/// changing which directory is indexed. Ambient authority is used once, on the
/// requested root, for directory metadata only; it never widens what the caller
/// may open.
pub(crate) fn open_for_root(root: &Path) -> Result<OpenedVolume, SourceError> {
    let metadata = fs::metadata(root).map_err(|error| SourceError::Io(error.kind()))?;
    if !metadata.is_dir() {
        return Err(SourceError::Io(ErrorKind::NotADirectory));
    }
    if !process_is_elevated()? {
        // The documented fallback: no Administrator privileges means no
        // index-capable source, and the caller uses its own traversal.
        return Err(SourceError::Unsupported);
    }
    let volume_root = volume_mount(root)?;
    let volume = Volume::from_mount_point(&volume_root).map_err(map_usn_error)?;
    let root_dir = cap_std::fs::Dir::open_ambient_dir(root, cap_std::ambient_authority())
        .map_err(|error| SourceError::Io(error.kind()))?;
    let root_metadata = root_dir
        .dir_metadata()
        .map_err(|error| SourceError::Io(error.kind()))?;
    Ok(OpenedVolume {
        volume,
        volume_serial: root_metadata.dev(),
        root_fid: root_metadata.ino(),
    })
}

/// Cold enumeration of root within budget.
///
/// # Errors
///
/// - SourceError::Io when the root is missing or not a directory, or when the
///   volume handle or the MFT enumeration fails. A partially readable MFT is an
///   error, not a truncated set: an incomplete set must never look complete.
/// - SourceError::Unsupported when the process is not elevated, when the volume
///   cannot be mapped, or when a 128-bit (ReFS) file id appears.
/// - SourceError::Budget when the deadline expires.
pub fn cold_candidates(root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
    if budget.expired() {
        return Err(SourceError::Budget);
    }
    let opened = open_for_root(root)?;
    let nodes = collect_nodes(&opened.volume, &budget)?;
    let consistent_at_ms = now_ms();
    let batch = assemble(&nodes, opened.root_fid, opened.volume_serial, &budget)?;
    Ok(CandidateSet {
        entries: batch.entries,
        truncated: batch.truncated,
        consistent_at_ms,
    })
}

/// Whether this process can open a volume handle; errors map to Unsupported.
pub(crate) fn process_is_elevated() -> Result<bool, SourceError> {
    usn_journal_rs::privilege::is_elevated().map_err(|_| SourceError::Unsupported)
}

/// Enforces the whole-volume node cap before the next push.
pub(crate) fn check_node_budget(nodes: usize) -> Result<(), SourceError> {
    if nodes >= MAX_MFT_NODES {
        return Err(SourceError::Budget);
    }
    Ok(())
}

/// Collects every MFT record, refusing 128-bit ids and capping the map.
pub(crate) fn collect_nodes(
    volume: &Volume,
    budget: &EnumBudget,
) -> Result<Vec<MftNode>, SourceError> {
    let mut nodes = Vec::new();
    let mut seen = 0usize;
    for item in volume.mft().iter() {
        seen += 1;
        if seen.is_multiple_of(DEADLINE_CHECK_EVERY) && budget.expired() {
            return Err(SourceError::Budget);
        }
        let entry = item.map_err(map_usn_error)?;
        if entry.fid.is_extended() || entry.parent_fid.is_extended() {
            // ReFS: FileKey only has 64 bits for the file half.
            return Err(SourceError::Unsupported);
        }
        check_node_budget(nodes.len())?;
        nodes.push(MftNode {
            fid: entry.fid,
            parent: entry.parent_fid,
            name: entry.file_name,
            attributes: entry.file_attributes,
        });
    }
    if nodes.is_empty() {
        return Err(SourceError::Unsupported);
    }
    Ok(nodes)
}

/// Rebuilds the volume mount point from a root's own path prefix.
///
/// The mount point is taken from the root's prefix, so a caller path and the
/// volume path cannot disagree about bytes; a verbatim prefix is stripped
/// because the Win32 mount-point API does not accept it.
fn volume_mount(root: &Path) -> Result<PathBuf, SourceError> {
    let mut components = root.components();
    let first = components.next().ok_or(SourceError::Unsupported)?;
    let mut mount = PathBuf::from(first.as_os_str());
    match first {
        Component::Prefix(_) => {
            if components.next() != Some(Component::RootDir) {
                return Err(SourceError::Unsupported);
            }
            mount.push(Component::RootDir.as_os_str());
        }
        Component::RootDir => {}
        _ => return Err(SourceError::Unsupported),
    }
    Ok(plain_mount(&mount))
}

/// Strips a verbatim prefix so the Win32 mount-point API accepts the path.
fn plain_mount(mount: &Path) -> PathBuf {
    let text = mount.as_os_str().to_string_lossy();
    if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
        return PathBuf::from(format!("\\\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix("\\\\?\\") {
        return PathBuf::from(rest);
    }
    mount.to_path_buf()
}

/// Relative paths of every entry below the requested root, keyed by file id.
///
/// The map includes the requested root itself with an empty path, so a journal
/// event can resolve its parent directory without a special case. The node cap
/// and the cycle guard keep this bounded even for a damaged parent graph.
pub(crate) struct SubtreePaths {
    pub(crate) paths: HashMap<u64, PathBuf>,
}

/// Rebuilds the requested subtree's relative paths. Pure: no IO, no clock.
pub(crate) fn subtree_paths(nodes: &[MftNode], root_fid: u64) -> Result<SubtreePaths, SourceError> {
    let mut children: HashMap<u64, Vec<usize>> = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        let parent = node.parent.as_u64().ok_or(SourceError::Unsupported)?;
        children.entry(parent).or_default().push(index);
    }
    let mut paths: HashMap<u64, PathBuf> = HashMap::new();
    paths.insert(root_fid, PathBuf::new());
    let mut visited: HashSet<u64> = HashSet::new();
    visited.insert(root_fid);
    let mut queue = vec![root_fid];
    while let Some(fid) = queue.pop() {
        let Some(indexes) = children.get(&fid) else {
            continue;
        };
        let base = paths.get(&fid).cloned().unwrap_or_default();
        for index in indexes {
            let node = &nodes[*index];
            let child = node.fid.as_u64().ok_or(SourceError::Unsupported)?;
            if !visited.insert(child) {
                continue;
            }
            let rel = base.join(&node.name);
            paths.insert(child, rel);
            queue.push(child);
        }
    }
    Ok(SubtreePaths { paths })
}

/// Rebuilds candidates from MFT records. Pure: no IO, no clock, no handles.
pub(crate) fn assemble(
    nodes: &[MftNode],
    root_fid: u64,
    volume_serial: u64,
    budget: &EnumBudget,
) -> Result<ColdBatch, SourceError> {
    if budget.expired() {
        return Err(SourceError::Budget);
    }
    let mut children: HashMap<u64, Vec<usize>> = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        let parent = node.parent.as_u64().ok_or(SourceError::Unsupported)?;
        children.entry(parent).or_default().push(index);
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    let mut visited: HashSet<u64> = HashSet::new();
    visited.insert(root_fid);
    let mut queue: Vec<(u64, PathBuf, usize)> = vec![(root_fid, PathBuf::new(), 0)];
    let mut assembled = 0usize;
    while let Some((fid, base, depth)) = queue.pop() {
        let Some(child_indexes) = children.get(&fid) else {
            continue;
        };
        for index in child_indexes {
            let node = &nodes[*index];
            let child_fid = node.fid.as_u64().ok_or(SourceError::Unsupported)?;
            if !visited.insert(child_fid) {
                continue;
            }
            assembled += 1;
            if assembled.is_multiple_of(DEADLINE_CHECK_EVERY) && budget.expired() {
                return Err(SourceError::Budget);
            }
            let child_depth = depth + 1;
            if child_depth > budget.max_depth {
                // The child is not listed, so its own children cannot be
                // either: the set is not complete.
                truncated = true;
                continue;
            }
            let rel = base.join(&node.name);
            // (volume serial, full 64-bit nFileIndex) is exactly what
            // cap-fs-ext reports as (dev(), ino()) for an open handle.
            entries.push(Candidate {
                rel: rel.clone(),
                key: FileKey::new(volume_serial, child_fid),
                kind: kind_of(node.attributes),
                len: 0,
                modified_ns: None,
            });
            if entries.len() >= budget.max_entries {
                truncated = true;
                return Ok(ColdBatch { entries, truncated });
            }
            queue.push((child_fid, rel, child_depth));
        }
    }
    Ok(ColdBatch { entries, truncated })
}

/// Maps MFT attribute flags to the crate's entry kind.
fn kind_of(attributes: FileAttributes) -> EntryKind {
    if attributes.is_reparse_point() {
        EntryKind::Link
    } else if attributes.is_directory() {
        EntryKind::Dir
    } else {
        EntryKind::File
    }
}

/// Maps a usn-journal-rs failure onto the crate's honest source errors.
pub(crate) fn map_usn_error(error: UsnError) -> SourceError {
    if error.is_permission_denied() {
        // An unprivileged process is the documented fallback, not an I/O fault.
        return SourceError::Unsupported;
    }
    match &error {
        UsnError::IoError(io) => SourceError::Io(io.kind()),
        UsnError::InvalidMountPointError(_) => SourceError::Unsupported,
        _ if error.is_parse_error() => SourceError::Io(ErrorKind::InvalidData),
        _ => SourceError::Io(ErrorKind::Other),
    }
}

/// Wall-clock milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(before) => -i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

#[cfg(test)]
#[path = "mft_tests.rs"]
mod mft_tests;
