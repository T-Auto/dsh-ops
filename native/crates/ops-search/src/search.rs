//! Search execution streams bounded files and keeps only the requested output page.
use super::*;
use super::{
    paging::{Cursor, Page, finish},
    scan::{Scan, SourceKind},
};
use crate::definitions::{classify, whole_identifier};
use ops_index::FsDataSource;
use ops_protocol::search::TruncatedBy;

/// Cursor plus the traversal kind encoded by a continuation, when present.
///
/// Page two keeps the source domain of page one: the token prefix names the kind
/// that produced the snapshot, and the cursor binds it.
fn cursor_for(
    request: &Request,
    offset: usize,
    token: Option<&str>,
) -> Result<(Cursor, Option<SourceKind>)> {
    let Some(token) = token else {
        return Ok((Cursor::new(request, offset, None)?, None));
    };
    let Some(kind) = SourceKind::from_token(token) else {
        return Ok((Cursor::new(request, offset, Some(token))?, None));
    };
    Ok((
        Cursor::new_for(request, kind, offset, Some(token))?,
        Some(kind),
    ))
}

/// Runs one traversal, trying a platform index source only for `glob` when the
/// host passed a cache directory. `source` is the `cfg(test)` injection point;
/// production calls pass `None` and the platform choice stays in `index_source`.
fn walk_request<F>(
    scan: &mut Scan,
    root: &Path,
    patterns: &[String],
    request: &Request,
    allow_index: bool,
    source: Option<&dyn FsDataSource>,
    mut each: F,
) -> Result<SourceKind>
where
    F: FnMut(&Path, &cap_std::fs::Metadata, &mut Scan) -> Result<()>,
{
    // `cache_dir` says whether the index is available; `allow_index` is the G3
    // boundary that keeps it to `glob` (`grep` reads content and stays on the walk).
    //
    // An index that enumerated below a dot directory cannot answer a question
    // about that directory: its own pruning happens before any leaf is seen, so
    // reusing it would silently drop what the caller just asked for. Rather than
    // teach the index a second policy, `includeHidden` declines the index and
    // takes the walk, which is where the caller's answer actually lives.
    if !allow_index || scan.include_hidden || request.cache_dir.is_none() {
        scan.walk(root, patterns, request, &mut each)?;
        return Ok(SourceKind::Walk);
    }
    match source {
        Some(source) => scan.walk_indexed(root, source, patterns, request, &mut each),
        None => {
            let platform = crate::index_source::platform_source();
            scan.walk_indexed(root, platform.as_ref(), patterns, request, &mut each)
        }
    }
}

