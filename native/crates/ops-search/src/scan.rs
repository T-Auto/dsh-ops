//! Bounded, no-follow traversal. Declared exclusions differ from unobserved gaps.
//!
//! Two entry points share the same accounting: [`Scan::walk`] is the live
//! traversal, and [`Scan::walk_indexed`] asks an `FsDataSource` for candidates
//! first and falls back to the walk when the source cannot prove a complete
//! answer. Both produce the same items, counters and `scanComplete` result, so a
//! caller never sees which path served the page.
use super::*;
use crate::candidates::{self, Outcome};
use cap_fs_ext::MetadataExt;
use ops_index::{EnumBudget, FsDataSource};
use ops_protocol::search::TruncatedBy;
use std::{
    collections::BTreeMap,
    io::Read,
    time::{Duration, Instant, UNIX_EPOCH},
};

pub const MAX_SCAN_FILES: usize = 10_000;
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SCAN_BYTES: usize = 256 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_WALK_ENTRIES: usize = 100_000;

/// Which traversal produced a request's observed entries.
///
/// The kind is chosen once per request, before the first page is scanned, and
/// every page of a continuation binds it (see `paging::Cursor`). `Walk` is the
/// default and the only kind the pre-G2 code paths use; `Index` means the page
/// was produced from revalidated index candidates by [`Scan::walk_indexed`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SourceKind {
    /// The live, no-follow traversal.
    #[default]
    Walk,
    /// Revalidated index candidates with a walk fallback.
    Index,
}

impl SourceKind {
    /// Token prefix that binds a continuation to this kind.
    pub const fn token_prefix(self) -> &'static str {
        match self {
            Self::Walk => "s1",
            Self::Index => "s2",
        }
    }

    /// The kind a continuation token names, when it names one.
    ///
    /// A page must resume the traversal that produced its snapshot, so the
    /// prefix (not the caller) decides which cursor domain page two validates.
    pub fn from_token(token: &str) -> Option<Self> {
        match token.split(':').next() {
            Some("s1") => Some(Self::Walk),
            Some("s2") => Some(Self::Index),
            _ => None,
        }
    }
}

