// Design informed by mustafaahci/goz (MIT).
//! Turns USN journal records into index changes and into a caught-up candidate
//! set.
//!
//! A journal record carries a file id, a parent file id, a name and accumulated
//! reason bits; it carries no path, no size and no modification time. The path
//! is reconstructed against the MFT tree of the same call (the parent chain is
//! already in memory), which is also why the caller must supply the tree seed
//! rather than re-open files per record.
//!
//! Reason-to-operation normalization is ops-index's job (ops_for): this module
//! only maps those idempotent operations onto ops_index::Change rows and onto
//! the candidate set. Following that contract:
//!
//! - records are applied in journal order (ascending USN);
//! - application is idempotent, so replaying a range that the cold snapshot
//!   already contains converges to the same set;
//! - RENAME_OLD_NAME alone is telemetry and never becomes a row (the NEW record
//!   is authoritative);
//! - HARD_LINK_CHANGE becomes a Modified row for the current name; the full link
//!   set is W4's reconciliation, this slice must not invent links;
//! - a directory upsert moves its whole subtree, not just the directory row.
//!   NTFS does not emit a rename record for every existing child, so a known
//!   directory rename rewrites every known descendant path, a directory moved
//!   into the root is expanded through the whole-volume parent graph, and a
//!   directory moved out of the root drops its known subtree. Without those
//!   three cases the candidate set would look complete while still containing
//!   stale child paths;
//! - records whose parent path cannot be resolved are never guessed. A parent
//!   that exists elsewhere in the volume is ordinary activity outside the
//!   requested root and is ignored; a parent missing from the whole-volume MFT
//!   map is a dangling reference and is counted as skipped, which marks the
//!   candidate set as not complete.

use crate::journal::JournalCursor;
use crate::mft::{MftNode, SubtreePaths};
use ops_index::usn::ops::{UsnOp, ops_for};
use ops_index::usn::record::ParsedUsnRecord;
use ops_index::{Candidate, Change, ChangeAction, EntryKind, FileKey, RecordId, SourceError};
use std::collections::{HashMap, HashSet};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use usn_journal_rs::journal::UsnEntry;

/// Journal records mapped into a change list, with an honest skip count and
/// the cursor a caller may persist after applying them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChangeReport {
    /// Changes in journal order.
    pub changes: Vec<Change>,
    /// Records that named a parent outside the known tree and were not guessed.
    pub skipped: u64,
    /// Cursor after the last replayed record.
    pub cursor: JournalCursor,
}

/// Converts one journal entry into the pure record ops-index normalizes.
///
/// The synthetic major_version is 2: only is_dir and the reason bits are read
/// from this value, and both come from the journal entry directly.
pub(crate) fn parsed_record(entry: &UsnEntry) -> Result<ParsedUsnRecord, SourceError> {
    let record = entry.fid.as_u64().ok_or(SourceError::Unsupported)?;
    let parent = entry.parent_fid.as_u64().ok_or(SourceError::Unsupported)?;
    let mut name = Vec::new();
    let units: Vec<u16> = entry.file_name.encode_wide().collect();
    let name_lossy = ops_index::wtf8::from_utf16(&units, &mut name);
    Ok(ParsedUsnRecord {
        major_version: 2,
        record: RecordId::new(record),
        parent: RecordId::new(parent),
        usn: entry.usn.get(),
        timestamp_ft: i64::try_from(entry.time.raw()).unwrap_or(i64::MAX),
        reason: entry.reason.bits(),
        attributes: entry.file_attributes.bits(),
        name,
        name_lossy,
    })
}

/// Relative path a record's current parent and name describe, if known.
fn child_path(paths: &HashMap<u64, PathBuf>, entry: &UsnEntry) -> Option<PathBuf> {
    let parent = entry.parent_fid.as_u64()?;
    let base = paths.get(&parent)?;
    Some(base.join(&entry.file_name))
}

/// Whole-volume parent graph: directory id to its direct children.
fn children_index(nodes: &[MftNode]) -> HashMap<u64, Vec<usize>> {
    let mut children: HashMap<u64, Vec<usize>> = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        if let Some(parent) = node.parent.as_u64() {
            children.entry(parent).or_default().push(index);
        }
    }
    children
}

