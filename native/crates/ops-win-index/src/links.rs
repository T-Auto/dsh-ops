// Design informed by mustafaahci/goz (MIT).
//! Hard-link set enumeration for one file record.
//!
//! A USN HARD_LINK_CHANGE record names exactly one link and may name a DEAD
//! one, so the index can never learn a file's real link set from the journal
//! alone. This module asks the file system instead:
//! FindFirstFileNameW/FindNextFileNameW return every current name of the file
//! as volume-rooted UTF-16 paths.
//!
//! Integrity rule: an incomplete walk is never returned as an empty set. An
//! empty set applied to the index would delete a file that is still linked;
//! instead LinkOutcome::Incomplete says "skip this reconcile", the caller
//! counts it in LinkWalkStats::skipped and keeps the last known link set. The
//! same rule covers a mid-walk failure: the partial names are discarded rather
//! than applied, because a subset would drop real links.
//!
//! The names stay raw UTF-16 exactly as Win32 reported them. NTFS names can
//! contain unpaired surrogates, so decoding is left to the index's WTF-8 layer
//! rather than being lossily flattened here.
//!
//! The public API is safe. All Win32 calls live in crate::winfs::links, one of
//! the crate's two allowed unsafe islands (the other is crate::winfs::sys).

use std::collections::HashSet;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

/// Upper bound on names considered for one file.
///
/// NTFS documents at most 1024 hard links per file; this larger cap is a
/// pathology guard so a corrupt enumeration cannot spin forever. Reaching it
/// is reported as LinkFailureKind::TooManyLinks, never as a complete set.
pub const MAX_LINKS: usize = 4096;

/// One complete set of hard-link names for a file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkSet {
    names: Vec<Vec<u16>>,
}

impl LinkSet {
    pub(crate) fn new(names: Vec<Vec<u16>>) -> Self {
        Self { names }
    }

    /// Each name as a volume-rooted UTF-16 path, in the order Win32 reported it.
    pub fn names(&self) -> &[Vec<u16>] {
        &self.names
    }

    /// Number of hard links.
    pub fn len(&self) -> usize {
        self.names.len()
    }

    /// Whether the set is empty. A complete set is never empty in practice: an
    /// existing file always has at least one name.
    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}

/// Why a link walk could not be trusted as complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkFailureKind {
    /// The file is gone (deleted or renamed between the journal record and this
    /// reconcile). Nothing to reconcile; a delete will arrive separately.
    FileGone,
    /// The caller cannot open or read the anchor's attributes.
    AccessDenied,
    /// The walk failed part-way for another reason; its partial names are
    /// intentionally not returned.
    WalkAborted,
    /// The name count exceeded MAX_LINKS.
    TooManyLinks,
    /// The anchor is empty or not an absolute path.
    InvalidAnchor,
}

impl LinkFailureKind {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::FileGone => "WIN_LINK_FILE_GONE",
            Self::AccessDenied => "WIN_LINK_ACCESS_DENIED",
            Self::WalkAborted => "WIN_LINK_WALK_ABORTED",
            Self::TooManyLinks => "WIN_LINK_TOO_MANY",
            Self::InvalidAnchor => "WIN_LINK_INVALID_ANCHOR",
        }
    }
}

/// One failed (and therefore skipped) reconcile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkFailure {
    /// What went wrong.
    pub kind: LinkFailureKind,
    /// How many names had been seen before the failure; diagnostic only, never
    /// applied.
    pub seen: u32,
}

/// Result of one hard-link enumeration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkOutcome {
    /// Every current name of the file.
    Complete(LinkSet),
    /// The walk could not be proven complete. The caller must skip this record,
    /// count it, and keep the previous link set.
    Incomplete(LinkFailure),
}

impl LinkOutcome {
    /// Whether the walk completed.
    pub fn is_complete(&self) -> bool {
        matches!(self, Self::Complete(_))
    }

    /// The set when complete.
    pub fn set(&self) -> Option<&LinkSet> {
        match self {
            Self::Complete(set) => Some(set),
            Self::Incomplete(_) => None,
        }
    }

    /// The failure when incomplete.
    pub fn failure(&self) -> Option<LinkFailure> {
        match self {
            Self::Complete(_) => None,
            Self::Incomplete(failure) => Some(*failure),
        }
    }
}

/// Running counters a reconcile loop reports to its host.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LinkWalkStats {
    /// Reconciles attempted.
    pub attempted: u64,
    /// Walks that returned a complete set.
    pub completed: u64,
    /// Walks skipped because they were not provably complete.
    pub skipped: u64,
}

impl LinkWalkStats {
    /// Records one outcome.
    pub fn record(&mut self, outcome: &LinkOutcome) {
        self.attempted += 1;
        match outcome {
            LinkOutcome::Complete(_) => self.completed += 1,
            LinkOutcome::Incomplete(_) => self.skipped += 1,
        }
    }

    /// Whether every attempted reconcile completed.
    pub fn is_clean(&self) -> bool {
        self.skipped == 0
    }
}

/// Enumerates every current hard-link name of the file at anchor.
///
/// anchor must be an absolute, NUL-free path to an existing name of the file;
/// the caller normally takes it from its own verified candidate. The returned
/// names are volume-rooted exactly as Win32 reports them, so a caller joins them
/// to parent entries by matching their trailing directory/name components.
///
/// Anchors longer than the legacy MAX_PATH limit are passed to Win32 with the
/// verbatim prefix by the boundary module, so deep paths still enumerate.
///
/// This never returns an empty complete set: a walk that could not be trusted is
/// LinkOutcome::Incomplete and must be skipped and counted by the caller.
pub fn enumerate(anchor: &Path) -> LinkOutcome {
    let os = anchor.as_os_str();
    if os.is_empty() || !anchor.is_absolute() || os.encode_wide().any(|unit| unit == 0) {
        return LinkOutcome::Incomplete(LinkFailure {
            kind: LinkFailureKind::InvalidAnchor,
            seen: 0,
        });
    }
    match crate::winfs::links::enumerate(os) {
        Ok(names) => complete_or_aborted(names),
        Err(failure) => LinkOutcome::Incomplete(failure),
    }
}

/// Deduplicates names defensively; an empty answer cannot be a complete set.
fn complete_or_aborted(names: Vec<Vec<u16>>) -> LinkOutcome {
    let mut unique = HashSet::with_capacity(names.len());
    let deduped: Vec<Vec<u16>> = names
        .into_iter()
        .filter(|name| !name.is_empty() && unique.insert(name.clone()))
        .collect();
    if deduped.is_empty() {
        return LinkOutcome::Incomplete(LinkFailure {
            kind: LinkFailureKind::WalkAborted,
            seen: 0,
        });
    }
    LinkOutcome::Complete(LinkSet::new(deduped))
}

#[cfg(test)]
#[path = "links_tests.rs"]
mod links_tests;