pub struct Scan {
    pub profile: crate::profile::Profile,
    pub scanned: usize,
    pub skipped: usize,
    pub reasons: BTreeMap<String, usize>,
    pub gap: bool,
    pub failed: usize,
    pub stopped: Option<TruncatedBy>,
    /// Traversal that produced this scan's observations.
    pub source: SourceKind,
    pub hash: Sha256,
    started: Instant,
    timeout: Duration,
    max_files: usize,
    max_depth: usize,
    entries: usize,
    bytes: usize,
}
impl Scan {
    pub fn new() -> Self {
        Self {
            profile: crate::profile::Profile::new(),
            scanned: 0,
            skipped: 0,
            reasons: BTreeMap::new(),
            gap: false,
            failed: 0,
            stopped: None,
            source: SourceKind::Walk,
            hash: Sha256::new(),
            started: Instant::now(),
            timeout: SCAN_TIMEOUT,
            max_files: MAX_SCAN_FILES,
            max_depth: MAX_DEPTH,
            entries: 0,
            bytes: 0,
        }
    }
    pub fn running(&mut self) -> bool {
        if self.stopped.is_none() && self.started.elapsed() >= self.timeout {
            self.stopped = Some(TruncatedBy::Time);
        }
        self.stopped.is_none()
    }
    /// Time left before the scan deadline.
    fn remaining(&self) -> Duration {
        self.timeout.saturating_sub(self.started.elapsed())
    }
    pub fn skip(&mut self, reason: &str, file: bool, gap: bool) {
        *self.reasons.entry(reason.into()).or_default() += 1;
        self.skipped += usize::from(file);
        self.gap |= gap;
        if gap && !matches!(reason, "oversized" | "invalid-encoding") {
            self.failed += 1;
        }
    }
    pub fn complete(&self) -> bool {
        !self.gap && self.stopped.is_none()
    }
    pub fn stamp(&mut self, path: &Path, metadata: &cap_std::fs::Metadata) {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_nanos());
        self.hash.update(
            serde_json::to_vec(&json!([
                path,
                metadata.dev(),
                metadata.ino(),
                metadata.len(),
                modified,
                metadata.is_dir()
            ]))
            .unwrap(),
        );
    }
    pub fn read(&mut self, path: &Path) -> Option<Vec<u8>> {
        let read = (|| -> Result<Option<Vec<u8>>> {
            let started = self.profile.start();
            let opened = (|| {
                let target = file_path::checked(
                    path.to_str()
                        .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?,
                )?;
                file_path::read_file(&target)
            })();
            self.profile.record("pathValidationAndOpen", started);
            let mut file = opened?;
            if file.metadata()?.len() > MAX_FILE_BYTES as u64 {
                self.skip("oversized", true, true);
                return Ok(None);
            }
            let mut bytes = Vec::new();
            let mut chunk = [0; 64 * 1024];
            loop {
                if !self.running() {
                    return Ok(None);
                }
                let started = self.profile.start();
                let read = file.read(&mut chunk);
                self.profile.record("readIo", started);
                let count = read?;
                if count == 0 {
                    break;
                }
                self.bytes += count;
                if self.bytes > MAX_SCAN_BYTES {
                    self.stopped = Some(TruncatedBy::ScanBudget);
                    return Ok(None);
                }
                if bytes.len() + count > MAX_FILE_BYTES {
                    self.skip("oversized", true, true);
                    return Ok(None);
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            let started = self.profile.start();
            self.hash.update(Sha256::digest(&bytes));
            self.profile.record("contentHash", started);
            Ok(Some(bytes))
        })();
        match read {
            Ok(value) => value,
            Err(_) => {
                self.skip("read-error", true, true);
                None
            }
        }
    }
    pub fn walk<F>(
        &mut self,
        root: &Path,
        patterns: &[String],
        request: &Request,
        mut each: F,
    ) -> Result<()>
    where
        F: FnMut(&Path, &cap_std::fs::Metadata, &mut Self) -> Result<()>,
    {
        self.source = SourceKind::Walk;
        let started = self.profile.start();
        let result = (|| {
            let compiled = self.profile.start();
            let patterns = patterns::Patterns::new(patterns);
            self.profile.record("globCompile", compiled);
            request.authorize_path(root)?;
            if !self.running() {
                return Ok(());
            }
            let target = file_path::checked(
                root.to_str()
                    .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?,
            )?;
            let metadata = target.parent.symlink_metadata(&target.name)?;
            self.stamp(root, &metadata);
            if metadata.is_file() {
                self.scanned += 1;
                return each(root, &metadata, self);
            }
            let directory = target.parent.open_dir_nofollow(&target.name)?;
            self.visit(root, root, directory, 0, &patterns, request, &mut each)
        })();
        self.profile.record("walkTotal", started);
        result
    }

    /// Traversal through a data source, with the live walk as the fallback.
    ///
    /// The source is chosen once by the caller and consulted once here:
    /// `candidates::collect` asks for its state once and enumerates once. A
    /// source that is not ready, that fails, or whose candidates cannot be
    /// revalidated makes this method fall back to [`Scan::walk`], which is the
    /// only way to produce a complete answer in that situation. The returned
    /// [`SourceKind`] is what the caller must bind into the request's cursor.
    ///
    /// Both paths use the same accounting (`scanned`, `skipped`, `reasons`,
    /// `failed`, `entries`, `stopped`), the same pattern filter, the same
    /// `each` callback and therefore the same output. `NullSource` is the
    /// default for a build with no platform source: it is never ready, so this
    /// is exactly the walk.
    ///
    /// # Snapshot domain
    ///
    /// The two paths do not stamp the same snapshot: the walk stamps the root
    /// and every directory it visits, while the indexed path stamps only the
    /// revalidated candidate files. Snapshot ids therefore belong to one source
    /// domain, which `paging::Cursor` binds by kind; items and counters are
    /// comparable across paths only when both answers are complete.
    ///
    /// # Errors
    ///
    /// Returns the walk's error unchanged (authority, root, or an unreadable
    /// root directory); a falling-back source is never an error.
    pub fn walk_indexed<F>(
        &mut self,
        root: &Path,
        source: &dyn FsDataSource,
        patterns: &[String],
        request: &Request,
        mut each: F,
    ) -> Result<SourceKind>
    where
        F: FnMut(&Path, &cap_std::fs::Metadata, &mut Self) -> Result<()>,
    {
        // Authorization precedes enumeration: a source must never be asked for
        // candidates under a root the operator policy refuses. The walk fallback
        // re-authorizes on its own path, so both branches check before they
        // observe anything.
        request.authorize_path(root)?;
        let started = self.profile.start();
        let kind = if self.running() {
            // One decision per request: the source's own deadline is the scan's
            // remaining budget, so index work can never outlive the scan.
            let budget = EnumBudget::with_timeout(MAX_WALK_ENTRIES, MAX_DEPTH, self.remaining());
            match candidates::collect(root, request, source, budget) {
                Outcome::Ready(batch) => {
                    self.apply_batch(root, patterns, &batch, &mut each)?;
                    SourceKind::Index
                }
                Outcome::Fallback(_) => {
                    self.walk(root, patterns, request, each)?;
                    SourceKind::Walk
                }
            }
        } else {
            SourceKind::Walk
        };
        self.source = kind;
        self.profile.record("walkTotal", started);
        Ok(kind)
    }

    /// Applies a revalidated candidate batch with the walk's exact accounting.
    ///
    /// The batch carries only surviving files and explicit skips; directories
    /// were traversal state and never became items. Entries are replayed in
    /// component order, the order the walk visits them, so the `scanned` /
    /// `skipped` cut-off at `max_files` and the skip counts match the walk
    /// byte for byte.
    fn apply_batch<F>(
        &mut self,
        root: &Path,
        patterns: &[String],
        batch: &candidates::Batch,
        each: &mut F,
    ) -> Result<()>
    where
        F: FnMut(&Path, &cap_std::fs::Metadata, &mut Self) -> Result<()>,
    {
        // `walk_indexed` authorized `root` before the source was consulted; do
        // not re-check here, so the decision happens exactly once.
        let compiled = self.profile.start();
        let patterns = patterns::Patterns::new(patterns);
        self.profile.record("globCompile", compiled);
        self.entries += batch.entries;
        // A truncated (or oversized) source still lists the rows it has; only
        // after they are applied is the answer marked incomplete, exactly like
        // a walk that stops at its own budget.
        let truncated = batch.truncated || batch.entries > MAX_WALK_ENTRIES;
        let fresh_len = batch.fresh.len();
        let mut ordered: Vec<(&Path, usize)> = Vec::with_capacity(fresh_len + batch.skipped.len());
        for (index, fresh) in batch.fresh.iter().enumerate() {
            ordered.push((fresh.candidate.rel.as_path(), index));
        }
        for (index, skip) in batch.skipped.iter().enumerate() {
            ordered.push((skip.rel.as_path(), fresh_len + index));
        }
        ordered.sort_by(|left, right| left.0.cmp(right.0));
        for (_, slot) in ordered {
            if !self.running() {
                break;
            }
            if slot < fresh_len {
                let fresh = &batch.fresh[slot];
                if !fresh.candidate.is_file() {
                    continue;
                }
                if self.scanned >= self.max_files {
                    self.skip("file-limit", true, true);
                    self.stopped = Some(TruncatedBy::ScanBudget);
                    break;
                }
                self.scanned += 1;
                let started = self.profile.start();
                let matched = patterns.matches(root, &fresh.path);
                self.profile.record("globFilter", started);
                if !matched {
                    self.skip("pattern", true, false);
                    continue;
                }
                self.stamp(&fresh.path, &fresh.metadata);
                each(&fresh.path, &fresh.metadata, self)?;
            } else {
                let skip = &batch.skipped[slot - fresh_len];
                self.skip(skip.reason.as_str(), skip.file, skip.gap());
            }
        }
        if truncated && self.stopped.is_none() {
            self.stopped = Some(TruncatedBy::ScanBudget);
        }
        Ok(())
    }
    // The walk context is fixed for the whole traversal; bundling these into a
    // struct would only move the same values through an extra indirection.
    #[allow(clippy::too_many_arguments)]
    fn visit<F>(
        &mut self,
        root: &Path,
        display: &Path,
        directory: cap_std::fs::Dir,
        depth: usize,
        patterns: &patterns::Patterns<'_>,
        request: &Request,
        each: &mut F,
    ) -> Result<()>
    where
        F: FnMut(&Path, &cap_std::fs::Metadata, &mut Self) -> Result<()>,
    {
        if !self.running() {
            return Ok(());
        }
        if depth > self.max_depth {
            self.skip("depth-limit", false, true);
            return Ok(());
        }
        let mut entries = match read_entries(&directory, display) {
            Ok(entries) => entries,
            Err(error) if depth == 0 => return Err(error),
            Err(_) => {
                self.skip("unreadable-directory", false, true);
                return Ok(());
            }
        };
        let mut names = Vec::new();
        while let Some(entry) = entries.next_name() {
            if !self.running() {
                break;
            }
            self.entries += 1;
            if self.entries > MAX_WALK_ENTRIES {
                self.skip("entry-limit", false, true);
                self.stopped = Some(TruncatedBy::ScanBudget);
                break;
            }
            match entry {
                Ok(name) => names.push(name),
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    self.skip("non-utf8-path", false, true)
                }
                Err(_) => self.skip("unreadable-entry", false, true),
            }
        }
        #[cfg(windows)]
        if unc_display(display) {
            unchanged_directory(&directory, display)?;
        }
        names.sort();
        for name in names {
            if !self.running() {
                break;
            }
            let child = display.join(&name);
            // Reserved audit entries remain intentional exclusions, not scan gaps.
            if name.eq_ignore_ascii_case(ops_files::paths::STORE) {
                let file = directory
                    .symlink_metadata(&name)
                    .is_ok_and(|metadata| metadata.is_file());
                self.skip("excluded", file, false);
                continue;
            }
            if file_path::validate_name(&name).is_err()
                || (request.windows_paths
                    && ops_protocol::windows_paths::validate_name(&name).is_err())
            {
                self.skip("invalid-path", false, true);
                continue;
            }
            let started = self.profile.start();
            let metadata = directory.symlink_metadata(&name);
            self.profile.record("relativeMetadata", started);
            let metadata = match metadata {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.skip("unreadable-entry", false, true);
                    continue;
                }
            };
            let file = metadata.is_file();
            if request.denies_path(&child) {
                self.skip("credential", file, false);
                continue;
            }
            let started = self.profile.start();
            let host = fs::symlink_metadata(&child);
            self.profile.record("absoluteMetadata", started);
            let host = match host {
                Ok(metadata) => metadata,
                Err(_) => {
                    self.skip("unreadable-entry", file, true);
                    continue;
                }
            };
            #[cfg(windows)]
            let reparse = host.file_attributes() & 0x400 != 0;
            #[cfg(not(windows))]
            let reparse = false;
            if file_path::link(&metadata) || host.file_type().is_symlink() || reparse {
                self.skip("symlink", file, false);
                continue;
            }
            if hidden(&child, root) || matches!(name.as_str(), "node_modules" | "target" | ".venv")
            {
                self.skip("excluded", file, false);
                continue;
            }
            if file {
                if self.scanned >= self.max_files {
                    self.skip("file-limit", true, true);
                    self.stopped = Some(TruncatedBy::ScanBudget);
                    break;
                }
                self.scanned += 1;
                let started = self.profile.start();
                let matched = patterns.matches(root, &child);
                self.profile.record("globFilter", started);
                if !matched {
                    self.skip("pattern", true, false);
                    continue;
                }
                self.stamp(&child, &metadata);
                each(&child, &metadata, self)?;
            } else if metadata.is_dir() {
                self.stamp(&child, &metadata);
                match directory.open_dir_nofollow(&name) {
                    Ok(next) => {
                        self.visit(root, &child, next, depth + 1, patterns, request, each)?
                    }
                    Err(_) => self.skip("unreadable-directory", false, true),
                }
            } else {
                self.skip("unsupported-entry", false, false);
            }
        }
        Ok(())
    }
}

impl Default for Scan {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[path = "scan_tests.rs"]
mod scan_tests;
