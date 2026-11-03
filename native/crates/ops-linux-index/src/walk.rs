// Design informed by mustafaahci/goz (MIT).
//! Cold enumeration of a Linux directory tree into [`Candidate`] values.
//!
//! The walker is a breadth-first `read_dir` recursion. It never follows a
//! symlink (candidates of kind `Link` are reported, their targets are not
//! entered), never reads file contents, and reports a stopped walk through
//! [`CandidateSet::truncated`]. Any I/O failure aborts the whole set: a partial
//! answer must never be reported as complete.
//!
//! Parallelism is per directory: one level's directories are read and lstat'ed
//! concurrently, then the next level starts. Entries are returned in
//! breadth-first order with each directory's names sorted, so a walk with a
//! non-truncating budget is reproducible; a truncating entry budget keeps
//! whichever entries won the shared slots, and the set is discarded by the
//! caller anyway because `truncated` is set.
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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// One directory's contribution to the walk.
struct DirBatch {
    entries: Vec<Candidate>,
    subdirs: Vec<PathBuf>,
    /// The shared budget stopped this directory; the caller must stop too.
    stopped: bool,
}

/// Entry/depth/deadline budget shared by the concurrent per-directory tasks.
struct WalkBudget {
    remaining: AtomicUsize,
    truncated: AtomicBool,
    deadline: Instant,
    max_depth: usize,
}

impl WalkBudget {
    fn new(budget: EnumBudget) -> Self {
        Self {
            remaining: AtomicUsize::new(budget.max_entries),
            truncated: AtomicBool::new(false),
            deadline: budget.deadline,
            max_depth: budget.max_depth,
        }
    }

    fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// Reserves one entry slot. Returns false (and marks the set truncated)
    /// when the entry budget is exhausted.
    fn reserve(&self) -> bool {
        let mut current = self.remaining.load(Ordering::Relaxed);
        loop {
            if current == 0 {
                self.truncated.store(true, Ordering::Relaxed);
                return false;
            }
            match self.remaining.compare_exchange_weak(
                current,
                current - 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(observed) => current = observed,
            }
        }
    }

    fn mark_truncated(&self) {
        self.truncated.store(true, Ordering::Relaxed);
    }
}

/// Enumerates `root` within `budget`.
///
/// The root itself is not a candidate, but it is followed when it is a symlink:
/// the caller named that path, and the relative paths stay rooted at it. Every
/// entry below the root is lstat'ed, never followed.
///
/// Any I/O failure (missing root, a file used as the root, a directory that
/// cannot be read, an entry that vanished between `read_dir` and `lstat`) is
/// returned as [`SourceError::Io`]; the caller then falls back to its own
/// traversal.
pub fn enumerate(root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
    if budget.expired() {
        return Err(SourceError::Budget);
    }
    let metadata = std::fs::metadata(root).map_err(io_error)?;
    if !metadata.is_dir() {
        return Err(SourceError::Io(io::ErrorKind::NotADirectory));
    }

    let walk = WalkBudget::new(budget);
    let mut entries = Vec::new();

    if budget.max_depth == 0 {
        // No relative path has fewer than one component, so nothing can be
        // returned; still report a non-empty root as truncated rather than
        // claiming an empty volume.
        if std::fs::read_dir(root).map_err(io_error)?.next().is_some() {
            walk.mark_truncated();
        }
        return Ok(finish(entries, &walk));
    }

    let mut current = vec![root.to_path_buf()];
    let mut depth = 1;
    while !current.is_empty() && depth <= walk.max_depth {
        let batches = current
            .par_iter()
            .map(|dir| walk_directory(root, dir, depth, &walk))
            .collect::<Result<Vec<_>, SourceError>>()?;
        let mut next = Vec::new();
        let mut stopped = false;
        for batch in batches {
            entries.extend(batch.entries);
            next.extend(batch.subdirs);
            stopped |= batch.stopped;
        }
        if stopped {
            break;
        }
        if walk.expired() {
            walk.mark_truncated();
            break;
        }
        current = next;
        depth += 1;
    }

    Ok(finish(entries, &walk))
}

/// Reads one directory and maps its entries, collecting subdirectories at the
/// next level.
fn walk_directory(
    root: &Path,
    dir: &Path,
    depth: usize,
    walk: &WalkBudget,
) -> Result<DirBatch, SourceError> {
    let mut batch = DirBatch {
        entries: Vec::new(),
        subdirs: Vec::new(),
        stopped: false,
    };
    if walk.expired() {
        walk.mark_truncated();
        batch.stopped = true;
        return Ok(batch);
    }

    let read = std::fs::read_dir(dir).map_err(io_error)?;
    let mut raw = Vec::new();
    for item in read {
        raw.push(item.map_err(io_error)?);
    }
    // Sorted by name so an untruncated walk is reproducible regardless of the
    // file system's directory order or rayon's scheduling.
    raw.sort_by_key(DirEntry::file_name);

    for entry in raw {
        if walk.expired() {
            walk.mark_truncated();
            batch.stopped = true;
            break;
        }
        if !walk.reserve() {
            batch.stopped = true;
            break;
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
                mark_depth_truncation(&entry.path(), walk)?;
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
fn mark_depth_truncation(dir: &Path, walk: &WalkBudget) -> Result<(), SourceError> {
    match std::fs::read_dir(dir).map_err(io_error)?.next() {
        Some(Ok(_)) => {
            walk.mark_truncated();
            Ok(())
        }
        Some(Err(error)) => Err(SourceError::Io(error.kind())),
        None => Ok(()),
    }
}

fn finish(entries: Vec<Candidate>, walk: &WalkBudget) -> CandidateSet {
    CandidateSet {
        entries,
        truncated: walk.truncated.load(Ordering::Relaxed),
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
