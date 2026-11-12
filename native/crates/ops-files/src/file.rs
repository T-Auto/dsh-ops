//! Native file-operation capabilities. All paths are host-resolved absolute paths;
//! this module never invokes a shell and never follows links.
use crate::contract::{Failure, Request, Result};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Shared bound for file reads and proposed write/replacement content.
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
/// Ceiling for one worker response. The host collects worker stdout with
/// `maxBytes: 128 * 1024` and turns a lossy read into `OUTPUT_LIMIT` plus
/// `effectState: "unknown"`, so a response that overflows is reported to the model
/// as an operation whose effect cannot be known — for a pure read, that is both
/// false and useless. Staying under the host cap is what keeps a read honest.
/// The budget is spent on the *serialized* items rather than the payload, because
/// escaping is the multiplier: one NUL byte costs six as `\u0000`, which is how a
/// 32 MiB file once produced 200 MB of stdout.
pub const MAX_OUTPUT_BYTES: usize = 96 * 1024;
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
fn one() -> usize {
    1
}
fn two_hundred() -> usize {
    200
}
fn one_hundred() -> usize {
    100
}
fn utf8() -> String {
    "utf-8".into()
}
fn text() -> String {
    "text".into()
}

pub fn dispatch(request: &Request) -> Result<Value> {
    if let Some(raw) = request.args.get("path").and_then(Value::as_str) {
        request.authorize_path(Path::new(raw))?;
    }
    match request.tool.as_str() {
        "inspect_local_file" => inspect(request),
        "read_files" => many::read_files(request),
        "stat" | "diff" | "write_file" | "edit_file" | "copy" | "move" | "remove" => {
            single::run(request)
        }
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown file capability")),
    }
    .map_err(|mut error| {
        error.message = format!("{}: {}", request.tool, error.message);
        error
    })
}

pub fn target(raw: &str, _allow_missing: bool) -> Result<PathBuf> {
    Ok(crate::file_path::checked(raw)?.display)
}
pub fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}
fn open_read(path: &Path) -> Result<cap_std::fs::File> {
    let raw = path
        .to_str()
        .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let target = crate::file_path::checked(raw).map_err(|mut error| {
        error.message = format!("read path validation: {}", error.message);
        error
    })?;
    crate::file_path::read_file(&target).map_err(|mut error| {
        error.message = format!("read open: {}", error.message);
        error
    })
}

pub fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let mut file = open_read(path)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "File exceeds the 32 MiB in-memory content budget for this operation",
        ));
    }
    Ok(bytes)
}

#[derive(Clone, Debug)]
pub(crate) struct FileFacts {
    pub revision: String,
    pub bytes: u64,
    pub line_count: Option<u64>,
}

/// Hash and count a file without retaining its contents. The small UTF-8 tail
/// carries only an incomplete code point between reads, never the file itself.
pub(crate) fn stream_facts(
    reader: &mut impl Read,
    mut sink: Option<&mut dyn Write>,
) -> Result<FileFacts> {
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut newlines = 0u64;
    let mut last_byte = None;
    let mut valid_utf8 = true;
    let mut utf8_tail = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        hash.update(chunk);
        bytes += read as u64;
        newlines += chunk.iter().filter(|byte| **byte == b'\n').count() as u64;
        last_byte = chunk.last().copied();
        if let Some(writer) = sink.as_deref_mut() {
            writer.write_all(chunk)?;
        }
        if valid_utf8 {
            utf8_tail.extend_from_slice(chunk);
            match std::str::from_utf8(&utf8_tail) {
                Ok(_) => utf8_tail.clear(),
                Err(error) if error.error_len().is_some() => {
                    valid_utf8 = false;
                    utf8_tail.clear();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    utf8_tail.drain(..valid);
                }
            }
        }
    }
    if !utf8_tail.is_empty() {
        valid_utf8 = false;
    }
    let line_count =
        valid_utf8.then(|| newlines + u64::from(bytes != 0 && last_byte != Some(b'\n')));
    Ok(FileFacts {
        revision: format!("{:x}", hash.finalize()),
        bytes,
        line_count,
    })
}

