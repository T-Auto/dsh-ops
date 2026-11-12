// Design informed by mustafaahci/goz (MIT).

//! Cold, bounded enumeration of one root with `std::fs::read_dir`, with the
//! per-directory work fanned out by `rayon`.
//!
//! ## Why two phases
//!
//! Reading directories is cheap next to reading each entry's metadata: #423
//! measured `symlink_metadata` at 71–87 % of an `ops_glob` walk. So the cold
//! path is split where the cost is:
//!
//! 1. `read_dir` recursion collects the names and file types. Sibling
//!    directories are visited in parallel through `rayon`; a directory's own
//!    `read_dir` stays serial because the syscall is cheap.
//! 2. The collected entries become [`Candidate`] values in a `rayon` parallel
//!    map. Each one costs a `stat` for size, modification time and
//!    `(dev, ino)`, which is exactly the part that parallelises.
//!
//! There is no third-party walker: the recursion is `std::fs` only, so the
//! traversal keeps the same path-based semantics as `read_dir` itself and adds
//! no crate that would need its own handle-boundary review.
//!
//! The result is sorted by relative path before the entry budget is applied, so
//! the truncation boundary is deterministic. [`CandidateSet`] still documents
//! that order belongs to the source; sorting here is what makes the *budget*
//! reproducible, not a promise about enumeration order.
//!
//! ## Budget rules
//!
//! - `max_entries`: the returned set is cut to that many entries (after
//!   sorting) and reports [`CandidateSet::truncated`]. Peak walk memory is the
//!   tree's name/type list, not the returned set: the budget bounds what a
//!   caller receives, not what the cold scan observes.
//! - `max_depth`: entries deeper than that many path components are not
//!   visited. A directory sitting exactly at the limit may hide children, so
//!   `truncated` is set as well. `max_depth == 0` fits no entry at all (the
//!   root itself is depth 0) and is likewise reported as truncated.
//! - `deadline`: checked before the walk, every [`DEADLINE_CHECK_EVERY`]
//!   directory entries read, and every [`DEADLINE_CHECK_EVERY`] mapped entries.
//!   An expired deadline returns [`SourceError::Budget`] instead of a partial
//!   set: the caller discards the index result and falls back to its own
//!   traversal either way, and a partial set would only be a second full walk.
//!
//! ## What an entry means
//!
//! - `rel` is the path relative to the root, with the root itself never
//!   listed (depth 0 is the root).
//! - `key` is `(st_dev, st_ino)`: stable across renames and hard links, which
//!   is what the index needs to apply a rename as a move instead of a
//!   delete/add pair.
//! - `kind` comes from the directory entry's own type, without following
//!   links. Symlinks are reported as [`EntryKind::Link`] and never descended
//!   into.
//! - `len` is the size for regular files and `0` for everything else, so a
//!   directory's block count can never be mistaken for a file size.
//! - `modified_ns` is whole nanoseconds since the Unix epoch, negative before
//!   it, and `None` when the platform cannot report a modification time.

use ops_index::{Candidate, CandidateSet, EntryKind, EnumBudget, FileKey, SourceError};
use rayon::prelude::*;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many entries run between two deadline checks.
pub const DEADLINE_CHECK_EVERY: usize = 1024;

/// Cold enumeration of `root` within `budget`.
///
/// # Errors
///
/// - [`SourceError::Budget`] when the deadline expired before or during the
///   walk. Nothing partial is returned.
/// - [`SourceError::Io`] when the root is not a readable directory or when any
///   directory could not be read. A partially readable tree is an error rather
///   than a `truncated` set: "incomplete because a directory was refused" and
///   "incomplete because the budget ran out" are different answers, and only
///   the caller can decide what to do with the first.
/// - [`SourceError::Io`] also when one entry's own `stat` fails, for example an
///   entry deleted between the directory read and the metadata call. The whole
///   enumeration fails rather than silently leaving a gap, so a caller falls
///   back to its own traversal instead of reporting an incomplete set as
///   complete.
///
/// # Root symlinks
///
/// The root itself is followed when it is a symlink (`fs::metadata` and
/// `fs::read_dir` both resolve the path), while every descendant symlink is
/// reported as [`EntryKind::Link`] and never descended into. That is an
/// invariant of this source: "the root is followed, descendants never are."
pub fn walk_root(root: &Path, budget: EnumBudget) -> Result<CandidateSet, SourceError> {
    if budget.expired() {
        return Err(SourceError::Budget);
    }
    // The set is anchored at the start of the walk: every entry observed below
    // existed no later than this instant. M2 replaces the anchor with the
    // event-id time of the replay point.
    let consistent_at_ms = now_ms();
    let root_metadata = fs::metadata(root).map_err(|error| SourceError::Io(error.kind()))?;
    if !root_metadata.is_dir() {
        return Err(SourceError::Io(ErrorKind::NotADirectory));
    }
    if budget.max_depth == 0 {
        return Ok(CandidateSet {
            entries: Vec::new(),
            truncated: true,
            consistent_at_ms,
        });
    }
    let scan = scan_directory(root, Path::new(""), 1, budget)?;
    let mut candidates = scan
        .entries
        .par_iter()
        .enumerate()
        .map(|(index, entry)| {
            if index.is_multiple_of(DEADLINE_CHECK_EVERY) && budget.expired() {
                return Err(SourceError::Budget);
            }
            candidate_for(root, entry)
        })
        .collect::<Result<Vec<_>, SourceError>>()?;
    // Sorting before the cut makes the truncation boundary deterministic even
    // though sibling directories are visited in parallel.
    candidates.sort_by(|left, right| left.rel.cmp(&right.rel));
    let mut truncated = scan.truncated;
    if candidates.len() > budget.max_entries {
        truncated = true;
        candidates.truncate(budget.max_entries);
    }
    Ok(CandidateSet {
        entries: candidates,
        truncated,
        consistent_at_ms,
    })
}

