//! Native file-operation capabilities. All paths are host-resolved absolute paths;
//! this module never invokes a shell and never follows links.
use crate::contract::{Failure, Request, Result};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use fs2::FileExt;
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as WindowsMetadataExt;

const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 128;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Ceiling for one worker response. The host collects worker stdout with
/// `maxBytes: 128 * 1024` and turns a lossy read into `OUTPUT_LIMIT` plus
/// `effectState: "unknown"`, so a response that overflows is reported to the model
/// as an operation whose effect cannot be known — for a pure read, that is both
/// false and useless. Staying under the host cap is what keeps a read honest.
/// The budget is spent on the *serialized* items rather than the payload, because
/// escaping is the multiplier: one NUL byte costs six as `\u0000`, which is how a
/// 32 MiB file once produced 200 MB of stdout.
const MAX_OUTPUT_BYTES: usize = 96 * 1024;
/// Non-item fields of the envelope, counted against the same ceiling.
const ENVELOPE_OVERHEAD: usize = 512;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InspectArgs {
    path: String,
    #[serde(default = "one")]
    offset: usize,
    #[serde(default = "two_hundred")]
    limit: usize,
    #[serde(default = "utf8")]
    encoding: String,
    #[serde(default = "text")]
    view: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GlobArgs {
    path: String,
    pattern: Vec<String>,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GrepArgs {
    path: String,
    pattern: String,
    #[serde(default)]
    glob: Vec<String>,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    case_insensitive: bool,
    #[serde(default = "yes")]
    line_numbers: bool,
    #[serde(default)]
    before_context: usize,
    #[serde(default)]
    after_context: usize,
    #[serde(default)]
    multiline: bool,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
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
fn one() -> usize { 1 }
fn two_hundred() -> usize { 200 }
fn one_hundred() -> usize { 100 }
fn yes() -> bool { true }
fn utf8() -> String { "utf-8".into() }
fn text() -> String { "text".into() }

pub fn dispatch(request: &Request) -> Result<Value> {
    if let Some(raw) = request.args.get("path").and_then(Value::as_str) { request.authorize_path(Path::new(raw))?; }
    match request.tool.as_str() {
        "inspect_local_file" => inspect(request),
        "glob" => glob(request),
        "grep" => grep(request),
        "replace" => replace(request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown file capability")),
    }
}

fn target(raw: &str, _allow_missing: bool) -> Result<PathBuf> {
    Ok(crate::file_path::checked(raw)?.display)
}
fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}
fn hidden(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).ok().into_iter().flat_map(|p| p.components()).any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}
fn host_link_or_reparse(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else { return true };
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 { return true; }
    false
}
struct WalkResult {
    files: Vec<PathBuf>,
    truncated: bool,
}

fn walk(root: &Path, request: &Request) -> Result<WalkResult> {
    request.authorize_path(root)?;
    let target = crate::file_path::checked(root.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?)?;
    let directory = target.parent.open_dir_nofollow(&target.name)?;
    let mut files = Vec::new();
    let mut truncated = false;
    visit_dir(root, root, directory, 0, request, &mut files, &mut truncated)?;
    Ok(WalkResult { files, truncated })
}
fn visit_dir(root: &Path, display: &Path, directory: cap_std::fs::Dir, depth: usize, request: &Request, output: &mut Vec<PathBuf>, truncated: &mut bool) -> Result<()> {
    if depth > MAX_DEPTH || output.len() >= MAX_ENTRIES {
        *truncated = true;
        return Ok(());
    }
    let mut names = Vec::new();
    // A directory can change while it is being read. A broken child directory
    // is skipped, while failure to enumerate the requested root remains visible.
    let entries = match directory.entries() {
        Ok(entries) => entries,
        Err(error) if depth == 0 => return Err(error.into()),
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        names.push(name);
    }
    names.sort();
    for name in names {
        if crate::file_path::validate_name(&name).is_err() || name == ".git" { continue; }
        let metadata = match directory.symlink_metadata(&name) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if crate::file_path::link(&metadata) { continue; }
        let child = display.join(&name);
        if host_link_or_reparse(&child) { continue; }
        // A denied root is skipped by identity, not by name: the host names the
        // credential locations and the worker stays out of them entirely, so a
        // traversal cannot even report a private key below one.
        if request.denies_path(&child) { continue; }
        if hidden(&child, root) || matches!(name.as_str(), ".git" | ".dsh-ops" | "node_modules" | "target" | ".venv") { continue; }
        if metadata.is_file() {
            if output.len() >= MAX_ENTRIES { *truncated = true; return Ok(()); }
            output.push(child);
            continue;
        }
        if metadata.is_dir() {
            let Ok(child_dir) = directory.open_dir_nofollow(&name) else { continue };
            visit_dir(root, &child, child_dir, depth + 1, request, output, truncated)?;
            if *truncated && output.len() >= MAX_ENTRIES { return Ok(()); }
        }
    }
    Ok(())
}
fn positive_patterns(patterns: &[String]) -> impl Iterator<Item = &String> { patterns.iter().filter(|p| !p.starts_with('!')) }
fn matches_any(root: &Path, file: &Path, patterns: &[String]) -> bool {
    let name = relative_display(root, file);
    let positives: Vec<_> = positive_patterns(patterns).collect();
    let included = positives.is_empty() || positives.iter().any(|p| glob_match(p, &name));
    let excluded = patterns.iter().filter_map(|p| p.strip_prefix('!')).any(|p| glob_match(p, &name));
    included && !excluded
}
fn files_for(path: &str, patterns: &[String], request: &Request) -> Result<WalkResult> {
    let root = target(path, false)?;
    request.authorize_path(&root)?;
    if root.is_file() {
        return Ok(WalkResult { files: vec![root.clone()], truncated: false });
    }
    let walked = walk(&root, request)?;
    Ok(WalkResult {
        files: walked.files.into_iter()
            .filter(|f| matches_any(&root, f, patterns))
            .collect(),
        truncated: walked.truncated,
    })
}
fn glob_match(pattern: &str, value: &str) -> bool {
    let p: Vec<_> = pattern.trim_start_matches("./").split('/').collect();
    let v: Vec<_> = value.split('/').collect();
    glob_segments(&p, &v)
}
fn glob_segments(p: &[&str], v: &[&str]) -> bool {
    if p.is_empty() { return v.is_empty(); }
    if p[0] == "**" { return glob_segments(&p[1..], v) || (!v.is_empty() && glob_segments(p, &v[1..])); }
    !v.is_empty() && segment_match(p[0], v[0]) && glob_segments(&p[1..], &v[1..])
}
fn segment_match(pattern: &str, value: &str) -> bool {
    let (mut pi, mut vi, mut star, mut mark) = (0usize, 0usize, None, 0usize);
    let p = pattern.as_bytes(); let v = value.as_bytes();
    while vi < v.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi].eq_ignore_ascii_case(&v[vi])) { pi += 1; vi += 1; }
        else if pi < p.len() && p[pi] == b'*' { star = Some(pi); pi += 1; mark = vi; }
        else if let Some(s) = star { pi = s + 1; mark += 1; vi = mark; }
        else { return false; }
    }
    while pi < p.len() && p[pi] == b'*' { pi += 1; }
    pi == p.len()
}
fn hash_file(path: &Path) -> Result<String> {
    let bytes = read_bytes(path)?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}
fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let target = crate::file_path::checked(raw)?;
    let mut file = crate::file_path::read_file(&target)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "File exceeds the bounded read budget")); }
    Ok(bytes)
}
fn modified(path: &Path) -> u64 { fs::symlink_metadata(path).ok().map_or(0, |m| m.len()) }
/// What one character costs in serde_json's encoding.
fn encoded_cost(character: char) -> usize {
    match character {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}
/// The longest prefix of `text` whose encoding fits `budget` bytes, cut on a
/// character boundary so the result is still valid UTF-8.
fn truncate_to_encoded(text: &str, budget: usize) -> (String, bool) {
    let mut kept = String::new(); let mut used = 0usize;
    for character in text.chars() { let cost = encoded_cost(character); if used + cost > budget { return (kept, true); } used += cost; kept.push(character); }
    (kept, false)
}
/// `offset` is how many units were skipped, counted from zero the way `glob` and
/// `grep` count their own `offset`. `next_base` is the value a caller must pass
/// back to resume, which is its own paging base rather than the skipped count:
/// `inspect` declares a 1-based `offset` (like its hex rows), so deriving the
/// next page from the skipped count re-read the last returned line on every page.
fn result(items: Vec<Value>, total: usize, offset: usize, next_base: usize, matched: usize, truncated: bool) -> Value {
    // Spend the response budget on the serialized items. Returning more than the
    // host will collect is not a bigger answer, it is a failed read: the host
    // truncates stdout, reports OUTPUT_LIMIT and declares the effect unknown, so
    // the caller loses the content and is told something may have changed.
    let budget = MAX_OUTPUT_BYTES.saturating_sub(ENVELOPE_OVERHEAD);
    let mut kept: Vec<Value> = Vec::new(); let mut used = 0usize; let mut stopped = false;
    for item in items {
        let size = serde_json::to_string(&item).map_or(0, |encoded| encoded.len()) + 1;
        if used + size <= budget { used += size; kept.push(item); continue; }
        // This item does not fit whole. Keep a bounded prefix of its text rather
        // than returning nothing at all, so a file holding one long line still
        // answers with its beginning; every remaining item is omitted and counted
        // as such. Reading past the cut is the hex view's job, which pages by
        // 16-byte rows.
        let whole = item.get("text").and_then(Value::as_str);
        let room = budget.saturating_sub(used).saturating_sub(96);
        let prefix = whole.map(|text| truncate_to_encoded(text, room));
        if let Some((text, cut)) = prefix {
            if !text.is_empty() {
                let mut trimmed = item.clone();
                trimmed["text"] = Value::String(text);
                trimmed["bytesTotal"] = json!(whole.map_or(0, |text| text.len()));
                trimmed["truncatedInLine"] = json!(cut);
                kept.push(trimmed);
            }
        }
        stopped = true;
        break;
    }
    let returned = kept.len(); let cut = truncated || stopped;
    json!({"status":"completed","phase":"verify","changed":0,"matched":matched,"skipped":offset,"failed":0,"complete":!cut && offset + returned >= total,"truncated":cut,"omitted":total.saturating_sub(offset + returned),"items":kept,"total":total,"nextOffset":next_base + returned})
}

fn inspect(request: &Request) -> Result<Value> {
    let args: InspectArgs = serde_json::from_value(request.args.clone())?;
    // Name the parameter that is wrong, and the range it has to fit. Merging "missing"
    // and "out of range" into one message made a caller that *did* pass a value read it
    // as a missing argument, and retry the same call.
    if !args.encoding.eq_ignore_ascii_case("utf-8") { return Err(Failure::new("INVALID_ARGUMENT", format!("encoding must be utf-8 (got {})", args.encoding))); }
    if args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", format!("limit must be in 1..=10000 (got {})", args.limit))); }
    let path = target(&args.path, false)?;
    if !path.is_file() { return Err(Failure::new("INVALID_ARGUMENT", "path is a directory; use ops_glob or ops_grep")); }
    let bytes = read_bytes(&path)?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "file exceeds the inspect size budget")); }
    if args.view == "hex" {
        // `offset` means the same thing in both views: the 1-based unit to start
        // from — line N for text, 16-byte row N for hex. It used to count rows
        // from zero here while the text branch counted lines from one, so the
        // declared default of 1 skipped the first row, and the declared
        // `minimum: 1` left no way to ask for it back: any file of at most 16
        // bytes read back as an empty string. In this view `skipped` and the item
        // `offset` are byte counts, not row counts.
        let start = args.offset.saturating_sub(1).saturating_mul(16).min(bytes.len()); let end = (start + args.limit * 16).min(bytes.len());
        let text = bytes[start..end].iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
        return Ok(json!({"status":"completed","phase":"verify","changed":0,"matched":1,"skipped":start,"failed":0,"complete":end == bytes.len(),"omitted":bytes.len().saturating_sub(end),"bytesTotal":bytes.len(),"items":[{"path":path,"view":"hex","offset":start,"text":text}]}));
    }
    if args.view != "text" { return Err(Failure::new("INVALID_ARGUMENT", "view must be text or hex")); }
    let text = String::from_utf8(bytes).map_err(|_| Failure::new("INVALID_ARGUMENT", "file is not valid UTF-8"))?;
    let lines: Vec<_> = text.lines().enumerate().skip(args.offset.saturating_sub(1)).take(args.limit).map(|(i, line)| json!({"path":path,"line":i+1,"text":line})).collect();
    Ok(result(lines, text.lines().count(), args.offset.saturating_sub(1), args.offset, text.lines().count(), false))
}
fn glob(request: &Request) -> Result<Value> {
    let args: GlobArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() || args.pattern.iter().all(|p| p.starts_with('!')) { return Err(Failure::new("INVALID_ARGUMENT", "pattern requires a positive glob")); }
    let root = target(&args.path, false)?; if !root.is_dir() { return Err(Failure::new("INVALID_ARGUMENT", "glob path must be a directory")); }
    let walked = walk(&root, request)?;
    let mut files: Vec<_> = walked.files.into_iter().filter(|f| matches_any(&root, f, &args.pattern)).collect();
    if args.sort == "modified" { files.sort_by_key(|f| std::cmp::Reverse(modified(f))); } else if !args.sort.is_empty() && args.sort != "path" { return Err(Failure::new("INVALID_ARGUMENT", "sort must be path or modified")); }
    let output_mode = if args.output_mode.is_empty() { "paths" } else { args.output_mode.as_str() };
    if output_mode != "paths" && output_mode != "details" { return Err(Failure::new("INVALID_ARGUMENT", "outputMode must be paths or details")); }
    let total = files.len(); let selected: Vec<_> = files.into_iter().skip(args.offset).take(args.limit).map(|f| if output_mode == "paths" { json!(f) } else { let modified_at = modified(&f); json!({"path":f,"bytes":fs::symlink_metadata(&f).map(|m|m.len()).unwrap_or(0),"modified":modified_at}) }).collect();
    Ok(result(selected, total, args.offset, args.offset, total, walked.truncated))
}
fn grep(request: &Request) -> Result<Value> {
    let args: GrepArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() { return Err(Failure::new("INVALID_ARGUMENT", "pattern is required")); }
    if args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", format!("limit must be in 1..=10000 (got {})", args.limit))); }
    if args.before_context > 32 || args.after_context > 32 { return Err(Failure::new("INVALID_ARGUMENT", "context is limited to 32 lines")); }
    let regex = RegexBuilder::new(&args.pattern).case_insensitive(args.case_insensitive).multi_line(args.multiline).build().map_err(|e| Failure::new("INVALID_ARGUMENT", e))?;
    let walked = files_for(&args.path, &args.glob, request)?; let mut matches = Vec::new(); let mut file_count = 0; let mut match_count = 0;
    // Which modes answer with an item per match (`content`) and which with an item per file. Declared
    // once here because both the per-file loop and the envelope's `total` have to agree on it.
    let content_mode = !matches!(args.output_mode.as_str(), "files_with_matches" | "count" | "summary");
    let page = args.offset + args.limit;
    for file in walked.files { let bytes = match read_bytes(&file) { Ok(bytes) => bytes, Err(_) => continue }; if bytes.len() as u64 > MAX_FILE_BYTES { continue; } let text = match String::from_utf8(bytes) { Ok(v) => v, Err(_) => continue }; let lines: Vec<_> = text.lines().collect();
        // Line by line by default. With `multiline` the pattern is matched against
        // the whole file, so a pattern containing `\n` can match across lines
        // instead of never matching at all — which is what the flag's name promises
        // and what it did not do. `^` and `$` still resolve per line, because the
        // builder keeps `multi_line` on in both modes.
        //
        // Each hit is reduced to the span of lines it covers, so one reporting path
        // serves both modes: a cross-line match is reported at the line where it
        // starts, with its context lines around it.
        // Matches are counted in one pass and materialized in a second, page-bounded one. Counting a
        // match costs no allocation, while joining its lines into a `text` item costs the lines
        // themselves — and the previous shape built one item per match in the file *before* `limit`
        // was consulted, so a 32 KiB line matched by `pattern: "a"` copied that line 32 768 times and
        // the worker died under a memory cap instead of returning its first item. Reported by
        // @Haoming9527 in review of #81.
        let mut hits = 0usize;
        let mut spans: Vec<(usize, usize)> = Vec::new();
        if args.multiline {
            let starts: Vec<usize> = text.match_indices('\n').map(|(at, _)| at + 1).collect();
            // Clamped, so a match can never be attributed to a line the file does
            // not have: the offset-to-line map is only meaningful for offsets inside
            // the text.
            let line_of = |offset: usize| starts.partition_point(|start| *start <= offset).min(lines.len().saturating_sub(1));
            for found in regex.find_iter(&text) {
                // Matching the whole file at once adds one zero-width match at the
                // position after a final newline — the one place `$` and `^` already
                // matched at the end of the last real line. Reporting it invented
                // line N+1 with empty text, so `$` answered six times for a
                // five-line file. A file with no trailing newline keeps its last
                // match, because there the end of the file is the end of a line.
                if found.start() >= text.len() && text.ends_with('\n') { continue; }
                hits += 1;
                // Only what the page can still hold is materialized, so the peak is the page and not
                // the file's match count. `hits` above stays exact: `matched` reports every match.
                if content_mode && spans.len() < page.saturating_sub(matches.len()) { spans.push((line_of(found.start()), line_of(found.end().saturating_sub(1).max(found.start())))); }
            }
        } else {
            for (index, line) in lines.iter().enumerate() {
                if !regex.is_match(line) { continue; }
                hits += 1;
                if content_mode && spans.len() < page.saturating_sub(matches.len()) { spans.push((index, index)); }
            }
        }
        if hits == 0 { continue; } file_count += 1; match_count += hits;
        match args.output_mode.as_str() { "files_with_matches" => matches.push(json!({"path":file})), "count" => matches.push(json!({"path":file,"count":hits})), "summary" => {} , _ => { for (first, last) in spans { let start=first.saturating_sub(args.before_context); let end=(last+args.after_context+1).min(lines.len()); matches.push(json!({"path":file,"line":if args.line_numbers {first+1} else {0},"text":lines[start..end].join("\n")})); } } }
        if args.output_mode != "summary" && matches.len() >= args.offset + args.limit { break; }
    }
    if args.output_mode == "summary" { return Ok(json!({"status":"completed","phase":"verify","changed":0,"matched":match_count,"skipped":0,"failed":0,"complete":!walked.truncated,"truncated":walked.truncated,"omitted":0,"files":file_count,"matches":match_count})); }
    // `total` is the number of items a full materialization would have produced: one per match in the
    // content modes, one per file otherwise. It is the match count in the first case because the page
    // bound above only limits what was *built*, never what was counted.
    let total = if content_mode { match_count } else { matches.len() };
    Ok(result(matches.into_iter().skip(args.offset).take(args.limit).collect(), total, args.offset, args.offset, match_count, walked.truncated))
}
fn replace(request: &Request) -> Result<Value> {
    if request.read_only { return Err(Failure::new("POLICY_DENIED", "replace is unavailable in read-only mode")); }
    let args: ReplaceArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() { return Err(Failure::new("INVALID_ARGUMENT", "pattern is required")); }
    if args.max_replacements == 0 || args.max_replacements > 100_000 { return Err(Failure::new("INVALID_ARGUMENT", format!("maxReplacements must be in 1..=100000 (got {})", args.max_replacements))); }
    let walked = files_for(&args.path, &args.glob, request)?; let mut plans = Vec::new(); let mut total = 0usize; let mut binary: Vec<PathBuf> = Vec::new();
    // A directory that holds one binary file (an icon, an archive) is a normal repository, not a
    // malformed request: the binary is reported as skipped and the text files around it are still
    // edited. Failing the whole call on the first non-UTF-8 byte made a routine directory edit
    // impossible, and the error named no file, so the caller could not even narrow the request.
    for file in walked.files { let bytes=read_bytes(&file)?; match String::from_utf8(bytes.clone()) { Ok(text) => { let count=text.match_indices(&args.pattern).count(); if count>0 { total += count; plans.push((file, bytes, text, count)); } } Err(_) => binary.push(file) } }
    let skipped = binary.len();
    let skipped_paths: Vec<Value> = binary.iter().take(16).map(|file| json!(relative_display(&request.root_path(), file))).collect();
    if total > args.max_replacements { return Err(Failure::new("OUTPUT_LIMIT", format!("{total} matches exceed maxReplacements ({}); no file was changed. maxReplacements is a ceiling, not a truncation: raise it to {total} or more and retry.", args.max_replacements))); }
    let mut items=Vec::new(); for (file, original, text, count) in plans { let revision=hash_file(&file)?; let next=text.replace(&args.pattern,&args.replacement); items.push(json!({"path":file,"replacements":count,"revision":revision,"bytesBefore":original.len(),"bytesAfter":next.len()})); }
    if args.dry_run { return Ok(json!({"status":"completed","phase":"observe","changed":0,"matched":total,"skipped":skipped,"failed":0,"complete":true,"omitted":0,"dryRun":true,"items":items,"skippedPaths":skipped_paths})); }
    let mut changed=0usize; for item in &mut items { let file=PathBuf::from(item["path"].as_str().unwrap_or(""));
        // Trusted transport owns this allowlist. Re-check every selected file,
        // not only the initial search root, immediately before publication.
        if let Some(roots) = &request.write_roots {
            let canonical = std::fs::canonicalize(&file)?;
            if !roots.iter().any(|root| std::fs::canonicalize(root).is_ok_and(|r| canonical.starts_with(r))) {
                return Err(Failure::new("POLICY_DENIED", "User authorized workspace writes only; target is outside DSH writable roots. Ask the user to select full access; do not retry or bypass."));
            }
        }
        // Hold the update lock across the check, the read and the publish, so a
        // peer cannot slip in between them and lose our write, or make us lose
        // its. The guard is named, not `_`, so it lives to the end of this pass.
        let (_update, bytes) = lock_and_read_for_update(&file)?;
        // The revision is checked against the bytes the lock returned, so the check
        // and the write cannot be separated by another open — see the lock for why.
        let expected=item["revision"].as_str().unwrap_or(""); if format!("{:x}", Sha256::digest(&bytes)) != expected { return Err(Failure::new("REVISION_CONFLICT", "file changed between observe and execute")); }
        let text=String::from_utf8(bytes).map_err(|_| Failure::new("INVALID_ARGUMENT", "replace only supports UTF-8 files"))?; let next=text.replace(&args.pattern,&args.replacement);
        // Report what the replacement kept. The fields are additive, so a caller
        // that ignores them sees exactly the envelope it saw before.
        if let Some((metadata,warnings))=atomic_write(&file,next.as_bytes())? { item["metadata"]=metadata; if !warnings.is_empty() { item["metadataWarnings"]=json!(warnings); } }
        changed += item["replacements"].as_u64().unwrap_or(0) as usize; }
    Ok(json!({"status":"completed","phase":"verify","changed":changed,"matched":total,"skipped":skipped,"failed":0,"complete":true,"omitted":0,"items":items,"skippedPaths":skipped_paths}))
}
/// A POSIX ACL is exposed as this attribute, so preserving ACLs needs no libacl.
#[cfg(unix)]
const ACL_XATTR: &str = "system.posix_acl_access";