pub(crate) fn read_facts(path: &Path) -> Result<FileFacts> {
    stream_facts(&mut open_read(path)?, None)
}
#[path = "file_many.rs"]
mod many;
#[path = "file_output.rs"]
mod output;
#[path = "file_prefetch.rs"]
mod prefetch;

/// Reserve space for metadata added by search callers after this shared builder.
pub fn result(
    request: &Request,
    items: Vec<Value>,
    total: usize,
    offset: usize,
    next_base: usize,
    matched: usize,
    truncated: bool,
) -> Value {
    output::bounded(
        items,
        total,
        offset,
        next_base,
        matched,
        truncated,
        json!({}),
        MAX_OUTPUT_BYTES - ENVELOPE_OVERHEAD,
        request.output_sink.as_deref().map(|sink| (sink, false)),
    )
}

fn inspect(request: &Request) -> Result<Value> {
    let args: InspectArgs = serde_json::from_value(request.args.clone())?;
    inspect_args(
        args,
        MAX_OUTPUT_BYTES,
        false,
        request.output_sink.as_deref().map(|sink| (sink, false)),
    )
}
fn inspect_args(
    args: InspectArgs,
    budget: usize,
    include_path: bool,
    capture: Option<(&ops_protocol::capture::OutputSink, bool)>,
) -> Result<Value> {
    if args.limit == 0 || args.limit > 10_000 {
        return Err(Failure::new("INVALID_ARGUMENT", "inspect limit is 1-10000"));
    }
    if !args.encoding.eq_ignore_ascii_case("utf-8") {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "Invalid argument `encoding`: text inspection supports UTF-8 only",
        ));
    }
    if args.view == "hex" {
        return inspect_hex(args, include_path);
    }
    if args.view != "text" {
        return Err(Failure::new("INVALID_ARGUMENT", "view must be text or hex"));
    }
    let prepared = load_inspection(&args.path)?;
    inspect_prepared(args, prepared, budget, include_path, capture)
}

fn inspect_hex(args: InspectArgs, include_path: bool) -> Result<Value> {
    let path = target(&args.path, false)?;
    if !path.is_file() {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "path is a directory; choose a file, or list directory entries with the shell",
        ));
    }
    let mut file = open_read(&path)?;
    // Revision and lineCount remain whole-file facts, but are streamed. Only the
    // requested hex window is retained, regardless of the file's total size.
    let facts = stream_facts(&mut file, None)?;
    let total = facts.bytes;
    let start = (args.offset.saturating_sub(1).saturating_mul(16) as u64).min(total);
    let length = (args.limit.min(1900) * 16) as u64;
    file.seek(SeekFrom::Start(start))?;
    let mut window = Vec::with_capacity(length.min(total - start) as usize);
    std::io::Read::by_ref(&mut file)
        .take(length.min(total - start))
        .read_to_end(&mut window)?;
    let end = start + window.len() as u64;
    let text = window
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut value = json!({"status":"completed","phase":"verify","changed":0,"matched":1,"skipped":start,"failed":0,"complete":end == total,"truncated":end < total,"nextOffset":end.div_ceil(16)+1,"omitted":total.saturating_sub(end),"bytesTotal":total,"revision":facts.revision,"bytes":facts.bytes,"lineCount":facts.line_count,"items":[{"path":path,"view":"hex","offset":start,"text":text}]});
    if include_path {
        value["path"] = json!(path);
    }
    Ok(value)
}
struct PreparedInspection {
    path: PathBuf,
    bytes: Vec<u8>,
}
fn load_inspection(raw: &str) -> Result<PreparedInspection> {
    let path = target(raw, false)?;
    if !path.is_file() {
        return Err(Failure::new(
            "INVALID_ARGUMENT",
            "path is a directory; choose a file, or list directory entries with the shell",
        ));
    }
    let bytes = read_bytes(&path)?;
    Ok(PreparedInspection { path, bytes })
}
fn inspect_prepared(
    args: InspectArgs,
    prepared: PreparedInspection,
    budget: usize,
    include_path: bool,
    capture: Option<(&ops_protocol::capture::OutputSink, bool)>,
) -> Result<Value> {
    let PreparedInspection { path, bytes } = prepared;
    let mut facts = content_facts(&bytes);
    if include_path {
        facts["path"] = json!(path);
    }
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "file exceeds the 32 MiB in-memory content budget for text inspection",
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| Failure::new("ERR_INVALID_ENCODING", "File is not valid UTF-8"))?;
    // str::lines splits physical LF/CRLF, never bare CR or Unicode separators.
    // Empty files have zero lines; a final LF does not create a phantom line.
    let lines: Vec<_> = text
        .lines()
        .enumerate()
        .skip(args.offset.saturating_sub(1))
        .take(args.limit)
        .map(|(i, line)| json!({"path":path,"line":i+1,"text":line}))
        .collect();
    let value = output::bounded(
        lines,
        text.lines().count(),
        args.offset.saturating_sub(1),
        args.offset,
        text.lines().count(),
        false,
        facts,
        budget,
        capture,
    );
    if output::size(&value) + 1 > budget && capture.is_none() {
        return Err(Failure::new(
            "OUTPUT_LIMIT",
            "File metadata exceeds the remaining output budget",
        ));
    }
    Ok(value)
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
struct PreservedMetadata {
    mode: u32,
    uid: u32,
    gid: u32,
    acl: Option<Vec<u8>>,
    xattrs: Vec<(String, Vec<u8>)>,
}

