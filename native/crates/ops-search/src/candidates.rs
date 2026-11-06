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
//! disagree about item order. Name exclusions and credentials are classified
//! from the live leaf, after link classification, in the same order as the
//! walk: a vanished hidden entry is silent instead of an `excluded` skip, a
//! hidden link is `symlink` instead of `excluded`, and `skippedFiles` uses the
//! live type rather than the snapshot's. It does not wire itself into the scan: [`collect`]
//! returns a [`Batch`] whose counters the caller applies to the existing
//! `Scan` fields, keeping `scanComplete`/`continuation` semantics in one place.

use crate::file_path;
use cap_fs_ext::{DirExt, MetadataExt};
use cap_std::fs::{Dir, Metadata};
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
            Verdict::Skip(reason, file) => batch.skipped.push(Skip {
                rel: candidate.rel.clone(),
                reason,
                file: reason.counts_file() && file,
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
    /// A dropped candidate; the bool is whether the *live* entry is a regular
    /// file, which is what the walk's `skippedFiles` counter uses.
    Skip(SkipReason, bool),
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
        Err((reason, true)) => return Verdict::Skip(reason, false),
        Err((_reason, false)) => return Verdict::Fallback(FallbackKind::Unverified),
    };
    let (leaf, ancestors) = names.split_last().expect("names is never empty");
    let display = root.join(&candidate.rel);
    let parent = display.parent().unwrap_or(root);
    // The walk treats the audit store as an intentional exclusion before any
    // other rule, and `file_path::checked` would otherwise reject it as
    // PATH_RESTRICTED (which is an ancestor-fallback signal here). Its file
    // flag comes from the live relative entry, exactly like the walk's.
    if leaf.eq_ignore_ascii_case(ops_files::paths::STORE) {
        let file = inspect
            .leaf(parent, leaf)
            .is_ok_and(|metadata| metadata.is_file());
        return Verdict::Skip(SkipReason::Excluded, file);
    }
    if ancestors
        .iter()
        .any(|name| name.eq_ignore_ascii_case(ops_files::paths::STORE))
    {
        return Verdict::Fallback(FallbackKind::Unverified);
    }
    if let Some(index) = names.iter().position(|name| invalid_name(name, request)) {
        return if index + 1 == names.len() {
            Verdict::Skip(SkipReason::InvalidPath, false)
        } else {
            Verdict::Fallback(FallbackKind::Unverified)
        };
    }
    // A hidden ancestor is pruned by the walk before it reaches any leaf, so a
    // source that enumerated below one cannot be proven equivalent.
    if ancestors.iter().any(|name| excluded_name(name)) {
        return Verdict::Fallback(FallbackKind::Unverified);
    }
    // The walk reads live metadata first and only then applies the credential,
    // link and hidden-name rules. Applying the name rules from the snapshot
    // would report `excluded` for a vanished hidden entry (the walk reports
    // nothing), report `excluded` for a hidden link (the walk reports
    // `symlink`), and count a type change with the stale snapshot type.
    let metadata = match inspect.leaf(parent, leaf) {
        Ok(metadata) => metadata,
        Err(error) => {
            return if candidate.kind == EntryKind::Dir {
                directory_error(error)
            } else {
                leaf_error(error, candidate)
            };
        }
    };
    if request.denies_path(&display) {
        // A denied *ancestor* pruned the whole subtree in the walk; a denied
        // leaf is its own `credential` skip.
        return if request.denies_path(parent) {
            Verdict::Fallback(FallbackKind::Unverified)
        } else {
            Verdict::Skip(SkipReason::Credential, metadata.is_file())
        };
    }
    if file_path::link(&metadata) {
        return if candidate.kind == EntryKind::Dir {
            // The snapshot listed children below this path; the walk does not
            // descend through a link, so the batch is no longer complete.
            Verdict::Fallback(FallbackKind::AncestorLink)
        } else {
            Verdict::Skip(SkipReason::Symlink, false)
        };
    }
    if excluded_name(leaf) {
        return Verdict::Skip(SkipReason::Excluded, metadata.is_file());
    }
    if candidate.kind == EntryKind::Dir {
        return classify_directory(candidate, metadata, inspect, parent, leaf);
    }
    classify(candidate, metadata)
}

/// Maps a failed leaf stat for a non-directory candidate to the walk's answer.
fn leaf_error(error: InspectError, candidate: &Candidate) -> Verdict {
    match error {
        InspectError::Stale => Verdict::Stale,
        InspectError::Invalid => Verdict::Skip(SkipReason::InvalidPath, false),
        // A leaf that cannot be stat'ed is the walk's `unreadable-entry` gap.
        // An *ancestor* that cannot be opened is the walk's
        // `unreadable-directory` gap, which only a walk can account for, so a
        // per-candidate skip would over-count.
        InspectError::Unreadable => {
            Verdict::Skip(SkipReason::Unreadable, candidate.kind == EntryKind::File)
        }
        InspectError::ParentUnreadable => Verdict::Fallback(FallbackKind::DirectoryUnreadable),
        InspectError::AncestorLink => Verdict::Fallback(FallbackKind::AncestorLink),
        InspectError::Unverified => Verdict::Fallback(FallbackKind::Unverified),
    }
}