/// What the file being replaced carried, captured before its replacement exists.
///
/// `atomic_write` publishes a *new* inode, and a new inode arrives with none of
/// the old one's metadata: the mode, the owner, the POSIX ACL and every extended
/// attribute belong to the file that is about to be unlinked. So a `0600` `.env`
/// came back world-readable, a `0755` script lost its execute bit and an ACL was
/// dropped outright — the replacement was more permissive than what it replaced,
/// which is the one direction a file tool must never drift in silently.
///
/// Capture and restore are judged separately. A *capture* that cannot be completed
/// — the attribute list, the ACL, or any single value — aborts the call before
/// anything is published: a value that was never read cannot be put back, so the
/// tool would be guessing at what it is about to destroy. Only a *restore* failure
/// is downgraded to a warning, and only for the attributes listed as best-effort
/// below.
///
/// Policy, by severity:
///
/// - The mode is **not optional**. If it cannot be reapplied the call fails and
///   nothing is published; guessing at permissions widens access.
/// - A POSIX ACL is not optional either. A file that had one and comes back
///   without it has lost entries, and losing a *deny* entry is a widening change.
/// - On restore, the owner and the remaining extended attributes are best-effort
///   and are reported in `metadataWarnings`; they cannot be used as a substitute
///   for the two above, and a caller can act on a warning in a way it cannot act on
///   a silent change.
#[cfg(unix)]
struct PreservedMetadata { mode: u32, uid: u32, gid: u32, acl: Option<Vec<u8>>, xattrs: Vec<(String, Vec<u8>)> }