/// Read one extended attribute, or `None` when it is absent or unsupported.
#[cfg(unix)]
fn get_xattr(fd: &impl rustix::fd::AsFd, name: &str) -> Result<Option<Vec<u8>>> {
    let mut probe: [u8; 0] = [];
    match rustix::fs::fgetxattr(fd, name, &mut probe[..]) {
        Ok(size) => {
            let mut buffer = vec![0u8; size];
            let written = rustix::fs::fgetxattr(fd, name, &mut buffer[..]).map_err(|error| {
                Failure::new(
                    "ACCESS_DENIED",
                    format!("Read extended attribute {name}: {error}"),
                )
            })?;
            buffer.truncate(written);
            Ok(Some(buffer))
        }
        Err(error)
            if matches!(error, rustix::io::Errno::NODATA | rustix::io::Errno::NOTSUP)
                || (cfg!(target_os = "macos")
                    && error == rustix::io::Errno::from_raw_os_error(93)) =>
        {
            Ok(None)
        }
        Err(error) => Err(Failure::new(
            "ACCESS_DENIED",
            format!("Read extended attribute {name}: {error}"),
        )),
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
        Err(error) => {
            return Err(Failure::new(
                "ACCESS_DENIED",
                format!("List extended attributes: {error}"),
            ));
        }
    };
    let mut buffer = vec![0u8; size];
    let written = rustix::fs::flistxattr(fd, &mut buffer[..]).map_err(|error| {
        Failure::new(
            "ACCESS_DENIED",
            format!("List extended attributes: {error}"),
        )
    })?;
    buffer.truncate(written);
    Ok(buffer
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .collect())
}