/// Rebinds a page-one cursor to the traversal that actually ran.
///
/// A continuation already carries its kind; if page two is served by the other
/// traversal, `finish` rejects it instead of mixing snapshot domains.
fn actual_cursor(
    request: &Request,
    cursor: Cursor,
    expected: Option<SourceKind>,
    used: SourceKind,
) -> Result<Cursor> {
    if expected.is_none() && used != SourceKind::Walk {
        return Cursor::new_for(request, used, cursor.offset, None);
    }
    Ok(cursor)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GlobArgs {
    path: String,
    pattern: Vec<String>,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    output_mode: String,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
    continuation: Option<String>,
    #[serde(default)]
    include_hidden: bool,
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
    #[serde(default = "yes")]
    exact_total: bool,
    #[serde(default)]
    include_hidden: bool,
    continuation: Option<String>,
}

pub fn glob(request: &Request) -> Result<Value> {
    glob_with(request, None)
}

#[cfg(test)]
mod include_hidden_tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = std::fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("dsh-ops-hidden-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self { root }
        }
        fn file(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, bytes).unwrap();
            path
        }
        /// A request whose `args` are this tool's arguments plus a fixed scope.
        fn request(&self, tool: &str, args: serde_json::Value) -> Request {
            let mut root = serde_json::to_value(&self.root).unwrap();
            let mut args = args;
            args["path"] = std::mem::take(&mut root);
            serde_json::from_value(json!({
                "root": self.root,
                "scope": "hidden-test",
                "tool": tool,
                "args": args,
            }))
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// The answer's file list, as this platform's separator with a forward
    /// slash and relative to the fixture root. `glob` and `grep` name files by
    /// verbatim absolute path, so the comparison is made on the tail.
    fn paths(root: &Path, value: &Value) -> Vec<String> {
        let base = root.to_string_lossy().replace('\\', "/");
        value["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|entry| {
                        let raw = entry
                            .as_str()
                            .or_else(|| entry["path"].as_str())
                            .unwrap_or("")
                            .replace('\\', "/");
                        // The answer names files by verbatim absolute path,
                        // which may carry a `\\?\` prefix on Windows. Anchoring
                        // on the root once is more robust than a prefix trim.
                        match raw.find(&base) {
                            Some(at) => raw[at + base.len()..].trim_start_matches('/').to_string(),
                            None => raw,
                        }
                    })
                    .filter(|path| !path.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The reported gap: a dot directory is silently absent from a glob answer.
    #[test]
    fn a_dot_directory_is_absent_unless_the_caller_asks_for_it() {
        let fixture = Fixture::new("glob");
        fixture.file("src/a.ts", b"export const a = 1;\n");
        fixture.file(".github/b.ts", b"export const b = 2;\n");

        let hidden = glob(&fixture.request("glob", json!({"pattern": ["**/*.ts"]}))).unwrap();
        assert_eq!(paths(&fixture.root, &hidden), vec!["src/a.ts"]);

        let shown = glob(&fixture.request(
            "glob",
            json!({"pattern": ["**/*.ts"], "includeHidden": true}),
        ))
        .unwrap();
        let mut got = paths(&fixture.root, &shown);
        got.sort();
        assert_eq!(got, vec![".github/b.ts", "src/a.ts"]);
    }

    /// `grep` shares the switch, so the two tools cannot disagree about what
    /// exists.
    #[test]
    fn grep_honours_the_same_switch() {
        let fixture = Fixture::new("grep");
        fixture.file("src/a.ts", b"export const a = 1;\n");
        fixture.file(".github/b.ts", b"export const b = 2;\n");

        let hidden = grep(&fixture.request("grep", json!({"pattern": "export"}))).unwrap();
        let mut got = paths(&fixture.root, &hidden);
        got.sort();
        assert_eq!(got, vec!["src/a.ts"]);

        let shown =
            grep(&fixture.request("grep", json!({"pattern": "export", "includeHidden": true})))
                .unwrap();
        let mut got = paths(&fixture.root, &shown);
        got.sort();
        assert_eq!(got, vec![".github/b.ts", "src/a.ts"]);
    }

    /// The switch must never reach the plugin's own bookkeeping: the update
    /// lock lives under a dot name, and a directory-wide `ops_replace` that
    /// rewrote it would defeat the concurrency guard it exists to provide.
    #[test]
    fn the_internal_sidecar_stays_invisible_under_every_setting() {
        let fixture = Fixture::new("internal");
        fixture.file("src/a.ts", b"export const a = 1;\n");
        fixture.file(".dsh-ops/a.ts", b"export const hidden = 2;\n");
        fixture.file(".dsh-ops-update-deadbeef.lock", b"lock");

        for include_hidden in [false, true] {
            for tool in ["glob", "grep"] {
                let args = if tool == "glob" {
                    json!({"pattern": ["**/*"], "includeHidden": include_hidden})
                } else {
                    json!({"pattern": "export", "glob": ["**/*"], "includeHidden": include_hidden})
                };
                let answer = if tool == "glob" {
                    glob(&fixture.request(tool, args)).unwrap()
                } else {
                    grep(&fixture.request(tool, args)).unwrap()
                };
                let found = paths(&fixture.root, &answer);
                assert!(
                    !found.iter().any(|path| path.contains(".dsh-ops")),
                    "{tool} includeHidden={include_hidden} returned {found:?}"
                );
            }
        }
    }

    /// The walk that serves `ops_replace` keeps its own constant answer. It is
    /// not a selection tool: it rewrites what it walks, so the caller's reading
    /// preference is not an argument it takes.
    #[test]
    fn the_rewrite_walk_does_not_take_the_switch() {
        let fixture = Fixture::new("replace");
        fixture.file("src/a.ts", b"export const a = 1;\n");
        fixture.file(".github/b.ts", b"export const b = 2;\n");

        let walked = files_for(
            fixture.root.to_str().unwrap(),
            &["**/*.ts".to_string()],
            &fixture.request("replace", json!({"pattern": "x", "replacement": "y"})),
        )
        .unwrap();
        let names: Vec<String> = walked
            .files
            .iter()
            .map(|path| {
                path.strip_prefix(&fixture.root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(names, vec!["src/a.ts"]);
    }
}

/// The same glob with an injected source: a `cfg(test)` seam for a fake-Ready
/// source, so the indexed path is exercised without a platform bypass.
#[cfg(test)]
pub(crate) fn glob_with_source(request: &Request, source: &dyn FsDataSource) -> Result<Value> {
    glob_with(request, Some(source))
}

fn glob_with(request: &Request, source: Option<&dyn FsDataSource>) -> Result<Value> {
    let args: GlobArgs = serde_json::from_value(request.args.clone())?;
    if args.limit == 0 || args.limit > 10_000 {
        return Err(Failure::new("INVALID_ARGUMENT", "glob limit is 1-10000"));
    }
    if let Some((index, _)) = args
        .pattern
        .iter()
        .enumerate()
        .find(|(_, pattern)| pattern.trim().is_empty())
    {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            format!("pattern[{index}] must be a non-empty glob"),
        ));
    }
    if args.pattern.is_empty() || args.pattern.iter().all(|pattern| pattern.starts_with('!')) {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "pattern requires a positive glob",
        ));
    }
    if !matches!(args.sort.as_str(), "" | "path" | "modified") {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "sort must be path or modified",
        ));
    }
    if !matches!(args.output_mode.as_str(), "" | "paths" | "details") {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "outputMode must be paths or details",
        ));
    }
    if !matches!(args.kind.as_str(), "" | "file" | "directory" | "all") {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "kind must be file, directory or all",
        ));
    }
    let root = target(&args.path, false)?;
    if !root.is_dir() {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "glob path must be a directory",
        ));
    }
    let (cursor, expected) = cursor_for(request, args.offset, args.continuation.as_deref())?;
    let mut scan = Scan::new();
    scan.include_directories = matches!(args.kind.as_str(), "directory" | "all");
    scan.include_hidden = args.include_hidden;
    let allow_index = !scan.include_directories;
    let mut files = Vec::new();
    let used = walk_request(
        &mut scan,
        &root,
        &args.pattern,
        request,
        allow_index,
        source,
        |file, metadata, _| {
            if args.kind == "directory" && !metadata.is_dir() {
                return Ok(());
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_millis());
            files.push((
                file.to_path_buf(),
                modified,
                metadata.len(),
                metadata.is_dir(),
            ));
            Ok(())
        },
    )?;
    let cursor = actual_cursor(request, cursor, expected, used)?;
    if scan.include_directories {
        files.sort_by(|a, b| a.0.cmp(&b.0));
    }
    if args.sort == "modified" {
        files.sort_by_key(|(_, modified, _, _)| std::cmp::Reverse(*modified));
    }
    let total = files.len();
    let mut page = Page::new(cursor.offset, args.limit, request.output_sink.clone());
    for (ordinal, (file, modified, bytes, directory)) in files.into_iter().enumerate() {
        if page.wants(ordinal) {
            page.push(
                if args.output_mode == "details" {
                    let mut item = json!({"path":file,"bytes":bytes,"modified":modified});
                    if scan.include_directories {
                        item["kind"] = json!(if directory { "directory" } else { "file" });
                    }
                    item
                } else {
                    json!(file)
                },
                ordinal,
            )?;
        }
    }
    finish(scan, cursor, page, total, total, json!({}))
}

