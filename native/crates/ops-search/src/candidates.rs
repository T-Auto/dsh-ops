// Design informed by mustafaahci/goz (MIT)
//! Revalidation of index candidates against the live file system.
//!
//! A name index is a hint, never an authority. Before one candidate may enter a
//! result set it is re-opened component by component without following links
//! (`file_path::checked`), its leaf is stat'ed through that directory
//! handle, and its `(dev, ino)` identity is compared with what the snapshot
//! recorded. The three outcomes are deliberately different:
//!
//! - the path no longer exists: drop the candidate silently. The walk would not
//!   have listed it either, so it is neither an item nor a skip reason;
//! - the path exists but cannot be read: keep it as an `unreadable-entry` gap,
//!   because dropping it would hide a hole the walk reports;
//! - the identity moved, an ancestor is a link, a file became a directory, or a
//!   directory became a file or a link: the indexed answer can no longer be
//!   called complete, so the caller must discard the whole batch and fall back
//!   to `crate::scan::Scan::walk`.
//!
//! Directory candidates are traversal state, not items, but they are revalidated
//! too: a directory that vanished is stale like any other vanished path, one
//! that changed type or identity invalidates the batch, and one that can no
//! longer be read falls back so the walk recomputes its `unreadable-directory`
//! gap. Skipping that check would let the indexed `skipReasons`/gaps disagree
//! with the walk even when every leaf still looked fresh.
//!
//! The module also restores the walk's lexical rules (invalid components,
//! hidden names, credential roots, reserved names) and the component-order sort
//! the walk produces naturally, so an indexed answer and a walked answer cannot
//! disagree about item order. It does not wire itself into the scan: [`collect`]
//! returns a [`Batch`] whose counters the caller applies to the existing
//! `Scan` fields, keeping `scanComplete`/`continuation` semantics in one place.

use crate::file_path;
use cap_fs_ext::{DirExt, MetadataExt};
use cap_std::fs::Metadata;
use ops_index::{
    Candidate, EntryKind, EnumBudget, FileKey, FsDataSource, SnapshotId, SourceError, SourceState,
};
use ops_protocol::{Failure, Request};
use std::collections::BTreeMap;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Why one candidate was dropped instead of returned.
///
/// Strings match the existing `skipReasons` vocabulary; `is_gap` matches
/// `Scan::skip`'s third argument. A vanished path is intentionally absent: it
/// is not a skip reason because the walk never sees it either.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// A component failed `file_path::validate_name` (or a windows-only rule).
    InvalidPath,
    /// A component cannot be represented as a UTF-8 path.
    NonUtf8Path,
    /// The leaf is a symbolic link, junction or other reparse point.
    Symlink,
    /// The host named this location as a credential root.
    Credential,
    /// A declared exclusion: hidden names, `.dsh-ops`, `node_modules`, `target`.
    Excluded,
    /// The leaf is a socket, device, FIFO or another special object.
    Unsupported,
    /// The leaf or one of its ancestors could not be read.
    Unreadable,
}

impl SkipReason {
    /// The exact key the scan puts in `skipReasons`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPath => "invalid-path",
            Self::NonUtf8Path => "non-utf8-path",
            Self::Symlink => "symlink",
            Self::Credential => "credential",
            Self::Excluded => "excluded",
            Self::Unsupported => "unsupported-entry",
            Self::Unreadable => "unreadable-entry",
        }
    }

    /// Whether the scan must report this drop as a coverage gap.
    pub fn is_gap(self) -> bool {
        matches!(
            self,
            Self::InvalidPath | Self::NonUtf8Path | Self::Unreadable
        )
    }

    /// Whether `Scan::skip` would count the dropped entry as a file.
    ///
    /// The walk decides this from the entry's own `symlink_metadata` before it
    /// applies the reason; only credentials and exclusions can be regular files
    /// at that point. Links report their own type, so they never count.
    pub fn counts_file(self) -> bool {
        matches!(self, Self::Credential | Self::Excluded)
    }
}

