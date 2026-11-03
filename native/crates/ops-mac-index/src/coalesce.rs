// Design informed by mustafaahci/goz (MIT).

//! Coalescing of FSEvents into the net changes an index applies.
//!
//! The kernel delivers one event per file-system operation, and a single batch
//! routinely contains several events for the same path (create, write, chmod,
//! rename target). Applying them one by one would be correct but pointless:
//! the index only needs the state at the end of the batch, and every extra
//! apply is work that can be merged away. This module reduces the batch per
//! path, keeping the highest event id per reduced change so a caller can still
//! persist a cursor.
//!
//! ## Net effect, not history
//!
//! The machine tracks what the batch says about one path relative to the
//! caller's snapshot, which the batch does not describe. Every decision is
//! therefore chosen so that applying it is idempotent:
//!
//! - only create/modify events → `Added` (an upsert in an idempotent table);
//! - only remove events → `Removed` (a no-op when the path was never known);
//! - remove then create → `Modified` (the old entry was replaced);
//! - create then remove → `Removed` (the end state is absent, and removing an
//!   unknown path is safe);
//! - a rename that can be attributed → `Renamed` on the **new** path, carrying
//!   the file id, so the table can move the existing entry instead of dropping
//!   and re-adding it.
//!
//! ## Renames
//!
//! FSEvents reports a rename as two events sharing one event id: the old and
//! the new name, both flagged `ItemRenamed`. Which is which is not part of the
//! flag, so this module decides with an existence probe (the caller may inject
//! one, tests always do): the path that no longer exists is the old one. When
//! the probe cannot distinguish the two, the events are treated honestly as
//! "this name changed": the existing name becomes `Modified`, the vanished one
//! `Removed`, and the caller's re-verification does the rest. A rename without
//! a file id cannot be expressed as an identity-preserving move, so it takes
//! the same honest fallback.
//!
//! ## What is not coalesced here
//!
//! Events that invalidate the whole snapshot (`MustScanSubDirs`, dropped
//! events, wrapped ids, root changes, mounts) and the history-done sentinel are
//! skipped: [`crate::rescan`] owns that decision, and coalescing a partial
//! replay would be the exact lie M3 exists to prevent. Events under a Time
//! Machine mount are dropped and counted, never indexed.

use crate::fsevents::{Event, EventFlags, EventId, relative_path};
use crate::rescan::is_time_machine_path;
use ops_index::ChangeAction;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One net change for one path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoalescedChange {
    /// Path relative to the root it belongs to.
    pub rel: PathBuf,
    /// Net action the index has to apply.
    pub action: ChangeAction,
    /// File id when the event carried one (always present for `Renamed`).
    pub file_id: Option<u64>,
    /// Highest event id merged into this change.
    pub id: EventId,
}

/// Result of coalescing one batch.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CoalescedBatch {
    /// Net changes, ordered by event id and then path.
    pub changes: Vec<CoalescedChange>,
    /// Highest event id in the input; `None` when the batch carried no events.
    pub latest: Option<EventId>,
    /// Events outside every root, which this index does not describe.
    pub ignored: usize,
    /// Events under a Time Machine mount, deliberately not indexed.
    pub excluded: usize,
}