/// Path of one MFT node's name joined to its parent directory path.
fn node_relative(
    nodes: &[MftNode],
    index: usize,
    parent_path: &Path,
) -> Option<(u64, PathBuf, bool)> {
    let node = &nodes[index];
    let fid = node.fid.as_u64()?;
    let rel = parent_path.join(&node.name);
    Some((fid, rel, node.attributes.is_directory()))
}

/// Visits every descendant of start in the MFT snapshot, depth first.
///
/// The visited set guards a damaged parent graph; the walk is bounded by the
/// node slice and never opens a handle.
fn walk_descendants<F>(
    start: u64,
    base: &Path,
    nodes: &[MftNode],
    children: &HashMap<u64, Vec<usize>>,
    visit: &mut F,
) where
    F: FnMut(u64, PathBuf, bool),
{
    let mut visited: HashSet<u64> = HashSet::new();
    let mut stack = vec![(start, base.to_path_buf())];
    while let Some((fid, dir_path)) = stack.pop() {
        let Some(indexes) = children.get(&fid) else {
            continue;
        };
        for index in indexes {
            let Some((child, rel, is_dir)) = node_relative(nodes, *index, &dir_path) else {
                continue;
            };
            if !visited.insert(child) {
                continue;
            }
            visit(child, rel.clone(), is_dir);
            if is_dir {
                stack.push((child, rel));
            }
        }
    }
}

/// Replaces the old prefix on every known path below a directory.
fn relocate_paths(paths: &mut HashMap<u64, PathBuf>, old: &Path, new: &Path) {
    for rel in paths.values_mut() {
        if let Ok(rest) = rel.strip_prefix(old) {
            *rel = if rest.as_os_str().is_empty() {
                new.to_path_buf()
            } else {
                new.join(rest)
            };
        }
    }
}

/// Removes every known path below a directory, returning the affected ids.
fn remove_paths_subtree(paths: &mut HashMap<u64, PathBuf>, root: &Path) -> Vec<u64> {
    let mut removed = Vec::new();
    paths.retain(|fid, rel| {
        if rel.strip_prefix(root).is_ok() {
            removed.push(*fid);
            false
        } else {
            true
        }
    });
    removed
}

fn rel_is_under(rel: &Path, root: &Path) -> bool {
    rel.strip_prefix(root).is_ok()
}

/// Applies journal records to a candidate map during cold catch-up.
///
/// The map is seeded from the cold snapshot and updated in journal order, so a
/// directory created after the cold scan can parent a later record in the same
/// replay. Returns the number of records whose parent could not be resolved.
pub(crate) fn apply_entries(
    seed: &SubtreePaths<'_>,
    candidates: &mut HashMap<FileKey, Candidate>,
    entries: &[UsnEntry],
    volume_serial: u64,
) -> Result<u64, SourceError> {
    let mut paths = seed.paths.clone();
    let mut skipped = 0u64;
    let mut children: Option<HashMap<u64, Vec<usize>>> = None;
    for entry in entries {
        let record = entry.fid.as_u64().ok_or(SourceError::Unsupported)?;
        let parent = entry.parent_fid.as_u64().ok_or(SourceError::Unsupported)?;
        let parsed = parsed_record(entry)?;
        let mut counted = false;
        for op in ops_for(&parsed).as_slice() {
            match op {
                UsnOp::Upsert { is_dir, .. } => {
                    let old_rel = paths.get(&record).cloned();
                    let new_rel = child_path(&paths, entry);
                    match (old_rel, new_rel) {
                        (Some(old), Some(new)) => {
                            relocate_paths(&mut paths, &old, &new);
                            for candidate in candidates.values_mut() {
                                if let Ok(rest) = candidate.rel.strip_prefix(&old) {
                                    candidate.rel = if rest.as_os_str().is_empty() {
                                        new.clone()
                                    } else {
                                        new.join(rest)
                                    };
                                }
                            }
                            paths.insert(record, new.clone());
                            insert_candidate(
                                candidates,
                                record,
                                new.clone(),
                                *is_dir,
                                volume_serial,
                            );
                            if *is_dir && old != new {
                                expand_known_children(
                                    seed,
                                    &mut paths,
                                    candidates,
                                    &mut children,
                                    record,
                                    &new,
                                    volume_serial,
                                );
                            }
                        }
                        (Some(old), None) => {
                            if seed.known.contains(&parent) {
                                // Moved out of the requested root: the whole
                                // known subtree leaves with it.
                                paths.remove(&record);
                                let removed = remove_paths_subtree(&mut paths, &old);
                                candidates.remove(&FileKey::new(volume_serial, record));
                                for child in removed {
                                    candidates.remove(&FileKey::new(volume_serial, child));
                                }
                            } else if !counted {
                                skipped = skipped.saturating_add(1);
                                counted = true;
                            }
                        }
                        (None, Some(new)) => {
                            paths.insert(record, new.clone());
                            insert_candidate(
                                candidates,
                                record,
                                new.clone(),
                                *is_dir,
                                volume_serial,
                            );
                            if *is_dir {
                                // A directory moved into the root brings the
                                // descendants the cold snapshot already knows.
                                expand_known_children(
                                    seed,
                                    &mut paths,
                                    candidates,
                                    &mut children,
                                    record,
                                    &new,
                                    volume_serial,
                                );
                            }
                        }
                        (None, None) => {
                            if !counted && !seed.known.contains(&parent) {
                                // The parent is not anywhere in this volume's
                                // MFT, so the path cannot be reconstructed:
                                // never guess it, and count the record once.
                                skipped = skipped.saturating_add(1);
                                counted = true;
                            }
                        }
                    }
                }
                UsnOp::Delete { .. } => {
                    if paths.remove(&record).is_none() && !counted && !seed.known.contains(&parent)
                    {
                        skipped = skipped.saturating_add(1);
                        counted = true;
                    }
                    candidates.remove(&FileKey::new(volume_serial, record));
                }
                UsnOp::LinkDirty { .. } | UsnOp::StatDirty { .. } | UsnOp::RenameOldSeen { .. } => {
                    // The candidate set has no size, mtime, or link set yet;
                    // W4 reconciles links and enrichment fills the rest.
                }
            }
        }
    }
    Ok(skipped)
}

