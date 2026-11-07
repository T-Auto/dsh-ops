// Design informed by mustafaahci/goz (MIT).

//! Rescan policy: when the incremental half has to be thrown away.
//!
//! FSEvents is a journal with a finite buffer. When the kernel or the user
//! drops events, when event ids wrap, when the watched root changes, or when a
//! subtree must be scanned, the stream says so on an event. Applying such a
//! batch would produce an index that *looks* complete while silently missing
//! changes, which is the one failure mode #584's consistency rule forbids:
//! only a provably caught-up snapshot may be queried, and stale results are
//! never presented as complete.
//!
//! [`recovery`] turns one drained [`Batch`] plus the id the stream was opened
//! with into one of three honest answers:
//!
//! - [`Recovery::CaughtUp`]: nothing invalidated the batch, and either the
//!   stream was live from now or the historical replay reached its end.
//! - [`Recovery::ReplayIncomplete`]: the batch is clean but the replay has not
//!   finished yet, so the caller must keep draining instead of claiming a
//!   caught-up snapshot.
//! - [`Recovery::Rescan`]: at least one flag invalidated the batch; discard the
//!   snapshot and rebuild it from a cold enumeration. The arriving events are
//!   deliberately not applied: a partial replay masquerading as complete is
//!   exactly what this module exists to prevent.
//!
//! ## Time Machine
//!
//! Local snapshots and backup volumes duplicate the live tree. Indexing them
//! would double every name and make the index follow Time Machine's own churn,
//! so they are excluded by mount marker: the local-snapshot mount point, the
//! `.timemachine` link directory, the pre-APFS `.MobileBackups` root and the
//! `Backups.backupdb` store. Detection is path-based on purpose: asking the
//! kernel for mount flags would need `statfs`, i.e. exactly the `unsafe` FFI
//! this slice must not add. A volume mounted outside those documented markers
//! is a known gap for the integration slice, not something this predicate
//! guesses at.

use crate::fsevents::{Batch, Event, EventFlags, EventId};
use std::ffi::OsStr;
use std::fmt;
use std::path::{Component, Path, PathBuf};

/// Why an incremental batch cannot be trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RescanReason {
    /// The kernel could not report changes below a path; the subtree must be
    /// re-walked.
    MustScanSubDirs,
    /// Events were dropped in user space (the callback fell behind).
    UserDropped,
    /// Events were dropped in the kernel.
    KernelDropped,
    /// Event ids wrapped; a persisted id from before the wrap is meaningless.
    EventIdsWrapped,
    /// The watched root itself changed.
    RootChanged,
    /// A volume was mounted below the root.
    Mount,
    /// A volume was unmounted below the root.
    Unmount,
}

impl RescanReason {
    /// Every reason that can be read from one event's flags, most severe first.
    pub const ALL: [Self; 7] = [
        Self::MustScanSubDirs,
        Self::UserDropped,
        Self::KernelDropped,
        Self::EventIdsWrapped,
        Self::RootChanged,
        Self::Mount,
        Self::Unmount,
    ];

    /// The strongest invalidating reason carried by `flags`, if any.
    pub const fn from_flags(flags: EventFlags) -> Option<Self> {
        if flags.intersects(EventFlags::MUST_SCAN_SUBDIRS) {
            return Some(Self::MustScanSubDirs);
        }
        if flags.intersects(EventFlags::USER_DROPPED) {
            return Some(Self::UserDropped);
        }
        if flags.intersects(EventFlags::KERNEL_DROPPED) {
            return Some(Self::KernelDropped);
        }
        if flags.intersects(EventFlags::EVENT_IDS_WRAPPED) {
            return Some(Self::EventIdsWrapped);
        }
        if flags.intersects(EventFlags::ROOT_CHANGED) {
            return Some(Self::RootChanged);
        }
        if flags.intersects(EventFlags::MOUNT) {
            return Some(Self::Mount);
        }
        if flags.intersects(EventFlags::UNMOUNT) {
            return Some(Self::Unmount);
        }
        None
    }

    /// Stable, machine-readable name for diagnostics and tests.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MustScanSubDirs => "must-scan-subdirs",
            Self::UserDropped => "user-dropped",
            Self::KernelDropped => "kernel-dropped",
            Self::EventIdsWrapped => "event-ids-wrapped",
            Self::RootChanged => "root-changed",
            Self::Mount => "mount",
            Self::Unmount => "unmount",
        }
    }

    /// Whether the kernel admits it lost events (as opposed to a tree change).
    pub const fn means_lost_events(self) -> bool {
        matches!(
            self,
            Self::MustScanSubDirs | Self::UserDropped | Self::KernelDropped
        )
    }
}