/// One dropped candidate, ready to be counted by the scan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skip {
    /// Path relative to the root.
    pub rel: PathBuf,
    /// Why it was dropped.
    pub reason: SkipReason,
    /// Whether it contributes to `skippedFiles`.
    pub file: bool,
}

impl Skip {
    /// Whether the scan must report this drop as a coverage gap.
    pub fn gap(&self) -> bool {
        self.reason.is_gap()
    }
}

/// One candidate that survived revalidation.
pub struct Fresh {
    /// The source entry, including the identity that was verified.
    pub candidate: Candidate,
    /// Absolute display path: `root.join(&candidate.rel)`, the root exactly as
    /// the caller passed it plus the candidate's lexically validated relative
    /// path.
    ///
    /// It is not the canonicalised path `file_path::checked` opened: a root
    /// with a trailing separator or a different spelling shows up here the way
    /// the caller wrote it, which is what keeps the indexed display string
    /// byte-identical to the walk's own `root.join(...)`.
    pub path: PathBuf,
    /// Metadata read through the no-follow parent handle.
    pub metadata: Metadata,
}

/// A complete, revalidated index answer for one root.
pub struct Batch {
    /// Snapshot the source reported ready.
    pub snapshot: SnapshotId,
    /// Consistency timestamp reported by the ready state.
    ///
    /// This is the state's timestamp, not the enumeration's, so the snapshot id
    /// and the time always describe the same snapshot.
    pub consistent_at_ms: i64,
    /// Candidates that may be filtered and paged like walk results.
    pub fresh: Vec<Fresh>,
    /// Dropped candidates that the scan must count.
    pub skipped: Vec<Skip>,
    /// Candidates that vanished between the snapshot and revalidation.
    ///
    /// Silent: not an item and not a skip reason.
    pub stale: usize,
    /// Number of distinct source candidates seen (the index-side `entries`).
    pub entries: usize,
    /// Whether the source stopped at a budget and the set is incomplete.
    pub truncated: bool,
}

impl Batch {
    /// Skip reasons in the exact shape `Scan::reasons` uses.
    pub fn reasons(&self) -> BTreeMap<String, usize> {
        let mut reasons = BTreeMap::new();
        for skip in &self.skipped {
            *reasons.entry(skip.reason.as_str().to_owned()).or_insert(0) += 1;
        }
        reasons
    }

    /// Number of skipped *files*, matching `Scan::skipped`.
    pub fn skipped_files(&self) -> usize {
        self.skipped.iter().filter(|skip| skip.file).count()
    }

    /// Number of coverage gaps, matching `Scan::failed`.
    pub fn gaps(&self) -> usize {
        self.skipped
            .iter()
            .filter(|skip| skip.reason.is_gap())
            .count()
    }
}

/// Why an indexed answer could not be used at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FallbackKind {
    /// `state` or `enumerate` refused: unsupported, not ready, budget or I/O.
    Source(SourceError),
    /// An ancestor of the candidate is now a link or another special object.
    AncestorLink,
    /// The candidate's `(dev, ino)` no longer matches the snapshot.
    IdDrift,
    /// The candidate used to be a file and is now a directory, or the reverse.
    KindChanged,
    /// A directory candidate could not be read live.
    ///
    /// The walk would report its `unreadable-directory` gap; recomputing that
    /// count from the index side would duplicate the walk's rule, so the caller
    /// falls back and lets the walk account for it.
    DirectoryUnreadable,
    /// The source violated the walk's lexical contract or an unclassified I/O
    /// failure occurred; do not invent a skip reason.
    Unverified,
}

/// A reason to discard the whole batch and walk instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fallback {
    /// What invalidated the indexed answer.
    pub kind: FallbackKind,
    /// Candidate that revealed the problem, when it was candidate-specific.
    pub rel: Option<PathBuf>,
}

/// Result of one revalidation pass.
pub enum Outcome {
    /// Every candidate was classified; the set may be used.
    Ready(Batch),
    /// The indexed answer is untrustworthy; the caller must walk.
    Fallback(Fallback),
}