/// Read one extended attribute, or `None` when it is absent or unsupported.
#[cfg(unix)]
fn get_xattr(fd: &impl rustix::fd::AsFd, name: &str) -> Result<Option<Vec<u8>>> {
    let mut probe: [u8; 0] = [];
    match rustix::fs::fgetxattr(fd, name, &mut probe[..]) {
        Ok(size) => {
            let mut buffer = vec![0u8; size];
            let written = rustix::fs::fgetxattr(fd, name, &mut buffer[..]).map_err(|error| Failure::new("ACCESS_DENIED", format!("Read extended attribute {name}: {error}")))?;
            buffer.truncate(written);
            Ok(Some(buffer))
        }
        Err(error) if matches!(error, rustix::io::Errno::NODATA | rustix::io::Errno::NOTSUP)
            || (cfg!(target_os = "macos") && error == rustix::io::Errno::from_raw_os_error(93)) => Ok(None),
        Err(error) => Err(Failure::new("ACCESS_DENIED", format!("Read extended attribute {name}: {error}"))),
    }
}

/// Every attribute name on the file. An empty list is not an error: a filesystem
/// that carries none answers `ENOTSUP`.
#[cfg(unix)]
fn list_xattrs(fd: &impl rustix::fd::AsFd) -> Result<Vec<String>> {
    let mut probe: [u8; 0] = [];
    let size = match rustix::fs::flistxattr(fd, &mut probe[..]) {
        Ok(size) => size,
        Err(error) if error == rustix::io::Errno::NOTSUP => return Ok(Vec::new()),
        Err(error) => return Err(Failure::new("ACCESS_DENIED", format!("List extended attributes: {error}"))),
    };
    let mut buffer = vec![0u8; size];
    let written = rustix::fs::flistxattr(fd, &mut buffer[..]).map_err(|error| Failure::new("ACCESS_DENIED", format!("List extended attributes: {error}")))?;
    buffer.truncate(written);
    Ok(buffer.split(|byte| *byte == 0).filter(|name| !name.is_empty()).map(|name| String::from_utf8_lossy(name).into_owned()).collect())
}