#[cfg(unix)]
impl PreservedMetadata {
    fn of(target: &crate::file_path::Target) -> Result<Self> {
        let file = crate::file_path::read_file(target)?;
        let stat = rustix::fs::fstat(&file).map_err(|error| {
            Failure::new(
                "ACCESS_DENIED",
                format!("Stat {}: {error}", target.display.display()),
            )
        })?;
        let mut xattrs = Vec::new();
        for name in list_xattrs(&file)? {
            if name == ACL_XATTR {
                continue;
            }
            if let Some(value) = get_xattr(&file, &name)? {
                xattrs.push((name, value))
            }
        }
        Ok(Self {
            mode: stat.st_mode as u32,
            uid: stat.st_uid as u32,
            gid: stat.st_gid as u32,
            acl: get_xattr(&file, ACL_XATTR)?,
            xattrs,
        })
    }
    /// Reapply onto the replacement. `Err` forbids publication; `Ok` may still
    /// carry warnings for whatever could not be restored.
    fn restore(&self, file: &cap_std::fs::File) -> Result<(Value, Vec<String>)> {
        let mut warnings = Vec::new();
        let current = rustix::fs::fstat(file)
            .map_err(|error| Failure::new("ACCESS_DENIED", format!("Stat replacement: {error}")))?;
        let owner = if (self.uid, self.gid) == (current.st_uid as u32, current.st_gid as u32) {
            true
        } else {
            match rustix::fs::fchown(
                file,
                Some(rustix::process::Uid::from_raw(self.uid)),
                Some(rustix::process::Gid::from_raw(self.gid)),
            ) {
                Ok(()) => true,
                Err(error) => {
                    warnings.push(format!("owner {}:{} was not restored ({error}); the replacement is owned by the current user", self.uid, self.gid));
                    false
                }
            }
        };
        // Extended attributes go on before the final mode, while the replacement is
        // still writable. A read-only mode such as `0400` denies `setxattr` outright,
        // so restoring them afterwards reported every captured attribute — including
        // the `com.apple.provenance` macOS gives every new file — as unrestored.
        let mut restored = Vec::new();
        for (name, value) in &self.xattrs {
            match rustix::fs::fsetxattr(file, name.as_str(), value, rustix::fs::XattrFlags::empty())
            {
                Ok(()) => restored.push(name.clone()),
                Err(error) => warnings.push(format!(
                    "extended attribute {name} was not restored ({error})"
                )),
            }
        }
        // The mode goes on after the owner, because a successful `chown` clears
        // setuid and setgid. This one is fatal if it fails.
        rustix::fs::fchmod(
            file,
            rustix::fs::Mode::from_bits_truncate((self.mode & 0o7777) as _),
        )
        .map_err(|error| {
            Failure::new(
                "ACCESS_DENIED",
                format!(
                    "Mode {:04o} could not be preserved ({error}); nothing was published",
                    self.mode & 0o7777
                ),
            )
        })?;
        // The ACL goes on after the mode, because `chmod` rewrites an ACL's mask
        // entry; applying the captured attribute last reproduces the original pair.
        let acl = match &self.acl {
            Some(acl) => {
                rustix::fs::fsetxattr(file, ACL_XATTR, acl, rustix::fs::XattrFlags::empty())
                    .map_err(|error| {
                        Failure::new(
                            "ACCESS_DENIED",
                            format!(
                                "POSIX ACL could not be preserved ({error}); nothing was published"
                            ),
                        )
                    })?;
                true
            }
            None => {
                // A new inode can inherit a parent's default ACL even when the old
                // inode had no access ACL. Do not publish those inherited grants.
                #[cfg(target_os = "linux")]
                match rustix::fs::fremovexattr(file, ACL_XATTR) {
                    Ok(()) => (),
                    Err(rustix::io::Errno::NODATA | rustix::io::Errno::NOTSUP) => (),
                    Err(error) => {
                        return Err(Failure::new(
                            "ACCESS_DENIED",
                            format!(
                                "Inherited POSIX ACL could not be cleared ({error}); nothing was published"
                            ),
                        ));
                    }
                }
                false
            }
        };
        let omitted = restored.len().saturating_sub(16);
        restored.truncate(16);
        let omitted_warnings = warnings.len().saturating_sub(16);
        warnings.truncate(16);
        if omitted_warnings > 0 {
            warnings.push(format!(
                "{omitted_warnings} additional metadata warnings omitted"
            ));
        }
        Ok((
            json!({"mode": format!("{:04o}", self.mode & 0o7777), "owner": owner, "acl": acl, "xattrs": restored, "xattrsOmitted": omitted}),
            warnings,
        ))
    }
}