fn insert_candidate(
    candidates: &mut HashMap<FileKey, Candidate>,
    record: u64,
    rel: PathBuf,
    is_dir: bool,
    volume_serial: u64,
) {
    let key = FileKey::new(volume_serial, record);
    candidates.insert(
        key,
        Candidate {
            rel,
            key,
            kind: if is_dir {
                EntryKind::Dir
            } else {
                EntryKind::File
            },
            len: 0,
            modified_ns: None,
        },
    );
}

/// Adds the MFT-known descendants of a directory to paths and candidates.
fn expand_known_children(
    seed: &SubtreePaths<'_>,
    paths: &mut HashMap<u64, PathBuf>,
    candidates: &mut HashMap<FileKey, Candidate>,
    children: &mut Option<HashMap<u64, Vec<usize>>>,
    record: u64,
    base: &Path,
    volume_serial: u64,
) {
    let index = children.get_or_insert_with(|| children_index(seed.nodes));
    walk_descendants(
        record,
        base,
        seed.nodes,
        index,
        &mut |child, rel, is_dir| {
            paths.insert(child, rel.clone());
            insert_candidate(candidates, child, rel, is_dir, volume_serial);
        },
    );
}

/// Maps journal records to ops_index::Change rows.
///
/// Rows keep journal order and may repeat one file when the accumulated reason
/// mask carries several classes (for example create plus data change); the
/// caller applies them idempotently. Directory moves emit rows for every known
/// descendant so the caller's index converges instead of keeping stale paths.
pub(crate) fn changes_for_entries(
    seed: &SubtreePaths<'_>,
    entries: &[UsnEntry],
    volume_serial: u64,
    cursor: JournalCursor,
) -> Result<ChangeReport, SourceError> {
    let mut paths = seed.paths.clone();
    let mut children: Option<HashMap<u64, Vec<usize>>> = None;
    let mut report = ChangeReport {
        cursor,
        ..ChangeReport::default()
    };
    for entry in entries {
        let record = entry.fid.as_u64().ok_or(SourceError::Unsupported)?;
        let key = FileKey::new(volume_serial, record);
        let parent = entry.parent_fid.as_u64().ok_or(SourceError::Unsupported)?;
        let parsed = parsed_record(entry)?;
        let mut counted = false;
        for op in ops_for(&parsed).as_slice() {
            match op {
                UsnOp::Upsert { .. } => {
                    let old_rel = paths.get(&record).cloned();
                    let new_rel = child_path(&paths, entry);
                    match (old_rel, new_rel) {
                        (Some(old), Some(new)) => {
                            let action = if entry.reason.is_rename() {
                                ChangeAction::Renamed
                            } else {
                                ChangeAction::Modified
                            };
                            relocate_paths(&mut paths, &old, &new);
                            paths.insert(record, new.clone());
                            report.changes.push(Change {
                                rel: new.clone(),
                                key,
                                action,
                            });
                            if old != new {
                                let affected: Vec<(u64, PathBuf)> = paths
                                    .iter()
                                    .filter(|(fid, rel)| **fid != record && rel_is_under(rel, &new))
                                    .map(|(fid, rel)| (*fid, rel.clone()))
                                    .collect();
                                for (child, rel) in affected {
                                    report.changes.push(Change {
                                        rel,
                                        key: FileKey::new(volume_serial, child),
                                        action: ChangeAction::Renamed,
                                    });
                                }
                            }
                        }
                        (Some(old), None) => {
                            if seed.known.contains(&parent) {
                                let mut removed: Vec<(u64, PathBuf)> = paths
                                    .iter()
                                    .filter(|(fid, rel)| **fid != record && rel_is_under(rel, &old))
                                    .map(|(fid, rel)| (*fid, rel.clone()))
                                    .collect();
                                removed.sort_by(|left, right| left.1.cmp(&right.1));
                                paths.remove(&record);
                                paths.retain(|fid, rel| *fid == record || !rel_is_under(rel, &old));
                                report.changes.push(Change {
                                    rel: old.clone(),
                                    key,
                                    action: ChangeAction::Removed,
                                });
                                for (child, rel) in removed {
                                    report.changes.push(Change {
                                        rel,
                                        key: FileKey::new(volume_serial, child),
                                        action: ChangeAction::Removed,
                                    });
                                }
                            } else if !counted {
                                report.skipped = report.skipped.saturating_add(1);
                                counted = true;
                            }
                        }
                        (None, Some(new)) => {
                            let action = if entry.reason.is_rename() {
                                // The identity moved to a new visible path; its
                                // descendants are Added rows below.
                                ChangeAction::Renamed
                            } else if entry.reason.is_file_create() {
                                ChangeAction::Added
                            } else {
                                ChangeAction::Modified
                            };
                            paths.insert(record, new.clone());
                            report.changes.push(Change {
                                rel: new.clone(),
                                key,
                                action,
                            });
                            let index = children.get_or_insert_with(|| children_index(seed.nodes));
                            let mut descendants = Vec::new();
                            walk_descendants(
                                record,
                                &new,
                                seed.nodes,
                                index,
                                &mut |child, rel, _is_dir| {
                                    descendants.push((child, rel));
                                },
                            );

                            for (child, rel) in descendants {
                                paths.insert(child, rel.clone());
                                report.changes.push(Change {
                                    rel,
                                    key: FileKey::new(volume_serial, child),
                                    action: ChangeAction::Added,
                                });
                            }
                        }
                        (None, None) => {
                            if !counted && !seed.known.contains(&parent) {
                                report.skipped = report.skipped.saturating_add(1);
                                counted = true;
                            }
                        }
                    }
                }
                UsnOp::Delete { .. } => {
                    let known = paths.get(&record).cloned();
                    let rel = child_path(&paths, entry).or(known);
                    paths.remove(&record);
                    if let Some(rel) = rel {
                        report.changes.push(Change {
                            rel,
                            key,
                            action: ChangeAction::Removed,
                        });
                    } else if !counted && !seed.known.contains(&parent) {
                        report.skipped = report.skipped.saturating_add(1);
                        counted = true;
                    }
                }
                UsnOp::LinkDirty { .. } | UsnOp::StatDirty { .. } => {
                    // Only records already inside the subtree matter here.
                    if let Some(rel) = paths.get(&record).cloned() {
                        report.changes.push(Change {
                            rel,
                            key,
                            action: ChangeAction::Modified,
                        });
                    } else if !counted && !seed.known.contains(&parent) {
                        report.skipped = report.skipped.saturating_add(1);
                        counted = true;
                    }
                }
                UsnOp::RenameOldSeen { .. } => {
                    // Telemetry only: the NEW record is authoritative.
                }
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
#[path = "changes_tests.rs"]
mod changes_tests;