#[cfg(unix)]
impl PreservedMetadata {
    fn of(target: &crate::file_path::Target) -> Result<Self> {
        let file = crate::file_path::read_file(target)?;
        let stat = rustix::fs::fstat(&file).map_err(|error| Failure::new("ACCESS_DENIED", format!("Stat {}: {error}", target.display.display())))?;
        let mut xattrs = Vec::new();
        for name in list_xattrs(&file)? { if name == ACL_XATTR { continue } if let Some(value) = get_xattr(&file, &name)? { xattrs.push((name, value)) } }
        Ok(Self { mode: stat.st_mode as u32, uid: stat.st_uid as u32, gid: stat.st_gid as u32, acl: get_xattr(&file, ACL_XATTR)?, xattrs })
    }
    /// Reapply onto the replacement. `Err` forbids publication; `Ok` may still
    /// carry warnings for whatever could not be restored.
    fn restore(&self, file: &cap_std::fs::File) -> Result<(Value, Vec<String>)> {
        let mut warnings = Vec::new();
        let current = rustix::fs::fstat(file).map_err(|error| Failure::new("ACCESS_DENIED", format!("Stat replacement: {error}")))?;
        let owner = if (self.uid, self.gid) == (current.st_uid as u32, current.st_gid as u32) {
            true
        } else {
            match rustix::fs::fchown(file, Some(rustix::process::Uid::from_raw(self.uid)), Some(rustix::process::Gid::from_raw(self.gid))) {
                Ok(()) => true,
                Err(error) => { warnings.push(format!("owner {}:{} was not restored ({error}); the replacement is owned by the current user", self.uid, self.gid)); false }
            }
        };
        // The mode goes on after the owner, because a successful `chown` clears
        // setuid and setgid. This one is fatal if it fails.
        rustix::fs::fchmod(file, rustix::fs::Mode::from_bits_truncate((self.mode & 0o7777) as _)).map_err(|error| Failure::new("ACCESS_DENIED", format!("Mode {:04o} could not be preserved ({error}); nothing was published", self.mode & 0o7777)))?;
        // The ACL goes on after the mode, because `chmod` rewrites an ACL's mask
        // entry; applying the captured attribute last reproduces the original pair.
        let acl = match &self.acl {
            Some(acl) => { rustix::fs::fsetxattr(file, ACL_XATTR, acl, rustix::fs::XattrFlags::empty()).map_err(|error| Failure::new("ACCESS_DENIED", format!("POSIX ACL could not be preserved ({error}); nothing was published")))?; true }
            None => {
                // A new inode can inherit a parent's default ACL even when the old
                // inode had no access ACL. Do not publish those inherited grants.
                #[cfg(target_os = "linux")]
                match rustix::fs::fremovexattr(file, ACL_XATTR) {
                    Ok(()) => (),
                    Err(error) if matches!(error, rustix::io::Errno::NODATA | rustix::io::Errno::NOTSUP) => (),
                    Err(error) => return Err(Failure::new("ACCESS_DENIED", format!("Inherited POSIX ACL could not be cleared ({error}); nothing was published"))),
                }
                false
            },
        };
        let mut restored = Vec::new();
        for (name, value) in &self.xattrs {
            match rustix::fs::fsetxattr(file, name.as_str(), value, rustix::fs::XattrFlags::empty()) { Ok(()) => restored.push(name.clone()), Err(error) => warnings.push(format!("extended attribute {name} was not restored ({error})")) }
        }
        Ok((json!({"mode": format!("{:04o}", self.mode & 0o7777), "owner": owner, "acl": acl, "xattrs": restored}), warnings))
    }
}

