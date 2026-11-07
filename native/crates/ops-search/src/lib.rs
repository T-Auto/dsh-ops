//! File search orchestration over the shared no-follow file primitives.
#![forbid(unsafe_code)]
pub mod candidates;
mod definitions;
pub mod index_source;
mod paging;
mod patterns;
mod profile;
pub mod scan;
mod search;
use cap_fs_ext::DirExt;
#[cfg(windows)]
use cap_fs_ext::MetadataExt;
use ops_files as publication;
use ops_files::{
    MAX_FILE_BYTES, MAX_OUTPUT_BYTES, atomic_write, file_path, lock_and_read_for_update,
    read_bytes, relative_display, result, target,
};
use ops_protocol::{Failure, Request, Result};
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as WindowsMetadataExt;
use std::{
    fs,
    path::{Path, PathBuf},
};
const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 128;
fn one_hundred() -> usize {
    100
}
fn yes() -> bool {
    true
}

pub fn dispatch(request: &Request) -> Result<Value> {
    if let Some(raw) = request.args.get("path").and_then(Value::as_str) {
        request.authorize_path(Path::new(raw))?;
    }
    match request.tool.as_str() {
        "glob" => search::glob(request),
        "grep" => search::grep(request),
        "replace" => replace(request),
        _ => Err(Failure::new(
            "INVALID_ARGUMENT",
            "Unknown search capability",
        )),
    }
    .map_err(|mut error| {
        error.message = format!("{}: {}", request.tool, error.message);
        error
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReplaceArgs {
    path: String,
    pattern: String,
    replacement: String,
    #[serde(default)]
    glob: Vec<String>,
    #[serde(default = "one_hundred")]
    max_replacements: usize,
    #[serde(default)]
    dry_run: bool,
}
fn hidden(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .into_iter()
        .flat_map(|p| p.components())
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}
fn host_link_or_reparse(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return true;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 {
        return true;
    }
    false
}
struct WalkResult {
    files: Vec<PathBuf>,
    truncated: bool,
}

fn walk(root: &Path, request: &Request) -> Result<WalkResult> {
    request.authorize_path(root)?;
    let target = crate::file_path::checked(
        root.to_str()
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?,
    )?;
    let directory = target.parent.open_dir_nofollow(&target.name)?;
    let mut files = Vec::new();
    let mut truncated = false;
    visit_dir(
        root,
        root,
        directory,
        0,
        request,
        &mut files,
        &mut truncated,
    )?;
    Ok(WalkResult { files, truncated })
}
fn visit_dir(
    root: &Path,
    display: &Path,
    directory: cap_std::fs::Dir,
    depth: usize,
    request: &Request,
    output: &mut Vec<PathBuf>,
    truncated: &mut bool,
) -> Result<()> {
    if depth > MAX_DEPTH || output.len() >= MAX_ENTRIES {
        *truncated = true;
        return Ok(());
    }
    // A directory can change while it is being read. A broken child directory
    // is skipped, while failure to enumerate the requested root remains visible.
    let mut entries = match read_entries(&directory, display) {
        Ok(entries) => entries,
        Err(error) if depth == 0 => return Err(error),
        Err(_) => return Ok(()),
    };
    let mut names = Vec::new();
    while let Some(name) = entries.next_name() {
        if let Ok(name) = name {
            names.push(name);
        }
    }
    #[cfg(windows)]
    if unc_display(display) {
        unchanged_directory(&directory, display)?;
    }
    names.sort();
    for name in names {
        if crate::file_path::validate_name(&name).is_err() || name == ".git" {
            continue;
        }
        let metadata = match directory.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if crate::file_path::link(&metadata) {
            continue;
        }
        let child = display.join(&name);
        if host_link_or_reparse(&child) {
            continue;
        }
        // A denied root is skipped by identity, not by name: the host names the
        // credential locations and the worker stays out of them entirely, so a
        // traversal cannot even report a private key below one.
        if request.denies_path(&child) {
            continue;
        }
        if hidden(&child, root)
            || matches!(
                name.as_str(),
                ".git" | ".dsh-ops" | "node_modules" | "target" | ".venv"
            )
        {
            continue;
        }
        if metadata.is_file() {
            if output.len() >= MAX_ENTRIES {
                *truncated = true;
                return Ok(());
            }
            output.push(child);
            continue;
        }
        if metadata.is_dir() {
            let Ok(child_dir) = directory.open_dir_nofollow(&name) else {
                continue;
            };
            visit_dir(
                root,
                &child,
                child_dir,
                depth + 1,
                request,
                output,
                truncated,
            )?;
            if *truncated && output.len() >= MAX_ENTRIES {
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Entry names of one directory. The caller sorts them.
///
/// cap-std's Windows enumerator maps the open handle back to a path, strips a
/// four-character `\\?\` prefix and joins `.`. For the verbatim
/// `\\?\UNC\server\share` form that leaves the relative `UNC\server\share`, so
/// `Dir::entries` fails with `ERROR_PATH_NOT_FOUND` on every UNC directory
/// (cap-std issue #348). The walk only needs names here: every candidate is
/// still checked and opened through the no-follow handle, so a UNC directory is
/// enumerated through its absolute path while the handle keeps driving the
/// traversal. cap-std's own Windows enumerator is path-based after mapping the
/// handle, so this adds no path step it did not already take.
pub(crate) enum DirectoryEntries {
    #[cfg(windows)]
    Ambient(std::fs::ReadDir),
    Handle(cap_std::fs::ReadDir),
}
impl DirectoryEntries {
    fn next_name(&mut self) -> Option<std::io::Result<String>> {
        match self {
            #[cfg(windows)]
            Self::Ambient(entries) => entries.next().map(|entry| {
                entry.and_then(|entry| entry.file_name().into_string().map_err(|_| non_utf8_name()))
            }),
            Self::Handle(entries) => entries.next().map(|entry| {
                entry.and_then(|entry| entry.file_name().into_string().map_err(|_| non_utf8_name()))
            }),
        }
    }
}
fn non_utf8_name() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, "Non-UTF8 path")
}
pub(crate) fn read_entries(
    directory: &cap_std::fs::Dir,
    display: &Path,
) -> Result<DirectoryEntries> {
    #[cfg(not(windows))]
    let _ = display;
    #[cfg(windows)]
    if unc_display(display) {
        unchanged_directory(directory, display)?;
        return Ok(DirectoryEntries::Ambient(fs::read_dir(display)?));
    }
    Ok(DirectoryEntries::Handle(directory.entries()?))
}

/// Fail when `display` no longer resolves to the directory `directory` holds.
///
/// The UNC enumeration reads names through the display path while every
/// per-entry check uses the opened handle. A rename plus a new directory at the
/// old path would mix those two views and could report a complete empty scan.
#[cfg(windows)]
fn unchanged_directory(directory: &cap_std::fs::Dir, display: &Path) -> Result<()> {
    let current = cap_std::fs::Dir::open_ambient_dir(display, cap_std::ambient_authority())?;
    let held = directory.dir_metadata()?;
    let current = current.dir_metadata()?;
    if held.dev() != current.dev() || held.ino() != current.ino() {
        return Err(Failure::new(
            "PATH_CHANGED",
            "The directory changed while it was being enumerated; no complete result is available. Restart the query.",
        ));
    }
    Ok(())
}

/// Whether `display` names a UNC share: `\\server\share`, `//server/share`, or
/// the verbatim `\\?\UNC\server\share` form.
#[cfg(windows)]
fn unc_display(display: &Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(
        display.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..))
    )
}

fn files_for(path: &str, patterns: &[String], request: &Request) -> Result<WalkResult> {
    let root = target(path, false)?;
    request.authorize_path(&root)?;
    if root.is_file() {
        return Ok(WalkResult {
            files: vec![root.clone()],
            truncated: false,
        });
    }
    let walked = walk(&root, request)?;
    let patterns = patterns::Patterns::new(patterns);
    Ok(WalkResult {
        files: walked
            .files
            .into_iter()
            .filter(|f| patterns.matches(&root, f))
            .collect(),
        truncated: walked.truncated,
    })
}
fn glob_segments(p: &[&str], v: &[&str]) -> bool {
    if p.is_empty() {
        return v.is_empty();
    }
    if p[0] == "**" {
        return glob_segments(&p[1..], v) || (!v.is_empty() && glob_segments(p, &v[1..]));
    }
    !v.is_empty() && segment_match(p[0], v[0]) && glob_segments(&p[1..], &v[1..])
}
fn segment_match(pattern: &str, value: &str) -> bool {
    let (mut pi, mut vi, mut star, mut mark) = (0usize, 0usize, None, 0usize);
    let p = pattern.as_bytes();
    let v = value.as_bytes();
    while vi < v.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi].eq_ignore_ascii_case(&v[vi])) {
            pi += 1;
            vi += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            mark = vi;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            vi = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}
/// Check the UTF-8 byte expansion before allocating replacement text or publishing any file.
fn replacement_size(
    before: usize,
    pattern: usize,
    replacement: usize,
    count: usize,
) -> Result<usize> {
    let size = pattern
        .checked_mul(count)
        .and_then(|removed| before.checked_sub(removed))
        .and_then(|kept| {
            replacement
                .checked_mul(count)
                .and_then(|added| kept.checked_add(added))
        });
    match size {
        Some(size) if size as u64 <= MAX_FILE_BYTES => Ok(size),
        _ => Err(Failure::new(
            "OUTPUT_LIMIT",
            "Proposed replacement exceeds 32 MiB; narrow path/glob or reduce replacement size. No file was changed.",
        )),
    }
}
fn replace(request: &Request) -> Result<Value> {
    if request.read_only {
        return Err(Failure::policy(
            "read-only",
            "replace is unavailable in read-only mode",
        ));
    }
    let args: ReplaceArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.max_replacements == 0 || args.max_replacements > 100_000 {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "pattern and maxReplacements are required",
        ));
    }
    let walked = files_for(&args.path, &args.glob, request)?;
    let mut plans = Vec::new();
    let mut total = 0usize;
    let mut binary: Vec<PathBuf> = Vec::new();
    // A directory that holds one binary file (an icon, an archive) is a normal repository, not a
    // malformed request: the binary is reported as skipped and the text files around it are still
    // edited. Failing the whole call on the first non-UTF-8 byte made a routine directory edit
    // impossible, and the error named no file, so the caller could not even narrow the request.
    let mut update_guards = Vec::new();
    for file in walked.files {
        // Serialize observation as well as publication. On APFS an open racing
        // an unlink/rename can fail ENOENT on the superseded vnode even though
        // the directory name always has a complete version. Do not retry or
        // relabel ENOENT: avoid the race between cooperating writers instead.
        let (guard, bytes) = if args.dry_run {
            (None, read_bytes(&file)?)
        } else {
            let (guard, bytes) = lock_and_read_for_update(&file)?;
            (Some(guard), bytes)
        };
        match String::from_utf8(bytes.clone()) {
            Ok(text) => {
                let count = text.match_indices(&args.pattern).count();
                if count > 0 {
                    replacement_size(
                        bytes.len(),
                        args.pattern.len(),
                        args.replacement.len(),
                        count,
                    )?;
                    total = total.checked_add(count).ok_or_else(|| {
                        Failure::new(
                            "OUTPUT_LIMIT",
                            "Replacement count overflow; no file was changed.",
                        )
                    })?;
                    plans.push((file, bytes, text, count));
                    update_guards.push(guard);
                }
            }
            Err(_) => binary.push(file),
        }
    }
    let skipped = binary.len();
    let skipped_paths: Vec<Value> = binary
        .iter()
        .take(8)
        .map(|file| json!(relative_display(&request.root_path(), file)))
        .collect();
    if total > args.max_replacements {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            format!(
                "{total} matches exceed maxReplacements ({}); no file was changed. maxReplacements is a ceiling, not a truncation: raise it to {total} or more and retry.",
                args.max_replacements
            ),
        ));
    }
    let mut items = Vec::new();
    for (file, original, text, count) in plans {
        let revision = format!("{:x}", Sha256::digest(&original));
        let next = text.replace(&args.pattern, &args.replacement);
        items.push(json!({"path":file,"replacements":count,"revision":revision,"revisionAfter":format!("{:x}", Sha256::digest(next.as_bytes())),"bytesBefore":original.len(),"bytesAfter":next.len(),"lineCountBefore":text.lines().count(),"lineCount":next.lines().count()}));
    }
    if serde_json::to_vec(&items)?.len() > MAX_OUTPUT_BYTES / 2 {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "Replacement receipts exceed the bounded output budget; narrow path/glob. No files changed.",
        ));
    }
    if args.dry_run {
        return Ok(
            json!({"status":"completed","phase":"observe","changed":0,"matched":total,"skipped":skipped,"failed":0,"complete":true,"omitted":0,"dryRun":true,"items":items,"skippedPaths":skipped_paths}),
        );
    }
    for item in &items {
        publication::authorize_write(request, item["path"].as_str().unwrap_or(""))?;
    }
    for item in &mut items {
        item["status"] = json!("pending");
    }
    let mut changed = 0usize;
    for index in 0..items.len() {
        let item = &mut items[index];
        let applied = (|| -> Result<()> {
            let file = PathBuf::from(item["path"].as_str().unwrap_or(""));
            publication::authorize_write(request, file.to_str().unwrap_or(""))?;
            // Observation guards above remain owned until every publication settles.
            let bytes = read_bytes(&file)?;
            // The revision is checked against the bytes the lock returned, so the check
            // and the write cannot be separated by another open — see the lock for why.
            let expected = item["revision"].as_str().unwrap_or("");
            publication::check_revision(Some(&bytes), expected)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                Failure::new("ERR_INVALID_ENCODING", "Replace only supports UTF-8 files")
            })?;
            let next = text.replace(&args.pattern, &args.replacement);
            // Report what the replacement kept. The fields are additive, so a caller
            // that ignores them sees exactly the envelope it saw before.
            if let Some((metadata, warnings)) = atomic_write(&file, next.as_bytes())? {
                item["metadata"] = metadata;
                if !warnings.is_empty() {
                    item["metadataWarnings"] = json!(warnings);
                }
            }
            Ok(())
        })();
        if let Err(mut error) = applied {
            // Retain the failing item's own effects before describing the whole call.
            item["status"] = json!("error");
            item["error"] = serde_json::to_value(&error)?;
            if changed > 0 {
                if error.effect_state.as_ref() != "unknown" {
                    error.effect_state = "applied".into();
                }
                error.next_action = "Earlier files were already replaced. Inspect every retained receipt and postcondition; do not repeat the batch blindly.".into();
            }
            return Ok(
                json!({"status":"error","complete":false,"changed":changed,"failed":1,
                "pending":items.len()-index-1,"effectState":error.effect_state,"error":error,
                "items":items,"skipped":skipped,"skippedPaths":skipped_paths}),
            );
        }
        item["status"] = json!("completed");
        changed += item["replacements"].as_u64().unwrap_or(0) as usize;
    }
    let count = items.len();
    let mut output = result(request, items, count, 0, 0, total, walked.truncated);
    output["changed"] = json!(changed);
    output["skipped"] = json!(skipped);
    // Do not let optional skipped path names defeat the serialized receipt budget.
    output["skippedPaths"] = if serde_json::to_vec(&output)?.len() < MAX_OUTPUT_BYTES / 2 {
        json!(skipped_paths)
    } else {
        json!([])
    };
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[cfg(windows)]
    #[test]
    fn unc_shares_use_absolute_enumeration() {
        for unc in [
            r"\\server\share\dir",
            r"\\?\UNC\server\share\dir",
            "//server/share/dir",
        ] {
            assert!(unc_display(Path::new(unc)), "{unc} names a UNC share");
        }
        for local in [
            r"C:\dir",
            r"\\?\C:\dir",
            r"\\?\Volume{b75e2c83-0000-0000-0000-602f00000000}\dir",
        ] {
            assert!(
                !unc_display(Path::new(local)),
                "{local} does not name a UNC share"
            );
        }
    }

    /// The UNC workaround enumerates by display path but checks entries through
    /// the opened handle; a replacement directory at the old path must not be
    /// mistaken for the one held open.
    #[cfg(windows)]
    #[test]
    fn moved_directory_is_not_the_directory_held_open() {
        let fixture = Fixture::new("moved-directory");
        let live = fixture.root.join("live");
        std::fs::create_dir(&live).unwrap();
        let held = {
            use std::os::windows::fs::OpenOptionsExt;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(7)
                .custom_flags(0x02000000)
                .open(&live)
                .unwrap();
            cap_std::fs::Dir::from_std_file(file)
        };
        unchanged_directory(&held, &live).unwrap();
        std::fs::rename(&live, fixture.root.join("moved")).unwrap();
        std::fs::create_dir(&live).unwrap();
        let error = unchanged_directory(&held, &live).unwrap_err();
        assert_eq!(error.code, "PATH_CHANGED");
    }

    /// Run against a real share with `DSH_OPS_UNC_TEST_ROOT` pointing at a
    /// writable UNC directory. cap-std's handle-to-path round trip used to turn
    /// this into a relative `UNC\...` path and fail with `ERROR_PATH_NOT_FOUND`.
    #[cfg(windows)]
    #[test]
    #[ignore = "requires DSH_OPS_UNC_TEST_ROOT to name a writable UNC directory"]
    fn unc_directory_is_walked_for_glob_grep_and_replace() {
        let root = std::env::var("DSH_OPS_UNC_TEST_ROOT")
            .expect("set DSH_OPS_UNC_TEST_ROOT to a writable UNC directory");
        let fixture =
            PathBuf::from(&root).join(format!("dsh-ops-unc-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&fixture).unwrap();
        std::fs::write(fixture.join("a.txt"), b"alpha\n").unwrap();
        std::fs::write(fixture.join("b.txt"), b"alpha\n").unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(fixture.clone());
        let fixture = fixture.to_str().unwrap().to_string();
        let run = |tool: &str, args: serde_json::Value| {
            let request = serde_json::from_value(
                json!({"root": root, "scope": "unc-test", "tool": tool, "args": args}),
            )
            .unwrap();
            dispatch(&request).unwrap()
        };
        let glob = run("glob", json!({"path": fixture, "pattern": ["*"]}));
        assert_eq!(glob["status"], "completed", "{glob}");
        assert_eq!(glob["items"].as_array().map(Vec::len), Some(2), "{glob}");
        let grep = run(
            "grep",
            json!({"path": fixture, "pattern": "alpha", "glob": ["*.txt"]}),
        );
        assert_eq!(grep["status"], "completed", "{grep}");
        assert_eq!(grep["matched"], 2, "{grep}");
        let replace = run(
            "replace",
            json!({"path": fixture, "pattern": "alpha", "replacement": "beta",
            "glob": ["*.txt"], "dryRun": true}),
        );
        assert_eq!(replace["status"], "completed", "{replace}");
        assert_eq!(replace["dryRun"], true, "{replace}");
        assert_eq!(replace["matched"], 2, "{replace}");
    }

    #[test]
    fn replacement_byte_budget_handles_boundary_shrink_and_checked_arithmetic() {
        assert_eq!(
            replacement_size(32_768, 1, 1024, 32_768).unwrap() as u64,
            MAX_FILE_BYTES
        );
        assert_eq!(
            replacement_size(32_769, 1, 1024, 32_768).unwrap_err().code,
            "OUTPUT_LIMIT"
        );
        assert_eq!(replacement_size(8, 2, 0, 4).unwrap(), 0);
        assert_eq!(replacement_size(8, 2, 2, 4).unwrap(), 8);
        assert_eq!(
            replacement_size(4, 1, usize::MAX, 2).unwrap_err().code,
            "OUTPUT_LIMIT"
        );
        assert_eq!(
            replacement_size(usize::MAX, 1, 2, 1).unwrap_err().code,
            "OUTPUT_LIMIT"
        );
        assert_eq!(
            replacement_size(4, usize::MAX, 1, 2).unwrap_err().code,
            "OUTPUT_LIMIT"
        );
    }

    /// One private fixture directory under the canonical ambient temp root.
    ///
    /// The no-follow traversal refuses linked ancestry, and `TMPDIR` sits behind
    /// one on Darwin, so the ambient root is resolved before anything is created —
    /// the reason `single::tests::copy_changed_source_is_not_published` does the
    /// same.
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = std::fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("dsh-ops-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }
        /// Write one fixture file and stamp it with `modified_ms` since the epoch.
        fn file(&self, name: &str, bytes: &[u8], modified_ms: u64) -> PathBuf {
            let path = self.root.join(name);
            std::fs::write(&path, bytes).unwrap();
            let stamp = UNIX_EPOCH + Duration::from_millis(modified_ms);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_accessed(stamp).set_modified(stamp))
                .unwrap();
            path
        }
        /// The sidecar `lock_and_read_for_update` creates for `name`.
        fn sidecar(&self, name: &str) -> PathBuf {
            self.root.join(format!(
                ".dsh-ops-update-{:x}.lock",
                Sha256::digest(name.to_lowercase().as_bytes())
            ))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// #236: `modified` was `metadata.len()`, so every `details` item reported
    /// `modified == bytes` and `sort: "modified"` ordered by size. The fixtures
    /// are inverted on purpose — the larger file is the older one — so a
    /// size-based key reverses them.
    fn listing(fixture: &Fixture, offset: usize, limit: usize) -> Value {
        let request = serde_json::from_value(json!({"root":fixture.root,"scope":"mtime-test","tool":"glob",
            "args":{"path":fixture.root,"pattern":["*.txt"],"sort":"modified","outputMode":"details","offset":offset,"limit":limit}})).unwrap();
        dispatch(&request).unwrap()
    }
    #[test]
    fn modified_is_epoch_milliseconds_and_ordering_ignores_size() {
        let fixture = Fixture::new("glob-modified");
        fixture.file("a-old-big.txt", &[b'x'; 8192], 1_600_000_000_000);
        fixture.file("z-new-small.txt", b"tiny", 1_600_000_120_000);
        let output = listing(&fixture, 0, 10);
        let items = output["items"].as_array().unwrap();
        assert!(
            items[0]["path"]
                .as_str()
                .unwrap()
                .ends_with("z-new-small.txt")
        );
        assert_eq!(items[0]["bytes"], 4);
        assert_eq!(items[1]["bytes"], 8192);
        for (item, expected) in items
            .iter()
            .zip([1_600_000_120_000_i128, 1_600_000_000_000_i128])
        {
            let actual = item["modified"].as_u64().unwrap() as i128;
            assert!(
                (actual - expected).abs() <= 1_000,
                "expected epoch milliseconds, got {actual}"
            );
        }
    }
    #[test]
    fn equal_timestamps_keep_the_candidate_order() {
        let fixture = Fixture::new("glob-modified-tie");
        for name in ["c.txt", "a.txt", "b.txt"] {
            fixture.file(name, name.as_bytes(), 1_600_000_000_000);
        }
        for (offset, name) in ["a.txt", "b.txt", "c.txt"].iter().enumerate() {
            let page = listing(&fixture, offset, 1);
            assert!(page["items"][0]["path"].as_str().unwrap().ends_with(name));
        }
    }

    /// #319: the update lock used to leave a permanent 0-byte sidecar beside the
    /// target. It is still taken before the target is read — a refused request
    /// therefore runs under the lock — but releasing it now removes the sidecar.
    /// A leftover from a killed writer is reused instead of ignored, and removed by
    /// the writer that finishes under it.
    #[test]
    fn the_update_lock_is_taken_before_the_read_and_leaves_no_sidecar() {
        let fixture = Fixture::new("update-lock");
        let target = fixture.file("notes.txt", b"one", 1_600_000_000_000);
        let sidecar = fixture.sidecar("notes.txt");
        assert!(
            !sidecar.exists(),
            "no sidecar before the first update attempt"
        );
        {
            let (guard, bytes) = lock_and_read_for_update(&target).unwrap();
            assert_eq!(bytes, b"one", "the lock is taken before the target is read");
            assert!(sidecar.is_file(), "the lock exists while it is held");
            assert_eq!(
                fs::metadata(&sidecar).unwrap().len(),
                0,
                "the sidecar carries no payload"
            );
            drop(guard);
        }
        assert!(!sidecar.exists(), "releasing the lock removes the sidecar");
        // A refusal decided from the bytes happens under the lock and leaves no trace.
        let missing = fixture.root.join("missing.txt");
        assert_eq!(
            lock_and_read_for_update(&missing).unwrap_err().code,
            "NOT_FOUND"
        );
        assert!(
            !fixture.sidecar("missing.txt").exists(),
            "a refused operation leaves no sidecar"
        );
        assert_eq!(
            fs::read_dir(&fixture.root).unwrap().count(),
            1,
            "one target and no artifacts"
        );
        // A sidecar a killed writer left behind is reused and then removed.
        fs::write(&sidecar, b"").unwrap();
        drop(lock_and_read_for_update(&target).unwrap());
        assert!(
            !sidecar.exists(),
            "a later write cleans up the leftover it reused"
        );
    }
}
