// Design informed by mustafaahci/goz (MIT).
//! Cold enumeration of one root through FSCTL_ENUM_USN_DATA.
//!
//! usn-journal-rs gives us a stream of MftEntry values, each carrying a file id,
//! a parent file id, a name and attribute flags. Paths are not in the MFT, so
//! this module rebuilds them fully in memory: it indexes the nodes by file id,
//! locates the volume root, walks down to the requested root through the path
//! components, and then breadth-first descends the children map. That keeps the
//! cold path to one kernel enumeration instead of one syscall per entry, and it
//! never resolves paths by reopening files.
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
//! Candidate.key.file is the low 48-bit record number, the identifier cap-std
//! reports as ino() on NTFS. The full 64-bit file reference (record number plus
//! sequence) stays inside the volume index so a caller-visible key never
//! carries a generation; FileKey.volume is 0 until W2/W3 can report a real
//! volume serial without a raw Win32 call.

use ops_index::{Candidate, CandidateSet, EntryKind, EnumBudget, FileKey, SourceError};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use usn_journal_rs::{Fid, FileAttributes, UsnError, volume::Volume};

/// How many enumerated or assembled nodes run between two deadline checks.
pub const DEADLINE_CHECK_EVERY: usize = 4096;

/// Hard cap on the whole-volume MFT node map for one cold query.
///
/// A query is one-shot and must not allocate without bound for a multi-million
/// record volume. Exceeding the cap answers SourceError::Budget so the caller
/// falls back to its own traversal; the map is never truncated and published as
/// a complete set.
pub const MAX_MFT_NODES: usize = 1 << 20;

/// FileKey.volume until a metadata boundary can report a real serial.
const UNKNOWN_VOLUME: u64 = 0;

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

/// Cold enumeration of root within budget.
///
/// # Errors
///
/// - SourceError::Io when the root is missing or not a directory, or when the
///   volume handle or the MFT enumeration fails. A partially readable MFT is an
///   error, not a truncated set: an incomplete set must never look complete.
/// - SourceError::Unsupported when the process is not elevated, when the volume
///   cannot be mapped, or when a 128-bit (ReFS) file id appears.
/// - SourceError::Budget when the deadline expires or the whole-volume node
///   map would exceed MAX_MFT_NODES.
pub fn cold_candidates(root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
    if budget.expired() {
        return Err(SourceError::Budget);
    }
    let metadata = fs::metadata(root).map_err(|error| SourceError::Io(error.kind()))?;
    if !metadata.is_dir() {
        return Err(SourceError::Io(ErrorKind::NotADirectory));
    }
    if !process_is_elevated()? {
        // The documented fallback: no Administrator privileges means no
        // index-capable source, and the caller uses its own traversal.
        return Err(SourceError::Unsupported);
    }
    let (volume_root, root_components) = split_volume_root(root)?;
    let volume = Volume::from_mount_point(&volume_root).map_err(map_usn_error)?;
    let nodes = collect_nodes(&volume, &budget)?;
    let consistent_at_ms = now_ms();
    let batch = assemble(&nodes, &root_components, &budget)?;
    Ok(CandidateSet {
        entries: batch.entries,
        truncated: batch.truncated,
        consistent_at_ms,
    })
}

/// Whether this process can open a volume handle; errors map to Unsupported.
fn process_is_elevated() -> Result<bool, SourceError> {
    usn_journal_rs::privilege::is_elevated().map_err(|_| SourceError::Unsupported)
}

/// Collects every MFT record, refusing 128-bit ids and capping the map.
fn collect_nodes(volume: &Volume, budget: &EnumBudget) -> Result<Vec<MftNode>, SourceError> {
    let entries = volume.mft().iter().map(|item| {
        let entry = item.map_err(map_usn_error)?;
        if entry.fid.is_extended() || entry.parent_fid.is_extended() {
            // ReFS: FileKey only has 64 bits for the file half.
            return Err(SourceError::Unsupported);
        }
        Ok(MftNode {
            fid: entry.fid,
            parent: entry.parent_fid,
            name: entry.file_name,
            attributes: entry.file_attributes,
        })
    });
    collect_nodes_from(entries, budget, MAX_MFT_NODES)
}