/// Lock the update sidecar for this target's name before reading the target.
///
/// Target-inode locks are insufficient across atomic rename: a waiter can retain
/// the old inode while the path already names a new one. Cooperating writers all
/// lock one stable sidecar per target *name* beside the target and hold it until
/// publication and directory sync; the guard removes the sidecar when it drops.
/// Non-cooperating writers remain outside this advisory serialization contract.
///
/// The lock is taken *before* the target is read, so a refusal decided from the
/// bytes (a stale `expectedRevision`, an edit conflict, a missing target) happens
/// under the lock. Nothing is left behind by any of those paths: the guard in
/// [`UpdateLock`] removes the sidecar it locked on release, and its identity
/// check keeps a name that a finishing holder already replaced.
///
/// The sidecar stays invisible to every selection tool. The name starts with `.`,
/// and the walker drops any path with a hidden component (`hidden`) before a glob
/// can match it, so `ops_glob`, `ops_grep` and a directory-wide `ops_replace`
/// never return, count or rewrite one; `ops_batch` resolves its operations from
/// the request, never from a walk.
pub fn lock_for_update(file: &Path) -> Result<UpdateLock> {
    let raw = file
        .to_str()
        .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked_leaf(raw, true)?;
    // The lock inode must survive replacement of the target inode, so it is a
    // sidecar next to it, keyed by the target's name and not by its bytes.
    let key = format!(
        "{:x}",
        Sha256::digest(checked.name.to_lowercase().as_bytes())
    );
    UpdateLock::acquire(
        &checked.parent,
        &format!(".dsh-ops-update-{key}.lock"),
        "another writer is updating this path; nothing was changed, retry",
    )
}
pub fn lock_and_read_for_update(file: &Path) -> Result<(UpdateLock, Vec<u8>)> {
    let lock = lock_for_update(file)?;
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
                let own = leftover
                    .strip_prefix(&prefix)
                    .and_then(|tail| uuid::Uuid::parse_str(tail).ok())
                    .is_some_and(|parsed| parsed.get_version_num() == 4);
                if own {
                    let _ = parent.remove_file(&leftover);
                }
            }
        }
    }
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<Option<(Value, Vec<String>)>> {
    let raw = path
        .to_str()
        .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked(raw)?;
    // Capture what the file carries before creating its replacement: publication is
    // a rename, so the new inode arrives with none of it.
    #[cfg(unix)]
    let preserved = PreservedMetadata::of(&checked)?;
    #[cfg(windows)]
    let preserved = publication::Preserved::capture(&checked, true)?;
    #[cfg(target_os = "macos")]
    dsh_ops_darwin_metadata::require_no_extended_acl(
        &crate::file_path::read_file(&checked)?.into_std(),
    )
    .map_err(|error| Failure::new("METADATA_UNSUPPORTED", error))?;
    let parent = &checked.parent;
    let name = &checked.name;
    sweep_debris(parent, name);
    let temporary = format!(".{name}.dsh-ops-{}", uuid::Uuid::new_v4());
    let mut file = publication::create_sibling(parent, &temporary, Some(&checked))?;
    // Keep content private until final metadata is restored. Creation mode also
    // masks inherited ACL grants; never write sensitive bytes to a default 0666 inode.
    let prepared = (|| -> Result<Option<(Value, Vec<String>)>> {
        file.write_all(bytes)?;
        #[cfg(any(unix, windows))]
        let report = Some(preserved.restore(&file)?);
        // Both bytes and restored mode/owner/ACL/xattrs must be durable before rename.
        file.sync_all()?;
        Ok(report)
    })();
    let report = match prepared {
        Ok(report) => report,
        Err(failure) => {
            publication::discard_sibling(parent, &temporary, file)?;
            return Err(failure);
        }
    };
    if let Err(failure) = parent
        .symlink_metadata(name)
        .map_err(Failure::from)
        .and_then(|metadata| crate::file_path::regular(&metadata, false))
    {
        publication::discard_sibling(parent, &temporary, file)?;
        return Err(failure);
    }
    // Publication stays handle-relative and does not traverse links.
    let publish = parent.rename(&temporary, parent, name);
    if let Err(error) = publish {
        publication::discard_sibling(parent, &temporary, file)?;
        return Err(Failure::new(
            "ACCESS_DENIED",
            format!("Atomic replacement publish: {error}"),
        ));
    }
    drop(file);
    #[cfg(windows)]
    preserved.verify(parent, name)?;
    #[cfg(unix)]
    if let Err(error) = crate::sync_directory(parent) {
        // The rename already happened, so the file *is* replaced. Reporting the
        // default `effect_state: "none"` here would tell the caller that nothing
        // changed, which is the one answer a caller must never get wrong: it would
        // invite a repeat of a write that has already been applied.
        let mut failure = Failure::new(
            "SYNC_FAILED",
            format!(
                "Atomic replacement published, but the directory entry could not be synced: {}",
                error.message
            ),
        );
        failure.phase = "publish".into();
        failure.effect_state = "applied".into();
        failure.next_action = "The replacement is already published; do not repeat it. Verify the file if durability matters.".into();
        return Err(failure);
    }
    Ok(report)
}