/// Lock the stable per-path sidecar before reading the current target.
///
/// Target-inode locks are insufficient across atomic rename: a waiter can retain
/// the old inode while the path already names a new one. Cooperating writers all
/// use this persistent lock inode, held until publication and directory sync.
/// Non-cooperating writers remain outside this advisory serialization contract.
fn lock_and_read_for_update(file: &Path) -> Result<(std::fs::File, Vec<u8>)> {
    let raw = file.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked(raw)?;
    // The lock inode must survive replacement of the target inode. Keep a
    // persistent, hidden sidecar per path; unlinking it after unlock would let
    // another process lock a different inode under the same lock name.
    let key = format!("{:x}", Sha256::digest(checked.name.as_bytes()));
    let lock_name = format!(".dsh-ops-update-{key}.lock");
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    { use cap_std::fs::OpenOptionsExt; options.mode(0o600); }
    let lock = checked.parent.open_with(lock_name, &options)?.into_std();
    FileExt::try_lock_exclusive(&lock).map_err(|_| Failure::new("REVISION_CONFLICT", "another writer is updating this path; nothing was changed, retry"))?;
    let bytes = read_bytes(file)?;
    Ok((lock, bytes))
}
/// Remove `.<name>.dsh-ops-<uuid>` leftovers from earlier writers that were killed
/// before they could publish.
///
/// A `SIGKILL` cannot run a cleanup path, so the debris cannot be prevented at the
/// point it is created. The next writer of the same file is the only place it can
/// be bounded, and it is a safe place: the caller holds the update lock, so no live
/// writer is using any of *this* file's names. Best-effort — a leftover that cannot
/// be removed must not fail the write that is about to happen.
///
/// A leftover is identified by the whole shape this writer creates, not by its
/// prefix: the tail must parse as the v4 UUID `atomic_write` generates. The prefix
/// rule deleted files that merely began the same way — an operator's
/// `.notes.txt.dsh-ops-personal-backup`, and, for a target named `foo`, the live
/// temporary file of a *different* target (`foo.dsh-ops-bar`), whose writer holds a
/// lock on that other file and not on this one. Reported by @Haoming9527 in review
/// of #81.
fn sweep_debris(parent: &cap_std::fs::Dir, name: &str) {
    let prefix = format!(".{name}.dsh-ops-");
    if let Ok(entries) = parent.entries() {
        for entry in entries.flatten() {
            if let Ok(leftover) = entry.file_name().into_string() {
                let own = leftover.strip_prefix(&prefix).and_then(|tail| uuid::Uuid::parse_str(tail).ok()).is_some_and(|parsed| parsed.get_version_num() == 4);
                if own { let _ = parent.remove_file(&leftover); }
            }
        }
    }
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<Option<(Value, Vec<String>)>> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked(raw)?;
    // Capture what the file carries before creating its replacement: publication is
    // a rename, so the new inode arrives with none of it.
    #[cfg(unix)]
    let preserved = PreservedMetadata::of(&checked)?;
    let parent = checked.parent;
    let name = checked.name;
    sweep_debris(&parent, &name);
    let temporary = format!(".{name}.dsh-ops-{}", uuid::Uuid::new_v4());
    #[cfg(target_os = "macos")]
    {
        // APFS cloning preserves Darwin's extended ACL (not the Linux POSIX
        // ACL xattr). Fail closed on filesystems without clone support rather
        // than silently publishing an inode that lost a deny entry.
        let source = crate::file_path::read_file(&crate::file_path::checked(raw)?)?;
        rustix::fs::fclonefileat(&source, &parent, temporary.as_str(), rustix::fs::CloneFlags::empty())
            .map_err(|error| Failure::new("ACCESS_DENIED", format!("Atomic replacement requires APFS metadata-preserving clone support: {error}")))?;
        let mut cloned_options = cap_std::fs::OpenOptions::new(); cloned_options.read(true).follow(FollowSymlinks::No);
        let cloned = parent.open_with(&temporary, &cloned_options)?;
        rustix::fs::fchmod(&cloned, rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR).map_err(|error| Failure::new("ACCESS_DENIED", error))?;
    }
    #[cfg(target_os = "macos")]
    let mut options = { let mut value = cap_std::fs::OpenOptions::new(); value.write(true).truncate(true).follow(FollowSymlinks::No); value };
    #[cfg(not(target_os = "macos"))]
    let mut options = { let mut value = cap_std::fs::OpenOptions::new(); value.write(true).create_new(true).follow(FollowSymlinks::No); value };
    #[cfg(unix)]
    { use cap_std::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = parent.open_with(&temporary, &options).map_err(|e| Failure::new("ACCESS_DENIED", format!("Atomic replacement create: {e}")))?;
    // Keep content private until final metadata is restored. Creation mode also
    // masks inherited ACL grants; never write sensitive bytes to a default 0666 inode.
    let prepared = (|| -> Result<Option<(Value, Vec<String>)>> {
        file.write_all(bytes)?;
        #[cfg(unix)]
        let report = Some(preserved.restore(&file)?);
        #[cfg(not(unix))]
        let report = None;
        // Both bytes and restored mode/owner/ACL/xattrs must be durable before rename.
        file.sync_all()?;
        Ok(report)
    })();
    drop(file);
    let report = match prepared {
        Ok(report) => report,
        Err(failure) => { let _ = parent.remove_file(&temporary); return Err(failure); }
    };
    // Publication stays handle-relative and does not traverse links.
    let publish = parent.rename(&temporary, &parent, &name);
    if let Err(error) = publish {
        let _ = parent.remove_file(&temporary);
        return Err(Failure::new("ACCESS_DENIED", format!("Atomic replacement publish: {error}")));
    }
    #[cfg(unix)]
    if let Err(error) = crate::sync_directory(&parent) {
        // The rename already happened, so the file *is* replaced. Reporting the
        // default `effect_state: "none"` here would tell the caller that nothing
        // changed, which is the one answer a caller must never get wrong: it would
        // invite a repeat of a write that has already been applied.
        let mut failure = Failure::new("SYNC_FAILED", format!("Atomic replacement published, but the directory entry could not be synced: {}", error.message));
        failure.phase = "publish".into();
        failure.effect_state = "applied".into();
        failure.next_action = "The replacement is already published; do not repeat it. Verify the file if durability matters.".into();
        return Err(failure);
    }
    Ok(report)
}