impl CoalescedBatch {
    /// Whether the batch produced no net change.
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

/// Coalesces `events` for `roots`, probing the file system for rename
/// direction.
///
/// The probe is [`Path::exists`]. Tests and callers that already hold a
/// directory handle use [`coalesce_with`] instead.
pub fn coalesce(events: &[Event], roots: &[PathBuf]) -> CoalescedBatch {
    coalesce_with(events, roots, Path::exists)
}

/// Coalesces `events`, using `exists` to tell a rename's old name from its new
/// one.
pub fn coalesce_with<F>(events: &[Event], roots: &[PathBuf], exists: F) -> CoalescedBatch
where
    F: Fn(&Path) -> bool,
{
    let mut result = CoalescedBatch::default();
    for event in events {
        result.latest = Some(match result.latest {
            Some(current) => current.max(event.id),
            None => event.id,
        });
    }

    // Rename events grouped by event id: a rename is two events at one id.
    let mut renames: BTreeMap<EventId, Vec<&Event>> = BTreeMap::new();
    for event in events {
        if kind_of(event.flags) == Some(Kind::Renamed) {
            renames.entry(event.id).or_default().push(event);
        }
    }
    let mut directions: BTreeMap<EventId, RenameDirection> = BTreeMap::new();
    for (id, pair) in &renames {
        if let Some(direction) = rename_pair(pair, roots, &exists) {
            directions.insert(*id, direction);
        }
    }

    let mut pending: BTreeMap<PathBuf, Pending> = BTreeMap::new();
    for event in events {
        let Some(kind) = kind_of(event.flags) else {
            continue;
        };
        let Some(rel) = relative_path(roots, &event.path) else {
            result.ignored += 1;
            continue;
        };
        if is_time_machine_path(&event.path) {
            result.excluded += 1;
            continue;
        }
        if let Some(direction) = directions.get(&event.id) {
            if event.path == direction.old {
                // The old name: the paired `Renamed` change on the new name
                // already describes this move. Any later event for this path
                // overrides the suppression.
                pending.entry(rel).or_default().suppressed = true;
                continue;
            }
            if event.path == direction.new {
                pending
                    .entry(rel)
                    .or_default()
                    .rename_in(event, Some(direction.file_id));
                continue;
            }
        }
        match kind {
            Kind::Created => pending.entry(rel).or_default().create(event),
            Kind::Removed => pending.entry(rel).or_default().remove(event),
            Kind::Modified => pending.entry(rel).or_default().modify(event),
            Kind::Renamed => {
                // An unpaired rename: the path either still exists (this is the
                // new name) or is gone (this was the old name).
                if exists(&event.path) {
                    pending.entry(rel).or_default().modify(event);
                } else {
                    pending.entry(rel).or_default().remove(event);
                }
            }
        }
    }

    let mut changes = Vec::with_capacity(pending.len());
    for (rel, state) in pending {
        let Some(action) = state.action() else {
            continue;
        };
        changes.push(CoalescedChange {
            rel,
            action,
            file_id: state.file_id,
            id: state.last_id,
        });
    }
    changes.sort_by(|left, right| {
        left.id
            .cmp(&right.id)
            .then_with(|| left.rel.cmp(&right.rel))
    });
    result.changes = changes;
    result
}

/// What one event says about its path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Created,
    Removed,
    Modified,
    Renamed,
}

fn kind_of(flags: EventFlags) -> Option<Kind> {
    if flags.is_history_done() || invalidates_snapshot(flags) {
        return None;
    }
    if flags.contains(EventFlags::ITEM_CREATED) {
        return Some(Kind::Created);
    }
    if flags.contains(EventFlags::ITEM_REMOVED) {
        return Some(Kind::Removed);
    }
    if flags.contains(EventFlags::ITEM_RENAMED) {
        return Some(Kind::Renamed);
    }
    let metadata_change = flags.intersects(EventFlags::ITEM_MODIFIED)
        || flags.intersects(EventFlags::ITEM_INODE_META_MOD)
        || flags.intersects(EventFlags::ITEM_FINDER_INFO_MOD)
        || flags.intersects(EventFlags::ITEM_CHANGE_OWNER)
        || flags.intersects(EventFlags::ITEM_XATTR_MOD);
    metadata_change.then_some(Kind::Modified)
}

/// Whether a flag makes the whole snapshot unusable; `rescan` decides it.
fn invalidates_snapshot(flags: EventFlags) -> bool {
    flags.intersects(EventFlags::MUST_SCAN_SUBDIRS)
        || flags.intersects(EventFlags::USER_DROPPED)
        || flags.intersects(EventFlags::KERNEL_DROPPED)
        || flags.intersects(EventFlags::EVENT_IDS_WRAPPED)
        || flags.intersects(EventFlags::ROOT_CHANGED)
        || flags.intersects(EventFlags::MOUNT)
        || flags.intersects(EventFlags::UNMOUNT)
}