/// Enumerates `root` through `source` and revalidates every candidate.
///
/// `budget` is forwarded unchanged, so the source applies the same entry,
/// depth and deadline limits it would apply to any caller. A source that is not
/// `SourceState::Ready`, or that fails, yields [`Outcome::Fallback`]; the
/// caller then produces exactly the output the walk produces today.
pub fn collect(
    root: &Path,
    request: &Request,
    source: &dyn FsDataSource,
    budget: EnumBudget,
) -> Outcome {
    collect_with(root, request, source, budget, &HostInspect)
}

fn collect_with(
    root: &Path,
    request: &Request,
    source: &dyn FsDataSource,
    budget: EnumBudget,
    inspect: &dyn Inspect,
) -> Outcome {
    if !root.is_absolute() || root.to_str().is_none() {
        // The walk is rooted at an absolute, UTF-8 path; anything else cannot
        // produce a comparable answer.
        return Outcome::Fallback(Fallback {
            kind: FallbackKind::Unverified,
            rel: None,
        });
    }
    let (snapshot, consistent_at_ms) = match source.state(root) {
        SourceState::Ready {
            snapshot,
            consistent_at_ms,
        } => (snapshot, consistent_at_ms),
        SourceState::Unsupported => {
            return Outcome::Fallback(Fallback {
                kind: FallbackKind::Source(SourceError::Unsupported),
                rel: None,
            });
        }
        SourceState::Unavailable => {
            return Outcome::Fallback(Fallback {
                kind: FallbackKind::Source(SourceError::NotReady),
                rel: None,
            });
        }
    };
    let set = match source.enumerate(root, budget) {
        Ok(set) => set,
        Err(error) => {
            return Outcome::Fallback(Fallback {
                kind: FallbackKind::Source(error),
                rel: None,
            });
        }
    };
    let mut batch = Batch {
        snapshot,
        consistent_at_ms,
        fresh: Vec::new(),
        skipped: Vec::new(),
        stale: 0,
        entries: 0,
        truncated: set.truncated,
    };
    let mut candidates = set.entries;
    candidates.sort_by(|left, right| left.rel.cmp(&right.rel));
    candidates.dedup_by(|left, right| left.rel == right.rel);
    batch.entries = candidates.len();
    for candidate in candidates {
        // The source is supposed to stop at the same deadline; this guard is
        // the last line of defence for a source that does not.
        if budget.expired() {
            return Outcome::Fallback(Fallback {
                kind: FallbackKind::Source(SourceError::Budget),
                rel: None,
            });
        }
        match revalidate(root, request, &candidate, inspect) {
            Verdict::Fresh(metadata) => {
                let path = root.join(&candidate.rel);
                batch.fresh.push(Fresh {
                    candidate,
                    path,
                    metadata,
                });
            }
            Verdict::Skip(reason) => batch.skipped.push(Skip {
                rel: candidate.rel.clone(),
                reason,
                file: reason.counts_file() && candidate.is_file(),
            }),
            Verdict::Stale => batch.stale += 1,
            Verdict::Directory => {}
            Verdict::Fallback(kind) => {
                return Outcome::Fallback(Fallback {
                    kind,
                    rel: Some(candidate.rel),
                });
            }
        }
    }
    Outcome::Ready(batch)
}

enum Verdict {
    Fresh(Metadata),
    Skip(SkipReason),
    Stale,
    /// A directory is traversal state, not an item; it is neither accepted nor
    /// counted as a skip.
    Directory,
    Fallback(FallbackKind),
}