impl fmt::Display for RescanReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a caller may conclude from one drained batch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recovery {
    /// The batch is complete as of `latest`; persist that id.
    CaughtUp {
        /// Highest id covered by this answer.
        latest: EventId,
    },
    /// The batch is clean but the historical replay is not done; keep draining.
    ReplayIncomplete {
        /// Highest id seen so far.
        latest: EventId,
    },
    /// The batch cannot be trusted; discard the snapshot and rebuild cold.
    Rescan {
        /// Why the batch was rejected.
        reason: RescanReason,
        /// Highest id seen; kept for diagnostics, never trusted as a cursor.
        latest: EventId,
    },
}

impl Recovery {
    /// The highest event id this answer covers.
    pub const fn latest(self) -> EventId {
        match self {
            Self::CaughtUp { latest }
            | Self::ReplayIncomplete { latest }
            | Self::Rescan { latest, .. } => latest,
        }
    }

    /// Whether the caller may mark its snapshot caught up.
    pub const fn is_caught_up(self) -> bool {
        matches!(self, Self::CaughtUp { .. })
    }

    /// The reason a rebuild is required, if any.
    pub const fn rescan_reason(self) -> Option<RescanReason> {
        match self {
            Self::Rescan { reason, .. } => Some(reason),
            Self::CaughtUp { .. } | Self::ReplayIncomplete { .. } => None,
        }
    }
}

/// The first invalidating reason carried by `events`, in delivery order.
///
/// A batch is rejected as a whole, so finding one is enough; the first one is
/// reported because it is the one closest to the last trustworthy point.
pub fn invalidating_reason(events: &[Event]) -> Option<RescanReason> {
    events
        .iter()
        .find_map(|event| RescanReason::from_flags(event.flags))
}

/// Turns one drained batch into the only three answers a source may give.
///
/// `since` is the id the stream was opened with. [`EventId::SINCE_NOW`] means
/// there was no historical replay to finish, so a clean live batch is caught up
/// without a `HistoryDone` sentinel; a persisted id requires that sentinel
/// before the snapshot may be called caught up.
pub fn recovery(batch: &Batch, since: EventId) -> Recovery {
    let latest = batch.latest;
    if let Some(reason) = invalidating_reason(&batch.events) {
        return Recovery::Rescan { reason, latest };
    }
    if batch.event_ids_wrapped {
        // The batch carries the fact but the flagged event was not retained
        // (for example a future kernel reporting it only in the aggregate).
        return Recovery::Rescan {
            reason: RescanReason::EventIdsWrapped,
            latest,
        };
    }
    if batch.dropped {
        // `Batch::dropped` is derived from the same flags, so reaching this
        // point means the batch claims losses without a flagged event. Treat it
        // as a kernel drop rather than pretending the set is complete.
        return Recovery::Rescan {
            reason: RescanReason::KernelDropped,
            latest,
        };
    }
    if !since.is_since_now() && !batch.history_done {
        return Recovery::ReplayIncomplete { latest };
    }
    Recovery::CaughtUp { latest }
}

/// Name of the mount point Time Machine uses for local APFS snapshots.
pub const TIME_MACHINE_SNAPSHOT_MOUNT: &str = "com.apple.TimeMachine.localsnapshots";

/// Directory through which Time Machine exposes its backup volumes.
pub const TIME_MACHINE_LINK_DIR: &str = ".timemachine";

/// Pre-APFS root for local snapshots.
pub const MOBILE_BACKUPS: &str = ".MobileBackups";

/// HFS+ Time Machine store directory inside a backup volume.
pub const BACKUP_STORE: &str = "Backups.backupdb";

/// Every path component that marks a Time Machine tree.
pub const TIME_MACHINE_MARKERS: [&str; 4] = [
    TIME_MACHINE_SNAPSHOT_MOUNT,
    TIME_MACHINE_LINK_DIR,
    MOBILE_BACKUPS,
    BACKUP_STORE,
];

/// Whether `path` lives under a Time Machine mount or store.
///
/// Path components are compared exactly, so `/Volumes/com.example.marker` is not
/// excluded while `/Volumes/com.apple.TimeMachine.localsnapshots/...` is.
/// Non-UTF-8 components cannot match a marker and are treated as ordinary.
pub fn is_time_machine_path(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => is_time_machine_marker(name),
        Component::Prefix(_) | Component::RootDir | Component::CurDir | Component::ParentDir => {
            false
        }
    })
}

fn is_time_machine_marker(name: &OsStr) -> bool {
    let Some(text) = name.to_str() else {
        return false;
    };
    TIME_MACHINE_MARKERS.contains(&text)
}

/// Splits `roots` into the ones that may be watched and the Time Machine ones.
///
/// The source must never open a stream over a Time Machine tree, and the
/// coalescer drops events below one anyway; this is the same policy applied to
/// the input before the stream exists.
pub fn split_time_machine_roots(roots: &[PathBuf]) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut watchable = Vec::with_capacity(roots.len());
    let mut excluded = Vec::new();
    for root in roots {
        if is_time_machine_path(root) {
            excluded.push(root.clone());
        } else {
            watchable.push(root.clone());
        }
    }
    (watchable, excluded)
}

#[cfg(test)]
#[path = "rescan_tests.rs"]
mod rescan_tests;
