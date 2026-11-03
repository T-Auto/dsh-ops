// Design informed by mustafaahci/goz (MIT).
//! Cold enumeration of a Linux directory tree into [`Candidate`] values.
//!
//! The walker is a breadth-first `read_dir` recursion. It never follows a
//! symlink (candidates of kind `Link` are reported, their targets are not
//! entered), never reads file contents, and never reports a partial answer as
//! complete: an I/O failure or a passed deadline is returned as an error, and a
//! depth cut is reported through [`CandidateSet::truncated`].
//!
//! Parallelism is per directory: one level's directories are read and lstat'ed
//! concurrently, then the next level starts. The finished set is sorted by
//! relative path component order before the entry budget is applied, so the
//! same tree and budget always return the same entries — truncation keeps the
//! lexicographically first `max_entries` names rather than whichever entries
//! won a scheduling race.
//!
//! Depth counts relative path components: the root is depth 0, its direct
//! children depth 1. A directory at the depth cap is not entered, and the set
//! is marked truncated only when that directory actually has content, so a tree
//! that fits the budget exactly is not falsely reported as cut.

use ops_index::FileKey;
use ops_index::source::{Candidate, CandidateSet, EntryKind, EnumBudget, SourceError};
use rayon::prelude::*;
use std::fs::{DirEntry, Metadata};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// One directory's contribution to the walk.
struct DirBatch {
    entries: Vec<Candidate>,
    subdirs: Vec<PathBuf>,
    /// A directory at the depth cap had content that was not enumerated.
    truncated: bool,
}

/// The two budget values the walk itself must enforce.
///
/// `max_entries` is deliberately absent: it limits the returned set, which is
/// applied after the global sort, never the traversal order.
struct WalkBudget {
    deadline: Instant,
    max_depth: usize,
}

impl WalkBudget {
    fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }
}

/// Enumerates `root` within `budget`.
///
/// The root itself is not a candidate, but it is followed when it is a symlink:
/// the caller named that path, and the relative paths stay rooted at it. Every
/// entry below the root is lstat'ed, never followed.
///
/// An already-expired deadline, or one that passes during the walk, returns
/// [`SourceError::Budget`]. Any I/O failure (missing root, a file used as the
/// root, a directory that cannot be read, an entry that vanished between
/// `read_dir` and `lstat`) returns [`SourceError::Io`]. The caller falls back to
/// its own traversal on either error.
pub fn enumerate(root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
    if budget.expired() {
        return Err(SourceError::Budget);
    }
    let metadata = std::fs::metadata(root).map_err(io_error)?;
    if !metadata.is_dir() {
        return Err(SourceError::Io(io::ErrorKind::NotADirectory));
    }

    let walk = WalkBudget {
        deadline: budget.deadline,
        max_depth: budget.max_depth,
    };
    let mut entries = Vec::new();
    let mut truncated = false;

    if budget.max_depth == 0 {
        // No relative path has fewer than one component, so nothing can be
        // returned; still report a non-empty root as truncated rather than
        // claiming an empty volume.
        truncated = std::fs::read_dir(root).map_err(io_error)?.next().is_some();
        return Ok(finish(entries, budget.max_entries, truncated));
    }

    let mut current = vec![root.to_path_buf()];
    let mut depth = 1;
    while !current.is_empty() && depth <= walk.max_depth {
        if walk.expired() {
            return Err(SourceError::Budget);
        }
        let batches = current
            .par_iter()
            .map(|dir| walk_directory(root, dir, depth, &walk))
            .collect::<Result<Vec<_>, SourceError>>()?;
        let mut next = Vec::new();
        for batch in batches {
            entries.extend(batch.entries);
            next.extend(batch.subdirs);
            truncated |= batch.truncated;
        }
        current = next;
        depth += 1;
    }

    Ok(finish(entries, budget.max_entries, truncated))
}

