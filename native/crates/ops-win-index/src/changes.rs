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
//! - records whose parent path cannot be resolved are counted as skipped, never
//!   guessed, and a skipped record marks the set as not complete.

use crate::journal::JournalCursor;
use crate::mft::SubtreePaths;
use ops_index::usn::ops::{UsnOp, ops_for};
use ops_index::usn::record::ParsedUsnRecord;
use ops_index::{Candidate, Change, ChangeAction, EntryKind, FileKey, RecordId, SourceError};
use std::collections::HashMap;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
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

/// Applies journal records to a candidate map during cold catch-up.
///
/// The map is seeded from the cold snapshot and updated in journal order, so a
/// directory created after the cold scan can parent a later record in the same
/// replay. Returns the number of records whose parent could not be resolved.
pub(crate) fn apply_entries(
    seed: &SubtreePaths,
    candidates: &mut HashMap<FileKey, Candidate>,
    entries: &[UsnEntry],
    volume_serial: u64,
) -> Result<u64, SourceError> {
    let mut paths = seed.paths.clone();
    let skipped = 0u64;
    for entry in entries {
        let record = entry.fid.as_u64().ok_or(SourceError::Unsupported)?;
        let parsed = parsed_record(entry)?;
        for op in ops_for(&parsed).as_slice() {
            match op {
                UsnOp::Upsert { is_dir, .. } => {
                    let Some(rel) = child_path(&paths, entry) else {
                        // Unknown parent means the record is outside the
                        // requested root, which is ordinary volume activity,
                        // not an inconsistency inside the subtree.
                        continue;
                    };
                    paths.insert(record, rel.clone());
                    let key = FileKey::new(volume_serial, record);
                    candidates.insert(
                        key,
                        Candidate {
                            rel,
                            key,
                            kind: if *is_dir {
                                EntryKind::Dir
                            } else {
                                EntryKind::File
                            },
                            len: 0,
                            modified_ns: None,
                        },
                    );
                }
                UsnOp::Delete { .. } => {
                    paths.remove(&record);
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

/// Maps journal records to ops_index::Change rows.
///
/// Rows keep journal order and may repeat one file when the accumulated reason
/// mask carries several classes (for example create plus data change); the
/// caller applies them idempotently.
pub(crate) fn changes_for_entries(
    seed: &SubtreePaths,
    entries: &[UsnEntry],
    volume_serial: u64,
    cursor: JournalCursor,
) -> Result<ChangeReport, SourceError> {
    let mut paths = seed.paths.clone();
    let mut report = ChangeReport {
        cursor,
        ..ChangeReport::default()
    };
    for entry in entries {
        let record = entry.fid.as_u64().ok_or(SourceError::Unsupported)?;
        let key = FileKey::new(volume_serial, record);
        let parsed = parsed_record(entry)?;
        let mut upserted = false;
        for op in ops_for(&parsed).as_slice() {
            match op {
                UsnOp::Upsert { .. } => {
                    let Some(rel) = child_path(&paths, entry) else {
                        // Outside the requested root: ordinary volume activity.
                        continue;
                    };
                    upserted = true;
                    paths.insert(record, rel.clone());
                    let action = if entry.reason.is_file_create() {
                        ChangeAction::Added
                    } else if entry.reason.is_rename() {
                        ChangeAction::Renamed
                    } else {
                        ChangeAction::Modified
                    };
                    report.changes.push(Change { rel, key, action });
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
                    }
                }
                UsnOp::LinkDirty { .. } | UsnOp::StatDirty { .. } => {
                    // The upsert row already carries the current state; do not
                    // repeat it as Modified for the same record.
                    if upserted {
                        continue;
                    }
                    // Only records already inside the subtree matter here.
                    if let Some(rel) = paths.get(&record).cloned() {
                        report.changes.push(Change {
                            rel,
                            key,
                            action: ChangeAction::Modified,
                        });
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