/// One attributable rename: the old and new absolute names plus the identity
/// that ties them together.
struct RenameDirection {
    old: PathBuf,
    new: PathBuf,
    file_id: u64,
}

/// Decides which of two same-id rename events is the old and which the new
/// path.
fn rename_pair<F>(pair: &[&Event], roots: &[PathBuf], exists: &F) -> Option<RenameDirection>
where
    F: Fn(&Path) -> bool,
{
    if pair.len() != 2 {
        return None;
    }
    let (first, second) = (pair[0], pair[1]);
    if first.path == second.path {
        return None;
    }
    // Identity is what makes a move expressible; without it the caller can
    // only remove the old name and add the new one.
    let file_id = first.file_id.or(second.file_id)?;
    if let (Some(left), Some(right)) = (first.file_id, second.file_id)
        && left != right
    {
        return None;
    }
    // Both names have to belong to a watched root for the move to be applied
    // through the same index.
    relative_path(roots, &first.path)?;
    relative_path(roots, &second.path)?;
    match (exists(&first.path), exists(&second.path)) {
        (false, true) => Some(RenameDirection {
            old: first.path.clone(),
            new: second.path.clone(),
            file_id,
        }),
        (true, false) => Some(RenameDirection {
            old: second.path.clone(),
            new: first.path.clone(),
            file_id,
        }),
        // Both or neither exist: do not pretend to know the direction.
        _ => None,
    }
}

#[derive(Clone, Copy, Debug)]
enum State {
    /// Nothing said about the path yet.
    Unknown,
    /// Present at the end of the batch.
    Present { appeared: bool },
    /// Absent at the end of the batch.
    Absent,
}

/// Per-path reduction state.
struct Pending {
    state: State,
    file_id: Option<u64>,
    last_id: EventId,
    renamed: bool,
    /// Set for a rename's old name: the paired new-name change describes it, so
    /// no change of its own is emitted unless a later event touches the path.
    suppressed: bool,
}

impl Default for Pending {
    fn default() -> Self {
        Self {
            state: State::Unknown,
            file_id: None,
            last_id: EventId::from_raw(0),
            renamed: false,
            suppressed: false,
        }
    }
}

impl Pending {
    fn create(&mut self, event: &Event) {
        self.state = match self.state {
            State::Unknown => State::Present { appeared: true },
            State::Present { appeared } => State::Present { appeared },
            State::Absent => State::Present { appeared: false },
        };
        self.renamed = false;
        self.suppressed = false;
        self.file_id = event.file_id.or(self.file_id);
        self.last_id = event.id;
    }

    fn remove(&mut self, event: &Event) {
        self.state = State::Absent;
        self.renamed = false;
        self.suppressed = false;
        self.file_id = event.file_id.or(self.file_id);
        self.last_id = event.id;
    }

    fn modify(&mut self, event: &Event) {
        self.state = match self.state {
            State::Absent => State::Absent,
            State::Present { appeared } => State::Present { appeared },
            State::Unknown => State::Present { appeared: false },
        };
        self.suppressed = false;
        self.file_id = event.file_id.or(self.file_id);
        self.last_id = event.id;
    }

    fn rename_in(&mut self, event: &Event, file_id: Option<u64>) {
        self.state = State::Present { appeared: false };
        self.renamed = true;
        self.suppressed = false;
        self.file_id = file_id.or(event.file_id).or(self.file_id);
        self.last_id = event.id;
    }

    fn action(&self) -> Option<ChangeAction> {
        if self.suppressed {
            return None;
        }
        match self.state {
            State::Unknown => None,
            State::Absent => Some(ChangeAction::Removed),
            State::Present { appeared: true } => Some(ChangeAction::Added),
            State::Present { appeared: false } => {
                if self.renamed {
                    Some(ChangeAction::Renamed)
                } else {
                    Some(ChangeAction::Modified)
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "coalesce_tests.rs"]
mod coalesce_tests;