/// Pure collection over an injectable record stream with an explicit node cap.
///
/// max_nodes exists so tests can exercise the cap without a million real
/// records; production passes MAX_MFT_NODES. The cap is checked before each
/// push, and the first over-cap record aborts with SourceError::Budget instead
/// of continuing to allocate. An empty volume is Unsupported, not an empty set.
pub(crate) fn collect_nodes_from<I>(
    items: I,
    budget: &EnumBudget,
    max_nodes: usize,
) -> Result<Vec<MftNode>, SourceError>
where
    I: IntoIterator<Item = Result<MftNode, SourceError>>,
{
    let mut nodes = Vec::new();
    let mut seen = 0usize;
    for item in items {
        seen += 1;
        if seen.is_multiple_of(DEADLINE_CHECK_EVERY) && budget.expired() {
            return Err(SourceError::Budget);
        }
        if nodes.len() >= max_nodes {
            return Err(SourceError::Budget);
        }
        nodes.push(item?);
    }
    if nodes.is_empty() {
        return Err(SourceError::Unsupported);
    }
    Ok(nodes)
}

/// Splits a root into its volume mount point and the components below it.
///
/// The mount point is rebuilt from the root's own prefix, so a caller path and
/// the volume path can never disagree about bytes; verbatim prefixes are
/// stripped for the volume handle call because the Win32 mount-point API does
/// not accept them.
fn split_volume_root(root: &Path) -> Result<(PathBuf, Vec<OsString>), SourceError> {
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
    let mut below = Vec::new();
    for component in components {
        match component {
            Component::Normal(name) => below.push(name.to_os_string()),
            Component::CurDir => {}
            _ => return Err(SourceError::Unsupported),
        }
    }
    Ok((plain_mount(&mount), below))
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

/// Rebuilds candidates from MFT records. Pure: no IO, no clock, no handles.
pub(crate) fn assemble(
    nodes: &[MftNode],
    root_components: &[OsString],
    budget: &EnumBudget,
) -> Result<ColdBatch, SourceError> {
    if budget.expired() {
        return Err(SourceError::Budget);
    }
    let mut by_fid: HashMap<u64, usize> = HashMap::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        let fid = node.fid.as_u64().ok_or(SourceError::Unsupported)?;
        node.parent.as_u64().ok_or(SourceError::Unsupported)?;
        // First record for an id wins; later duplicates are hard-link or short
        // name aliases that W4 reconciles.
        by_fid.entry(fid).or_insert(index);
    }
    let volume_root = find_volume_root(nodes, &by_fid).ok_or(SourceError::Unsupported)?;
    let root_fid = resolve_root(nodes, volume_root, root_components)?;

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
            // Only report truncation when a candidate actually exceeds the cap.
            // Checking before push also keeps a zero-entry budget empty.
            if entries.len() >= budget.max_entries {
                return Ok(ColdBatch {
                    entries,
                    truncated: true,
                });
            }
            let rel = base.join(&node.name);
            // FileKey.file is the low 48-bit record number, the same value
            // cap-std reports as ino() on NTFS; the sequence number stays in
            // the volume index, never in a caller-visible key.
            let record_number = Fid::new(child_fid)
                .record_number()
                .ok_or(SourceError::Unsupported)?;
            entries.push(Candidate {
                rel: rel.clone(),
                key: FileKey::new(UNKNOWN_VOLUME, record_number),
                kind: kind_of(node.attributes),
                len: 0,
                modified_ns: None,
            });
            queue.push((child_fid, rel, child_depth));
        }
    }
    Ok(ColdBatch { entries, truncated })
}

/// Finds the volume root record: a self-parented record, or NTFS record 5.
fn find_volume_root(nodes: &[MftNode], by_fid: &HashMap<u64, usize>) -> Option<u64> {
    for node in nodes {
        let Some(fid) = node.fid.as_u64() else {
            continue;
        };
        if node.parent.as_u64() == Some(fid) {
            return Some(fid);
        }
    }
    let root = Fid::new(5).as_u64()?;
    by_fid.contains_key(&root).then_some(root)
}

/// Walks from the volume root through the requested components to the root id.
fn resolve_root(
    nodes: &[MftNode],
    volume_root: u64,
    root_components: &[OsString],
) -> Result<u64, SourceError> {
    let mut current = volume_root;
    for component in root_components {
        let mut found = None;
        for node in nodes {
            if node.parent.as_u64() != Some(current) || !name_matches(&node.name, component) {
                continue;
            }
            if found.is_some() {
                // Two records claim the same parent and name: refuse rather
                // than pick one at random.
                return Err(SourceError::Unsupported);
            }
            found = node.fid.as_u64();
        }
        current = found.ok_or(SourceError::Unsupported)?;
    }
    Ok(current)
}

/// NTFS compares names case-insensitively; this comparison is exact first and
/// then ASCII-case-insensitive, which covers ordinary path spelling.
fn name_matches(stored: &OsStr, wanted: &OsStr) -> bool {
    stored == wanted
        || stored
            .to_string_lossy()
            .eq_ignore_ascii_case(&wanted.to_string_lossy())
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
fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(before) => -i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX),
    }
}

#[cfg(test)]
#[path = "mft_tests.rs"]
mod mft_tests;
