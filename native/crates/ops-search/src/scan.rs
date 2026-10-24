//! Bounded, no-follow traversal. Declared exclusions differ from unobserved gaps.
use super::*;
use cap_fs_ext::MetadataExt;
use ops_protocol::search::TruncatedBy;
use std::{collections::BTreeMap, io::Read, time::{Duration, Instant, UNIX_EPOCH}};

pub const MAX_SCAN_FILES: usize = 10_000;
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SCAN_BYTES: usize = 256 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_WALK_ENTRIES: usize = 100_000;

pub struct Scan {
    pub scanned: usize,
    pub skipped: usize,
    pub reasons: BTreeMap<String, usize>,
    pub gap: bool,
    pub failed: usize,
    pub stopped: Option<TruncatedBy>,
    pub hash: Sha256,
    started: Instant,
    timeout: Duration,
    max_files: usize,
    entries: usize,
    bytes: usize,
}
impl Scan {
    pub fn new() -> Self {
        Self { scanned: 0, skipped: 0, reasons: BTreeMap::new(), gap: false, failed: 0, stopped: None,
            hash: Sha256::new(), started: Instant::now(), timeout: SCAN_TIMEOUT,
            max_files: MAX_SCAN_FILES, entries: 0, bytes: 0 }
    }
    pub fn running(&mut self) -> bool {
        if self.stopped.is_none() && self.started.elapsed() >= self.timeout { self.stopped = Some(TruncatedBy::Time); }
        self.stopped.is_none()
    }
    pub fn skip(&mut self, reason: &str, file: bool, gap: bool) {
        *self.reasons.entry(reason.into()).or_default() += 1;
        self.skipped += usize::from(file);
        self.gap |= gap;
        if gap && !matches!(reason, "oversized" | "invalid-encoding") { self.failed += 1; }
    }
    pub fn complete(&self) -> bool { !self.gap && self.stopped.is_none() }
    pub fn stamp(&mut self, path: &Path, metadata: &cap_std::fs::Metadata) {
        let modified = metadata.modified().ok().and_then(|time| time.into_std().duration_since(UNIX_EPOCH).ok()).map(|time| time.as_nanos());
        self.hash.update(serde_json::to_vec(&json!([path, metadata.dev(), metadata.ino(), metadata.len(), modified, metadata.is_dir()])).unwrap());
    }
    pub fn read(&mut self, path: &Path) -> Option<Vec<u8>> {
        let read = (|| -> Result<Option<Vec<u8>>> {
            let target = file_path::checked(path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?)?;
            let mut file = file_path::read_file(&target)?;
            if file.metadata()?.len() > MAX_FILE_BYTES as u64 { self.skip("oversized", true, true); return Ok(None); }
            let mut bytes = Vec::new(); let mut chunk = [0; 64 * 1024];
            loop {
                if !self.running() { return Ok(None); }
                let count = file.read(&mut chunk)?;
                if count == 0 { break; }
                self.bytes += count;
                if self.bytes > MAX_SCAN_BYTES { self.stopped = Some(TruncatedBy::ScanBudget); return Ok(None); }
                if bytes.len() + count > MAX_FILE_BYTES { self.skip("oversized", true, true); return Ok(None); }
                bytes.extend_from_slice(&chunk[..count]);
            }
            self.hash.update(Sha256::digest(&bytes));
            Ok(Some(bytes))
        })();
        match read { Ok(value) => value, Err(_) => { self.skip("read-error", true, true); None } }
    }
    pub fn walk<F>(&mut self, root: &Path, patterns: &[String], request: &Request, mut each: F) -> Result<()>
    where F: FnMut(&Path, &cap_std::fs::Metadata, &mut Self) -> Result<()> {
        request.authorize_path(root)?;
        if !self.running() { return Ok(()); }
        let target = file_path::checked(root.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?)?;
        let metadata = target.parent.symlink_metadata(&target.name)?;
        self.stamp(root, &metadata);
        if metadata.is_file() { self.scanned += 1; return each(root, &metadata, self); }
        let directory = target.parent.open_dir_nofollow(&target.name)?;
        self.visit(root, root, directory, 0, patterns, request, &mut each)
    }
    fn visit<F>(&mut self, root: &Path, display: &Path, directory: cap_std::fs::Dir, depth: usize, patterns: &[String], request: &Request, each: &mut F) -> Result<()>
    where F: FnMut(&Path, &cap_std::fs::Metadata, &mut Self) -> Result<()> {
        if !self.running() { return Ok(()); }
        if depth > MAX_DEPTH { self.stopped = Some(TruncatedBy::ScanBudget); return Ok(()); }
        let mut entries = match read_entries(&directory, display) {
            Ok(entries) => entries,
            Err(error) if depth == 0 => return Err(error),
            Err(_) => { self.skip("unreadable-directory", false, true); return Ok(()); }
        };
        let mut names = Vec::new();
        while let Some(entry) = entries.next_name() {
            if !self.running() { break; }
            self.entries += 1;
            if self.entries > MAX_WALK_ENTRIES { self.stopped = Some(TruncatedBy::ScanBudget); break; }
            match entry {
                Ok(name) => names.push(name),
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => self.skip("non-utf8-path", false, true),
                Err(_) => self.skip("unreadable-entry", false, true),
            }
        }
        #[cfg(windows)]
        if unc_display(display) { unchanged_directory(&directory, display)?; }
        names.sort();
        for name in names {
            if !self.running() { break; }
            let child = display.join(&name);
            // Reserved audit entries remain intentional exclusions, not scan gaps.
            if name.eq_ignore_ascii_case(ops_files::paths::STORE) {
                let file = directory.symlink_metadata(&name).is_ok_and(|metadata| metadata.is_file());
                self.skip("excluded", file, false);
                continue;
            }
            if file_path::validate_name(&name).is_err() { self.skip("invalid-path", false, true); continue; }
            let metadata = match directory.symlink_metadata(&name) {
                Ok(metadata) => metadata, Err(_) => { self.skip("unreadable-entry", false, true); continue; }
            };
            let file = metadata.is_file();
            if request.denies_path(&child) { self.skip("credential", file, false); continue; }
            let host = match fs::symlink_metadata(&child) {
                Ok(metadata) => metadata, Err(_) => { self.skip("unreadable-entry", file, true); continue; }
            };
            #[cfg(windows)]
            let reparse = host.file_attributes() & 0x400 != 0;
            #[cfg(not(windows))]
            let reparse = false;
            if file_path::link(&metadata) || host.file_type().is_symlink() || reparse { self.skip("symlink", file, false); continue; }
            if hidden(&child, root) || matches!(name.as_str(), "node_modules" | "target" | ".venv") { self.skip("excluded", file, false); continue; }
            if file {
                if self.scanned >= self.max_files { self.stopped = Some(TruncatedBy::ScanBudget); break; }
                self.scanned += 1;
                if !matches_any(root, &child, patterns) { self.skip("pattern", true, false); continue; }
                self.stamp(&child, &metadata);
                each(&child, &metadata, self)?;
            } else if metadata.is_dir() {
                self.stamp(&child, &metadata);
                match directory.open_dir_nofollow(&name) {
                    Ok(next) => self.visit(root, &child, next, depth + 1, patterns, request, each)?,
                    Err(_) => self.skip("unreadable-directory", false, true),
                }
            } else { self.skip("unsupported-entry", false, false); }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Request) {
        let root = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("dsh-search-budget-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        for name in ["a", "b", "c"] { fs::write(root.join(name), "hit\n").unwrap(); }
        let request = serde_json::from_value(json!({"root":root,"scope":"scan-test","tool":"grep","args":{}})).unwrap();
        (root, request)
    }
    #[test]
    fn file_entry_time_and_io_limits_never_claim_a_complete_scan() {
        let (root, request) = fixture();
        let mut scan = Scan::new(); scan.max_files = 2;
        let mut paths = Vec::new();
        scan.walk(&root, &[], &request, |path, _, _| { paths.push(path.file_name().unwrap().to_owned()); Ok(()) }).unwrap();
        assert_eq!(paths.len(), 2); assert_eq!(scan.scanned, 2);
        assert!(!scan.complete()); assert_eq!(scan.stopped, Some(TruncatedBy::ScanBudget));
        let report = super::super::paging::finish(scan, super::super::paging::Cursor::new(&request, 0, None).unwrap(),
            super::super::paging::Page::new(0, 1, None), paths.len(), paths.len(), json!({})).unwrap();
        assert_eq!(report["scanComplete"], false); assert!(report.get("matchedTotal").is_none());
        assert_eq!(report["truncatedBy"], "scan-budget"); assert!(report.get("continuation").is_none());
        assert!(report["nextAction"].as_str().unwrap().contains("Narrow"));
        let mut scan = Scan::new(); scan.entries = MAX_WALK_ENTRIES;
        scan.walk(&root, &[], &request, |_, _, _| panic!("entry limit must stop before file processing")).unwrap();
        assert!(!scan.complete()); assert_eq!(scan.stopped, Some(TruncatedBy::ScanBudget));
        let mut scan = Scan::new(); scan.timeout = Duration::ZERO;
        scan.walk(&root, &[], &request, |_, _, _| panic!("expired scan must not run")).unwrap();
        assert!(!scan.complete()); assert_eq!(scan.stopped, Some(TruncatedBy::Time));
        let mut scan = Scan::new(); scan.bytes = MAX_SCAN_BYTES;
        assert!(scan.read(&root.join("a")).is_none());
        assert!(!scan.complete()); assert_eq!(scan.stopped, Some(TruncatedBy::ScanBudget));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exclusions_are_counted_without_turning_them_into_unreadable_gaps() {
        let (root, request) = fixture();
        fs::write(root.join(".hidden"), "hit").unwrap();
        let mut scan = Scan::new();
        scan.walk(&root, &["a".into()], &request, |_, _, _| Ok(())).unwrap();
        assert!(scan.complete()); assert_eq!(scan.scanned, 3); assert_eq!(scan.skipped, 3);
        assert_eq!(scan.reasons["pattern"], 2); assert_eq!(scan.reasons["excluded"], 1);
        assert!(scan.read(&root.join("missing")).is_none());
        assert!(!scan.complete()); assert_eq!(scan.reasons["read-error"], 1);
        fs::remove_dir_all(root).unwrap();
    }
}