/// Classifies a fresh leaf against the snapshot's type and identity.
fn classify(candidate: &Candidate, metadata: Metadata) -> Verdict {
    if metadata.is_file() {
        if candidate.kind != EntryKind::File {
            // The snapshot described a directory whose children no longer
            // describe the tree.
            return Verdict::Fallback(FallbackKind::KindChanged);
        }
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
    Verdict::Skip(SkipReason::Unsupported, false)
}

/// Classifies a directory candidate that already passed the walk-ordered
/// credential, link and hidden-name rules.
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
fn classify_directory(
    candidate: &Candidate,
    metadata: Metadata,
    inspect: &dyn Inspect,
    parent: &Path,
    leaf: &str,
) -> Verdict {
    if !metadata.is_dir() {
        return if metadata.is_file() {
            Verdict::Fallback(FallbackKind::KindChanged)
        } else {
            Verdict::Fallback(FallbackKind::Unverified)
        };
    }
    let actual = FileKey::new(metadata.dev(), metadata.ino());
    if actual != candidate.key {
        return Verdict::Fallback(FallbackKind::IdDrift);
    }
    // A directory can be stat'ed without being listable: `chmod 000` leaves
    // `symlink_metadata` working while the walk's `open_dir_nofollow` (and its
    // `read_dir`) fail. The walk records one `unreadable-directory` gap there,
    // so fall back and let it do that instead of accepting the directory and
    // counting an `unreadable-entry` gap per child.
    match inspect.directory(parent, leaf) {
        Ok(()) => Verdict::Directory,
        Err(error) => directory_error(error),
    }
}

fn directory_error(error: InspectError) -> Verdict {
    match error {
        InspectError::Stale => Verdict::Stale,
        InspectError::Unreadable | InspectError::ParentUnreadable => {
            Verdict::Fallback(FallbackKind::DirectoryUnreadable)
        }
        InspectError::Invalid => Verdict::Fallback(FallbackKind::Unverified),
        InspectError::AncestorLink => Verdict::Fallback(FallbackKind::AncestorLink),
        InspectError::Unverified => Verdict::Fallback(FallbackKind::Unverified),
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

    /// Opens `name` as a directory, which is how the walk proves that a
    /// directory is listable, not just stat-able.
    fn directory(&self, parent: &Path, name: &str) -> Result<(), InspectError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InspectError {
    /// The path (or one of its ancestors) no longer exists.
    Stale,
    /// A component is not a legal path name.
    Invalid,
    /// The leaf exists but cannot be read (stat failed).
    Unreadable,
    /// One of the ancestors exists but cannot be opened as a directory.
    ///
    /// The walk records this as its single `unreadable-directory` gap, so the
    /// caller must fall back instead of counting a skip per descendant.
    ParentUnreadable,
    /// One of the ancestors is a link or another special object.
    AncestorLink,
    /// An I/O failure that cannot be classified safely.
    Unverified,
}

struct HostInspect;

impl Inspect for HostInspect {
    fn leaf(&self, parent: &Path, name: &str) -> Result<Metadata, InspectError> {
        let directory = open_parent(parent)?;
        match directory.symlink_metadata(name) {
            Ok(metadata) => Ok(metadata),
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                // The leaf stat never needs the leaf's own permission, so EACCES
                // means an ancestor refused traversal. The parent's listability
                // is what separates the walk's two answers: an unreadable
                // parent is one `unreadable-directory` gap (fall back), while a
                // readable parent over an unsearchable one is an
                // `unreadable-entry` gap for this child (skip).
                match directory.entries() {
                    Ok(_) => Err(InspectError::Unreadable),
                    Err(_) => Err(InspectError::ParentUnreadable),
                }
            }
            Err(error) => Err(leaf_io_to_inspect(error)),
        }
    }

    fn directory(&self, parent: &Path, name: &str) -> Result<(), InspectError> {
        let directory = open_parent(parent)?
            .open_dir_nofollow(name)
            .map_err(parent_io_to_inspect)?;
        // The walk proves a directory is usable by reading its entries, not by
        // opening it: on Linux a cap-std handle opens with `O_PATH`, which
        // succeeds on a `chmod 000` directory while `entries()` fails. Mirror
        // the walk so the same directory produces the same gap.
        directory.entries().map_err(parent_io_to_inspect)?;
        Ok(())
    }
}

/// Opens the directory that contains a candidate leaf, no-follow at every
/// component, and returns it.
///
/// Every failure here happens *above* the leaf, so it is a parent-directory
/// failure: an unreadable ancestor is the walk's `unreadable-directory` gap,
/// not an `unreadable-entry` gap for each child below it.
fn open_parent(parent: &Path) -> Result<Dir, InspectError> {
    let raw = parent.to_str().ok_or(InspectError::Invalid)?;
    let target = file_path::checked(raw).map_err(parent_failure_to_inspect)?;
    target
        .parent
        .open_dir_nofollow(&target.name)
        .map_err(parent_io_to_inspect)
}

fn parent_failure_to_inspect(error: Failure) -> InspectError {
    match error.code.as_str() {
        "NOT_FOUND" => InspectError::Stale,
        // `checked` walks the ancestors component by component, so an access
        // denial here is an ancestor that cannot be opened.
        "ACCESS_DENIED" => InspectError::ParentUnreadable,
        "PATH_RESTRICTED" => InspectError::AncestorLink,
        "INVALID_ARGUMENT" => InspectError::Invalid,
        // `Failure` maps ENOTDIR/EIO and the rest to IO_ERROR without keeping
        // the kind; inventing a skip reason here would make the counters lie.
        _ => InspectError::Unverified,
    }
}

fn parent_io_to_inspect(error: io::Error) -> InspectError {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => InspectError::Stale,
        io::ErrorKind::PermissionDenied => InspectError::ParentUnreadable,
        _ => InspectError::Unverified,
    }
}

fn leaf_io_to_inspect(error: io::Error) -> InspectError {
    match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => InspectError::Stale,
        io::ErrorKind::PermissionDenied => InspectError::Unreadable,
        _ => InspectError::Unverified,
    }
}

#[cfg(test)]
#[path = "candidates_tests.rs"]
mod candidates_tests;