#[path = "file_publication.rs"]
mod publication;

#[path = "file_update_lock.rs"]
mod update_lock;
pub use update_lock::UpdateLock;

#[path = "file_single.rs"]
mod single;
use single::content_facts;

pub use publication::{authorize_write, check_revision};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_facts_match_whole_content_across_utf8_boundaries() {
        let mut bytes = vec![b'a'; 65_535];
        bytes.extend_from_slice("α\r\nβ".as_bytes());
        bytes.extend_from_slice(b"\nlast");
        let facts = stream_facts(&mut &bytes[..], None).unwrap();
        assert_eq!(facts.revision, format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(facts.bytes, bytes.len() as u64);
        assert_eq!(
            facts.line_count.map(|count| count as usize),
            std::str::from_utf8(&bytes)
                .ok()
                .map(|text| text.lines().count())
        );
        for bytes in [
            &b""[..],
            &b"\n"[..],
            &b"one\n"[..],
            &b"one"[..],
            &b"\xff"[..],
        ] {
            let facts = stream_facts(&mut &bytes[..], None).unwrap();
            assert_eq!(facts.bytes, bytes.len() as u64);
            assert_eq!(
                facts.line_count.map(|count| count as usize),
                std::str::from_utf8(bytes)
                    .ok()
                    .map(|text| text.lines().count())
            );
        }
    }

    #[test]
    fn unsupported_inspect_encoding_names_the_argument() {
        let error = inspect_args(
            InspectArgs {
                path: "not-read".into(),
                offset: 1,
                limit: 1,
                encoding: "utf-16".into(),
                view: "text".into(),
            },
            MAX_OUTPUT_BYTES,
            false,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(error.message.contains("`encoding`"));
        assert!(!error.next_action.contains("view=hex"));
    }

    #[test]
    fn hex_reads_a_bounded_window_beyond_the_content_budget() {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dsh-ops-large-hex-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("large.bin");
        let length = MAX_FILE_BYTES + 17;
        std::fs::File::create(&path)
            .unwrap()
            .set_len(length)
            .unwrap();
        let error = read_bytes(&path).unwrap_err();
        assert_eq!(error.code, "OUTPUT_LIMIT");
        assert!(error.message.contains("32 MiB in-memory content budget"));

        let offset = (MAX_FILE_BYTES / 16 + 1) as usize;
        let value = inspect_args(
            InspectArgs {
                path: path.to_string_lossy().into_owned(),
                offset,
                limit: 2,
                encoding: utf8(),
                view: "hex".into(),
            },
            MAX_OUTPUT_BYTES,
            false,
            None,
        )
        .unwrap();
        assert_eq!(value["bytesTotal"], json!(length));
        assert_eq!(value["items"][0]["offset"], json!(MAX_FILE_BYTES));
        assert_eq!(value["items"][0]["text"], json!(vec!["00"; 17].join(" ")));
        assert_eq!(value["complete"], json!(true));
        assert_eq!(value["omitted"], json!(0));
        std::fs::remove_dir_all(root).unwrap();
    }
}