/// Extract physical LF-delimited context without allocating a line table for the whole file.
fn excerpt(text: &str, first: usize, last: usize, before: usize, after: usize) -> String {
    let bytes = text.as_bytes();
    let mut start = bytes[..first]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    for _ in 0..before {
        if start == 0 {
            break;
        }
        start = bytes[..start - 1]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
    }
    let mut end = bytes[last..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(bytes.len(), |index| last + index + 1);
    for _ in 0..after {
        if end == bytes.len() {
            break;
        }
        end = bytes[end..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| end + index + 1);
    }
    let mut output = String::new();
    for (index, raw) in text[start..end].split_inclusive('\n').enumerate() {
        if index > 0 {
            output.push('\n');
        }
        output.push_str(
            raw.strip_suffix('\n')
                .map(|line| line.strip_suffix('\r').unwrap_or(line))
                .unwrap_or(raw),
        );
    }
    output
}
pub fn grep(request: &Request) -> Result<Value> {
    grep_with(request, None)
}

/// The same grep with an injected source: a `cfg(test)` seam proving `grep`
/// never consults an index source even when the host supplied a cache.
#[cfg(test)]
pub(crate) fn grep_with_source(request: &Request, source: &dyn FsDataSource) -> Result<Value> {
    grep_with(request, Some(source))
}

fn grep_with(request: &Request, source: Option<&dyn FsDataSource>) -> Result<Value> {
    let args: GrepArgs = serde_json::from_value(request.args.clone())?;
    if args.pattern.is_empty() {
        return Err(Failure::new("INVALID_ARGUMENT", "grep pattern is required"));
    }
    if args.limit == 0 || args.limit > 10_000 {
        return Err(Failure::new("INVALID_ARGUMENT", "grep limit is 1-10000"));
    }
    if args.before_context > 32 || args.after_context > 32 {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "context is limited to 32 lines",
        ));
    }
    if !matches!(
        args.output_mode.as_str(),
        "" | "content" | "files_with_matches" | "count" | "summary" | "definitions"
    ) {
        return Err(Failure::new("INVALID_ARGUMENT", "invalid grep outputMode"));
    }
    let definitions = args.output_mode == "definitions";
    if definitions && (args.multiline || args.before_context > 0 || args.after_context > 0) {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "definitions mode searches individual lines and takes no multiline or context options",
        ));
    }
    let regex = RegexBuilder::new(&args.pattern)
        .case_insensitive(args.case_insensitive)
        .multi_line(args.multiline)
        .build()
        .map_err(|error| Failure::new("INVALID_ARGUMENT", error))?;
    let root = target(&args.path, false)?;
    let (cursor, expected) = cursor_for(request, args.offset, args.continuation.as_deref())?;
    let mut scan = Scan::new();
    scan.include_hidden = args.include_hidden;
    let mut page = Page::new(cursor.offset, args.limit, request.output_sink.clone());
    let mut file_count = 0;
    let mut match_count = 0;
    let mut observed = 0usize;
    let content = matches!(args.output_mode.as_str(), "" | "content");
    // Cursors must revalidate a complete snapshot; summaries always need every match.
    let early = !args.exact_total && args.continuation.is_none() && args.output_mode != "summary";
    let wanted = cursor.offset.saturating_add(args.limit);
    let used = walk_request(
        &mut scan,
        &root,
        &args.glob,
        request,
        false,
        source,
        |file, _, scan| {
            let Some(bytes) = scan.read(file) else {
                return Ok(());
            };
            let extension = file
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let started = scan.profile.start();
            let result = (|| {
                let text = match String::from_utf8(bytes) {
                    Ok(text) => text,
                    Err(_) => {
                        scan.skip("invalid-encoding", true, true);
                        return Ok(());
                    }
                };
                if text.is_empty() {
                    return Ok(());
                }
                let mut hits = 0;
                if args.multiline {
                    let mut hit = |first: usize, last: usize, line: usize| -> Result<bool> {
                        let ordinal = match_count + hits;
                        hits += 1;
                        if content && page.wants(ordinal) {
                            page.push(
                                json!({"path":file,"line":if args.line_numbers {line} else {0},
                        "text":excerpt(&text, first, last, args.before_context, args.after_context)}),
                                ordinal,
                            )?;
                        }
                        Ok(early && content && ordinal.saturating_add(1) >= wanted)
                    };
                    let mut previous = 0;
                    let mut line = 1;
                    for found in regex.find_iter(&text) {
                        if !scan.running() {
                            break;
                        }
                        if found.start() >= text.len() && text.ends_with('\n') {
                            continue;
                        }
                        line += text[previous..found.start()]
                            .bytes()
                            .filter(|byte| *byte == b'\n')
                            .count();
                        previous = found.start();
                        if hit(
                            found.start(),
                            found.end().saturating_sub(1).max(found.start()),
                            line,
                        )? {
                            if content {
                                scan.stopped = Some(TruncatedBy::RowLimit);
                            }
                            break;
                        }
                    }
                } else if definitions {
                    for (index, raw) in text.split_inclusive('\n').enumerate() {
                        if !scan.running() {
                            break;
                        }
                        let line = raw
                            .strip_suffix('\n')
                            .map(|line| line.strip_suffix('\r').unwrap_or(line))
                            .unwrap_or(raw);
                        let Some(found) = regex.find(line) else {
                            continue;
                        };
                        observed += 1;
                        let declaration = if whole_identifier(line, found.start(), found.end()) {
                            classify(extension, line, found.start(), found.end())
                        } else {
                            None
                        };
                        let Some(kind) = declaration else {
                            continue;
                        };
                        let ordinal = match_count + hits;
                        hits += 1;
                        if page.wants(ordinal) {
                            page.push(
                                json!({"path":file,"line":index + 1,"text":line.trim_end(),
                                    "kind":kind.as_str()}),
                                ordinal,
                            )?;
                        }
                        if early && ordinal.saturating_add(1) >= wanted {
                            scan.stopped = Some(TruncatedBy::RowLimit);
                            break;
                        }
                    }
                } else {
                    let mut hit = |first: usize, last: usize, line: usize| -> Result<bool> {
                        let ordinal = match_count + hits;
                        hits += 1;
                        if content && page.wants(ordinal) {
                            page.push(
                                json!({"path":file,"line":if args.line_numbers {line} else {0},
                        "text":excerpt(&text, first, last, args.before_context, args.after_context)}),
                                ordinal,
                            )?;
                        }
                        Ok(early && content && ordinal.saturating_add(1) >= wanted)
                    };
                    let mut start = 0;
                    for (index, raw) in text.split_inclusive('\n').enumerate() {
                        if !scan.running() {
                            break;
                        }
                        let line = raw
                            .strip_suffix('\n')
                            .map(|line| line.strip_suffix('\r').unwrap_or(line))
                            .unwrap_or(raw);
                        if regex.is_match(line)
                            && hit(start, start + line.len().saturating_sub(1), index + 1)?
                        {
                            if content {
                                scan.stopped = Some(TruncatedBy::RowLimit);
                            }
                            break;
                        }
                        start += raw.len();
                    }
                }
                if hits > 0 {
                    let ordinal = file_count;
                    file_count += 1;
                    match_count += hits;
                    if !content && !definitions && args.output_mode != "summary" {
                        page.push(
                            if args.output_mode == "count" {
                                json!({"path":file,"count":hits})
                            } else {
                                json!({"path":file})
                            },
                            ordinal,
                        )?;
                    }
                    if early && !content && !definitions && file_count >= wanted {
                        scan.stopped = Some(TruncatedBy::RowLimit);
                    }
                }
                Ok(())
            })();
            scan.profile.record("matchAndResults", started);
            result
        },
    )?;
    let cursor = actual_cursor(request, cursor, expected, used)?;
    let total = if args.output_mode == "summary" {
        0
    } else if content || definitions {
        match_count
    } else {
        file_count
    };
    let extra = if args.output_mode == "summary" {
        json!({"files":file_count,"matches":match_count})
    } else {
        json!({})
    };
    // `matched` counts every matching line the scan observed; `total` counts the
    // declaration rows this mode returns. A complete scan therefore lets the caller
    // read `matched - total` as the reference hits it did not return.
    let observed = if definitions { observed } else { match_count };
    finish(scan, cursor, page, observed, total, extra)
}

#[cfg(test)]
#[path = "index_source_tests.rs"]
mod index_source_tests;

#[cfg(test)]
#[path = "search_tests.rs"]
mod search_tests;