fn revalidate(
    root: &Path,
    request: &Request,
    candidate: &Candidate,
    inspect: &dyn Inspect,
) -> Verdict {
    // A source must already apply the walk's lexical policy; a bad *leaf* is
    // the candidate's own problem and is counted, while a bad *ancestor* means
    // the source enumerated below a directory the walk prunes. Guessing which
    // skip the walk would have recorded there would make the counters lie, so
    // that case falls back instead.
    let names = match names(&candidate.rel) {
        Ok(names) => names,
        Err((reason, true)) => return Verdict::Skip(reason),
        Err((_reason, false)) => return Verdict::Fallback(FallbackKind::Unverified),
    };
    let (leaf, ancestors) = names.split_last().expect("names is never empty");
    // The walk treats the audit store as an intentional exclusion before any
    // other rule, and `file_path::checked` would otherwise reject it as
    // PATH_RESTRICTED (which is an ancestor-fallback signal here).
    if leaf.eq_ignore_ascii_case(ops_files::paths::STORE) {
        return Verdict::Skip(SkipReason::Excluded);
    }
    if ancestors
        .iter()
        .any(|name| name.eq_ignore_ascii_case(ops_files::paths::STORE))
    {
        return Verdict::Fallback(FallbackKind::Unverified);
    }
    if let Some(index) = names.iter().position(|name| invalid_name(name, request)) {
        return if index + 1 == names.len() {
            Verdict::Skip(SkipReason::InvalidPath)
        } else {
            Verdict::Fallback(FallbackKind::Unverified)
        };
    }
    let display = root.join(&candidate.rel);
    let parent = display.parent().unwrap_or(root);
    if request.denies_path(&display) {
        return if request.denies_path(parent) {
            Verdict::Fallback(FallbackKind::Unverified)
        } else {
            Verdict::Skip(SkipReason::Credential)
        };
    }
    if excluded_name(leaf) {
        return Verdict::Skip(SkipReason::Excluded);
    }
    if ancestors.iter().any(|name| excluded_name(name)) {
        return Verdict::Fallback(FallbackKind::Unverified);
    }
    let inspected = inspect.leaf(parent, leaf);
    if candidate.kind == EntryKind::Dir {
        // Directories are how the walk reaches items, not items themselves,
        // but they are still checked live: the walk's gap/count semantics
        // depend on what happened to them.
        return classify_directory(candidate, inspected);
    }
    match inspected {
        Ok(metadata) => classify(candidate, metadata),
        Err(InspectError::Stale) => Verdict::Stale,
        Err(InspectError::Invalid) => Verdict::Skip(SkipReason::InvalidPath),
        Err(InspectError::Unreadable) => Verdict::Skip(SkipReason::Unreadable),
        Err(InspectError::AncestorLink) => Verdict::Fallback(FallbackKind::AncestorLink),
        Err(InspectError::Unverified) => Verdict::Fallback(FallbackKind::Unverified),
    }
}

fn classify(candidate: &Candidate, metadata: Metadata) -> Verdict {
    if file_path::link(&metadata) {
        return Verdict::Skip(SkipReason::Symlink);
    }
    if metadata.is_file() {
        let actual = FileKey::new(metadata.dev(), metadata.ino());
        if actual != candidate.key {
            // A single silent drop would hide files the walk would report.
            return Verdict::Fallback(FallbackKind::IdDrift);
        }
        return Verdict::Fresh(metadata);
    }
    if metadata.is_dir() {
        // The file may have been replaced by a directory whose children the
        // snapshot never listed; only a walk can prove what is there now.
        return Verdict::Fallback(FallbackKind::KindChanged);
    }
    Verdict::Skip(SkipReason::Unsupported)
}