/// One entry as the traversal sees it, before its metadata is read.
struct RawEntry {
    /// Path relative to the root.
    rel: PathBuf,
    /// Type from the directory entry itself, without following links.
    file_type: fs::FileType,
}

/// What one directory subtree contains.
struct DirectoryScan {
    /// Entries below the directory, in visit order.
    entries: Vec<RawEntry>,
    /// Whether a budget cut a part of the subtree away.
    truncated: bool,
}

/// Visits `dir` and its descendants, `rel_prefix` being the path of `dir`
/// relative to the root and `depth` the component depth of its children.
///
/// Sibling directories are scanned in parallel; the recursion is bounded by
/// [`EnumBudget::max_depth`] and re-checks the deadline as it goes.
fn scan_directory(
    dir: &Path,
    rel_prefix: &Path,
    depth: usize,
    budget: EnumBudget,
) -> Result<DirectoryScan, SourceError> {
    let mut entries = Vec::new();
    let mut subdirectories: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut truncated = false;
    let mut seen = 0usize;
    for next in fs::read_dir(dir).map_err(|error| SourceError::Io(error.kind()))? {
        seen += 1;
        if seen.is_multiple_of(DEADLINE_CHECK_EVERY) && budget.expired() {
            return Err(SourceError::Budget);
        }
        let entry = next.map_err(|error| SourceError::Io(error.kind()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| SourceError::Io(error.kind()))?;
        let rel = rel_prefix.join(entry.file_name());
        if file_type.is_dir() {
            if depth == budget.max_depth {
                // The directory itself is listed, but its children cannot be:
                // the set is not complete.
                truncated = true;
            } else {
                subdirectories.push((rel.clone(), entry.path()));
            }
        }
        entries.push(RawEntry { rel, file_type });
    }
    let child_scans: Vec<DirectoryScan> = subdirectories
        .par_iter()
        .map(|(rel, path)| scan_directory(path, rel, depth + 1, budget))
        .collect::<Result<Vec<_>, SourceError>>()?;
    for mut child in child_scans {
        entries.append(&mut child.entries);
        truncated |= child.truncated;
    }
    Ok(DirectoryScan { entries, truncated })
}

/// Maps one walked entry into a candidate, using its own (not followed) stat.
fn candidate_for(root: &Path, entry: &RawEntry) -> Result<Candidate, SourceError> {
    let path = root.join(&entry.rel);
    let kind = kind_of(entry.file_type);
    let metadata = fs::symlink_metadata(&path).map_err(|error| SourceError::Io(error.kind()))?;
    Ok(Candidate {
        rel: entry.rel.clone(),
        key: FileKey::new(metadata.dev(), metadata.ino()),
        kind,
        len: if kind == EntryKind::File {
            metadata.len()
        } else {
            0
        },
        modified_ns: modified_ns(&metadata),
    })
}

/// Classifies a file type without following links.
fn kind_of(file_type: fs::FileType) -> EntryKind {
    if file_type.is_file() {
        EntryKind::File
    } else if file_type.is_dir() {
        EntryKind::Dir
    } else if file_type.is_symlink() {
        EntryKind::Link
    } else {
        EntryKind::Other
    }
}

/// Modification time as nanoseconds since the Unix epoch.
fn modified_ns(metadata: &fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    match modified.duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_nanos()).ok(),
        Err(before) => i64::try_from(before.duration().as_nanos())
            .ok()
            .map(|nanos| -nanos),
    }
}

/// Wall-clock milliseconds since the Unix epoch.
fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

#[cfg(test)]
#[path = "walk_tests.rs"]
mod walk_tests;