/// Reads one directory and maps its entries, collecting subdirectories at the
/// next level.
fn walk_directory(
    root: &Path,
    dir: &Path,
    depth: usize,
    walk: &WalkBudget,
) -> Result<DirBatch, SourceError> {
    if walk.expired() {
        return Err(SourceError::Budget);
    }

    let read = std::fs::read_dir(dir).map_err(io_error)?;
    let mut raw = Vec::new();
    for item in read {
        if walk.expired() {
            return Err(SourceError::Budget);
        }
        raw.push(item.map_err(io_error)?);
    }
    raw.sort_by_key(DirEntry::file_name);

    let mut batch = DirBatch {
        entries: Vec::new(),
        subdirs: Vec::new(),
        truncated: false,
    };
    for entry in raw {
        if walk.expired() {
            return Err(SourceError::Budget);
        }
        let metadata = entry.metadata().map_err(io_error)?;
        let rel = entry
            .path()
            .strip_prefix(root)
            .map(Path::to_path_buf)
            .map_err(|_| SourceError::Io(io::ErrorKind::InvalidInput))?;
        let kind = classify(&metadata);
        if kind == EntryKind::Dir {
            if depth < walk.max_depth {
                batch.subdirs.push(entry.path());
            } else {
                // Entries below the depth cap are not enumerated. Report
                // truncation only when this directory really has content, so an
                // exactly-sized tree is not falsely marked incomplete.
                batch.truncated |= mark_depth_truncation(&entry.path())?;
            }
        }
        batch.entries.push(Candidate {
            rel,
            key: FileKey::new(metadata.dev(), metadata.ino()),
            kind,
            len: file_len(&metadata, kind),
            modified_ns: modified_ns(&metadata),
        });
    }

    Ok(batch)
}

/// Maps a directory at the depth cap: if it has any entry, the walk below it
/// was skipped and the set is truncated.
fn mark_depth_truncation(dir: &Path) -> Result<bool, SourceError> {
    match std::fs::read_dir(dir).map_err(io_error)?.next() {
        Some(Ok(_)) => Ok(true),
        Some(Err(error)) => Err(SourceError::Io(error.kind())),
        None => Ok(false),
    }
}

/// Sorts by relative path component order, then applies the entry budget.
///
/// Sorting first makes truncation deterministic: the retained entries are the
/// first `max_entries` names in path order, independent of rayon scheduling or
/// the file system's directory order.
fn finish(entries: Vec<Candidate>, max_entries: usize, mut truncated: bool) -> CandidateSet {
    let mut entries = entries;
    entries.sort_by(|left, right| left.rel.cmp(&right.rel));
    if entries.len() > max_entries {
        entries.truncate(max_entries);
        truncated = true;
    }
    CandidateSet {
        entries,
        truncated,
        consistent_at_ms: now_ms(),
    }
}

fn classify(metadata: &Metadata) -> EntryKind {
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        EntryKind::Link
    } else if file_type.is_dir() {
        EntryKind::Dir
    } else if file_type.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

/// Size in bytes for regular files only; the source has no size to report for
/// directories, links, sockets and devices.
fn file_len(metadata: &Metadata, kind: EntryKind) -> u64 {
    if kind == EntryKind::File {
        metadata.len()
    } else {
        0
    }
}

/// Modification time in nanoseconds since the Unix epoch, when it fits in i64
/// (files outside roughly 1677-2262 report `None` rather than wrapping).
fn modified_ns(metadata: &Metadata) -> Option<i64> {
    let seconds = i128::from(metadata.mtime());
    let nanos = i128::from(metadata.mtime_nsec());
    let total = seconds.checked_mul(1_000_000_000)?.checked_add(nanos)?;
    i64::try_from(total).ok()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

fn io_error(error: io::Error) -> SourceError {
    SourceError::Io(error.kind())
}

#[cfg(test)]
#[path = "walk_tests.rs"]
mod walk_tests;
