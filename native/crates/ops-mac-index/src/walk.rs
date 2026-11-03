// Design informed by mustafaahci/goz (MIT).

//! Cold, bounded enumeration of one root with `walkdir`, fanned out by
//! `rayon`.
//!
//! ## Why two phases
//!
//! Reading directories is cheap next to reading each entry's metadata: #423
//! measured `symlink_metadata` at 71–87 % of an `ops_glob` walk. So the cold
//! path is split where the cost is:
//!
//! 1. `walkdir` visits the tree serially and yields at most
//!    [`EnumBudget::max_entries`] entries. No threads are needed for
//!    `readdir`.
//! 2. The collected entries become [`Candidate`] values in a `rayon` parallel
//!    map. Each one costs a `stat` for size, modification time and
//!    `(dev, ino)`, which is exactly the part that parallelises.
//!
//! Collecting first also bounds memory by the budget instead of by the tree:
//! the walk stops pulling entries once `max_entries` is reached.
//!
//! Rayon's indexed collect preserves iteration order, so the result keeps walk
//! order. Callers must still not rely on it: [`CandidateSet`] documents that
//! order belongs to the source, and deterministic callers sort by path bytes.
//!
//! ## Budget rules
//!
//! - `max_entries`: stop after that many entries and report
//!   [`CandidateSet::truncated`].
//! - `max_depth`: do not visit entries deeper than that many path components.
//!   A directory sitting exactly at the limit may hide children, so
//!   `truncated` is set as well. `max_depth == 0` fits no entry at all (the root
//!   itself is depth 0) and is likewise reported as truncated.
//! - `deadline`: checked before the walk, every [`DEADLINE_CHECK_EVERY`] walked
//!   entries, and every [`DEADLINE_CHECK_EVERY`] mapped entries. An expired
//!   deadline returns [`SourceError::Budget`] instead of a partial set: the
//!   caller discards the index result and falls back to its own traversal
//!   either way, and a partial set would only be a second full walk.
//!
//! ## What an entry means
//!
//! - `rel` is the path relative to the root, with the root itself never
//!   listed (depth 0 is the root).
//! - `key` is `(st_dev, st_ino)`: stable across renames and hard links, which
//!   is what the index needs to apply a rename as a move instead of a
//!   delete/add pair.
//! - `kind` comes from the entry's own `lstat`, without following links.
//!   Symlinks are reported as [`EntryKind::Link`] and never descended into.
//! - `len` is the size for regular files and `0` for everything else, so a
//!   directory's block count can never be mistaken for a file size.
//! - `modified_ns` is whole nanoseconds since the Unix epoch, negative before
//!   it, and `None` when the platform cannot report a modification time.

use ops_index::{Candidate, CandidateSet, EntryKind, EnumBudget, FileKey, SourceError};
use rayon::prelude::*;
use std::fs;
use std::io::ErrorKind;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::{DirEntry, WalkDir};

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
/// The root itself is followed when it is a symlink (both `walkdir` and
/// [`fs::metadata`] here stat the root by path), while every descendant symlink
/// is reported as [`EntryKind::Link`] and never descended into. That is an
/// invariant of this source, not an accident of `walkdir`'s defaults:
/// "the root is followed, descendants never are."
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
    let (entries, truncated) = collect_entries(root, budget)?;
    let candidates = entries
        .par_iter()
        .enumerate()
        .map(|(index, entry)| {
            if index.is_multiple_of(DEADLINE_CHECK_EVERY) && budget.expired() {
                return Err(SourceError::Budget);
            }
            candidate_for(root, entry)
        })
        .collect::<Result<Vec<_>, SourceError>>()?;
    Ok(CandidateSet {
        entries: candidates,
        truncated,
        consistent_at_ms,
    })
}

/// Serial phase: collect at most `max_entries` entries in walk order.
fn collect_entries(root: &Path, budget: EnumBudget) -> Result<(Vec<DirEntry>, bool), SourceError> {
    // `walkdir` clamps `max_depth` up to `min_depth`; with `min_depth(1)` a
    // budget of 0 would silently become 1 and list the root's children. Zero
    // means "no entry fits the budget", so stop before building the walker.
    if budget.max_depth == 0 {
        return Ok((Vec::new(), true));
    }
    let walker = WalkDir::new(root)
        .follow_links(false)
        .min_depth(1)
        .max_depth(budget.max_depth)
        .into_iter();
    let mut entries = Vec::new();
    // A directory sitting exactly at the depth limit may hide children.
    let mut truncated = false;
    let mut walked = 0usize;
    for next in walker {
        walked += 1;
        if walked.is_multiple_of(DEADLINE_CHECK_EVERY) && budget.expired() {
            return Err(SourceError::Budget);
        }
        let entry = next.map_err(|error| walk_error(&error))?;
        if entries.len() >= budget.max_entries {
            truncated = true;
            break;
        }
        if entry.depth() == budget.max_depth && entry.file_type().is_dir() {
            truncated = true;
        }
        entries.push(entry);
    }
    Ok((entries, truncated))
}

/// Maps one walked entry into a candidate, using its own (not followed) stat.
fn candidate_for(root: &Path, entry: &DirEntry) -> Result<Candidate, SourceError> {
    let rel = entry
        .path()
        .strip_prefix(root)
        .map_err(|_| SourceError::Io(ErrorKind::InvalidInput))?
        .to_path_buf();
    let kind = kind_of(entry.file_type());
    let metadata = entry.metadata().map_err(|error| walk_error(&error))?;
    Ok(Candidate {
        rel,
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

/// Maps a `walkdir` failure onto the source error vocabulary.
fn walk_error(error: &walkdir::Error) -> SourceError {
    match error.io_error() {
        Some(io) => SourceError::Io(io.kind()),
        // Not an I/O failure: a depth or loop guard. `follow_links(false)` and
        // a depth limit mean the cold path should not produce these, but they
        // must not be reported as a complete set.
        None => SourceError::Io(ErrorKind::Other),
    }
}

#[cfg(test)]
#[path = "walk_tests.rs"]
mod walk_tests;