/// Classifies a directory candidate against the live file system.
///
/// A directory that is still the same directory produces nothing: it is
/// traversal state, not an item. Everything else must fall back or be silent,
/// because the walk's counters depend on what happened to it:
///
/// - vanished -> stale, exactly like a vanished file (the walk would not list
///   it either, and its children report themselves);
/// - unreadable -> fall back so the walk computes its `unreadable-directory`
///   gap; inventing the count here would duplicate the walk's rule;
/// - became a file or a link -> the snapshot's children no longer describe the
///   tree, so the whole batch is invalid;
/// - different `(dev, ino)` while still a directory -> a different directory
///   now owns the path, so the children resolve under an identity the snapshot
///   never saw.
fn classify_directory(candidate: &Candidate, inspected: Result<Metadata, InspectError>) -> Verdict {
    match inspected {
        Ok(metadata) => {
            if file_path::link(&metadata) {
                return Verdict::Fallback(FallbackKind::AncestorLink);
            }
            if metadata.is_dir() {
                let actual = FileKey::new(metadata.dev(), metadata.ino());
                if actual != candidate.key {
                    return Verdict::Fallback(FallbackKind::IdDrift);
                }
                return Verdict::Directory;
            }
            if metadata.is_file() {
                return Verdict::Fallback(FallbackKind::KindChanged);
            }
            Verdict::Fallback(FallbackKind::Unverified)
        }
        Err(InspectError::Stale) => Verdict::Stale,
        Err(InspectError::Unreadable) => Verdict::Fallback(FallbackKind::DirectoryUnreadable),
        Err(InspectError::Invalid) => Verdict::Fallback(FallbackKind::Unverified),
        Err(InspectError::AncestorLink) => Verdict::Fallback(FallbackKind::AncestorLink),
        Err(InspectError::Unverified) => Verdict::Fallback(FallbackKind::Unverified),
    }
}

fn excluded_name(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | ".venv")
}

fn names(rel: &Path) -> Result<Vec<&str>, (SkipReason, bool)> {
    if rel.is_absolute() {
        return Err((SkipReason::InvalidPath, false));
    }
    let components: Vec<_> = rel.components().collect();
    if components.is_empty() {
        return Err((SkipReason::InvalidPath, false));
    }
    let last = components.len() - 1;
    let mut names = Vec::with_capacity(components.len());
    for (index, component) in components.iter().enumerate() {
        match component {
            Component::Normal(name) => names.push(
                name.to_str()
                    .ok_or((SkipReason::NonUtf8Path, index == last))?,
            ),
            _ => return Err((SkipReason::InvalidPath, index == last)),
        }
    }
    Ok(names)
}

fn invalid_name(name: &str, request: &Request) -> bool {
    file_path::validate_name(name).is_err()
        || (request.windows_paths && ops_protocol::windows_paths::validate_name(name).is_err())
}

/// The part of revalidation that needs the live file system.
///
/// Keeping it behind a trait is what lets the tests inject EACCES on every OS
/// instead of relying on permission bits that Windows cannot express.
trait Inspect {
    /// Stats `name` inside `parent`, which is opened without following links.
    fn leaf(&self, parent: &Path, name: &str) -> Result<Metadata, InspectError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InspectError {
    /// The path (or one of its ancestors) no longer exists.
    Stale,
    /// A component is not a legal path name.
    Invalid,
    /// The path exists but cannot be read.
    Unreadable,
    /// One of the ancestors is a link or another special object.
    AncestorLink,
    /// An I/O failure that cannot be classified safely.
    Unverified,
}

struct HostInspect;

impl Inspect for HostInspect {
    fn leaf(&self, parent: &Path, name: &str) -> Result<Metadata, InspectError> {
        let raw = parent.to_str().ok_or(InspectError::Invalid)?;
        let target = file_path::checked(raw).map_err(failure_to_inspect)?;
        let directory = target
            .parent
            .open_dir_nofollow(&target.name)
            .map_err(io_to_inspect)?;
        directory.symlink_metadata(name).map_err(io_to_inspect)
    }
}

fn failure_to_inspect(error: Failure) -> InspectError {
    match error.code.as_str() {
        "NOT_FOUND" => InspectError::Stale,
        "ACCESS_DENIED" => InspectError::Unreadable,
        "PATH_RESTRICTED" => InspectError::AncestorLink,
        "INVALID_ARGUMENT" => InspectError::Invalid,
        // `Failure` maps ENOTDIR/EIO and the rest to IO_ERROR without keeping
        // the kind; inventing a skip reason here would make the counters lie.
        _ => InspectError::Unverified,
    }
}

fn io_to_inspect(error: io::Error) -> InspectError {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => InspectError::Stale,
        io::ErrorKind::PermissionDenied => InspectError::Unreadable,
        _ => InspectError::Unverified,
    }
}

#[cfg(test)]
#[path = "candidates_tests.rs"]
mod candidates_tests;
