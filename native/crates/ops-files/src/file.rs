//! Native file-operation capabilities. All paths are host-resolved absolute paths;
//! this module never invokes a shell and never follows links.
use crate::contract::{Failure, Request, Result};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
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
fn one() -> usize { 1 }
fn two_hundred() -> usize { 200 }
fn one_hundred() -> usize { 100 }
fn utf8() -> String { "utf-8".into() }
fn text() -> String { "text".into() }

pub fn dispatch(request: &Request) -> Result<Value> {
    if let Some(raw) = request.args.get("path").and_then(Value::as_str) { request.authorize_path(Path::new(raw))?; }
    match request.tool.as_str() {
        "inspect_local_file" => inspect(request),
        "read_files" => many::read_files(request),
        "stat" | "diff" | "write_file" | "edit_file" | "copy" | "move" | "remove" => single::run(request),
        _ => Err(Failure::new("INVALID_ARGUMENT", "Unknown file capability")),
    }.map_err(|mut error| { error.message = format!("{}: {}", request.tool, error.message); error })
}

pub fn target(raw: &str, _allow_missing: bool) -> Result<PathBuf> {
    Ok(crate::file_path::checked(raw)?.display)
}
pub fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}
pub fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let target = crate::file_path::checked(raw).map_err(|mut error| { error.message = format!("read path validation: {}", error.message); error })?;
    let mut file = crate::file_path::read_file(&target).map_err(|mut error| { error.message = format!("read open: {}", error.message); error })?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file).take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "File exceeds the bounded read budget")); }
    Ok(bytes)
}
#[path = "file_output.rs"]
mod output;
#[path = "file_many.rs"]
mod many;

/// Reserve space for metadata added by search callers after this shared builder.
pub fn result(request: &Request, items: Vec<Value>, total: usize, offset: usize, next_base: usize, matched: usize, truncated: bool) -> Value {
    output::bounded(items, total, offset, next_base, matched, truncated, json!({}), MAX_OUTPUT_BYTES - ENVELOPE_OVERHEAD, request.output_sink.as_deref().map(|sink| (sink, false)))
}

fn inspect(request: &Request) -> Result<Value> {
    let args: InspectArgs = serde_json::from_value(request.args.clone())?;
    inspect_args(args, MAX_OUTPUT_BYTES, false, request.output_sink.as_deref().map(|sink| (sink, false)))
}
fn inspect_args(args: InspectArgs, budget: usize, include_path: bool, capture: Option<(&ops_protocol::capture::OutputSink, bool)>) -> Result<Value> {
    if args.limit == 0 || args.limit > 10_000 { return Err(Failure::new("INVALID_ARGUMENT", "inspect limit is 1-10000")); }
    if !args.encoding.eq_ignore_ascii_case("utf-8") { return Err(Failure::new("ERR_INVALID_ENCODING", "Text inspection supports UTF-8 only")); }
    let path = target(&args.path, false)?;
    if !path.is_file() { return Err(Failure::new("INVALID_ARGUMENT", "path is a directory; use ops_glob or ops_grep")); }
    let bytes = read_bytes(&path)?;
    let mut facts = content_facts(&bytes);
    if include_path { facts["path"] = json!(path); }
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err(Failure::new("OUTPUT_LIMIT", "file exceeds the inspect size budget")); }
    if args.view == "hex" {
        // `offset` means the same thing in both views: the 1-based unit to start
        // from — line N for text, 16-byte row N for hex. It used to count rows
        // from zero here while the text branch counted lines from one, so the
        // declared default of 1 skipped the first row, and the declared
        // `minimum: 1` left no way to ask for it back: any file of at most 16
        // bytes read back as an empty string. In this view `skipped` and the item
        // `offset` are byte counts, not row counts.
        let start = args.offset.saturating_sub(1).saturating_mul(16).min(bytes.len()); let end = (start + args.limit.min(1900) * 16).min(bytes.len());
        let text = bytes[start..end].iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
        return Ok(json!({"status":"completed","phase":"verify","changed":0,"matched":1,"skipped":start,"failed":0,"complete":end == bytes.len(),"truncated":end < bytes.len(),"nextOffset":end.div_ceil(16)+1,"omitted":bytes.len().saturating_sub(end),"bytesTotal":bytes.len(),"revision":facts["revision"],"bytes":facts["bytes"],"lineCount":facts["lineCount"],"items":[{"path":path,"view":"hex","offset":start,"text":text}]}));
    }
    if args.view != "text" { return Err(Failure::new("INVALID_ARGUMENT", "view must be text or hex")); }
    let text = String::from_utf8(bytes).map_err(|_| Failure::new("ERR_INVALID_ENCODING", "File is not valid UTF-8"))?;
    // str::lines splits physical LF/CRLF, never bare CR or Unicode separators.
    // Empty files have zero lines; a final LF does not create a phantom line.
    let lines: Vec<_> = text.lines().enumerate().skip(args.offset.saturating_sub(1)).take(args.limit).map(|(i, line)| json!({"path":path,"line":i+1,"text":line})).collect();
    let value = output::bounded(lines, text.lines().count(), args.offset.saturating_sub(1), args.offset, text.lines().count(), false, facts, budget, capture);
    if output::size(&value) + 1 > budget && capture.is_none() {
        return Err(Failure::new("OUTPUT_LIMIT", "File metadata exceeds the remaining output budget"));
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
        // Extended attributes go on before the final mode, while the replacement is
        // still writable. A read-only mode such as `0400` denies `setxattr` outright,
        // so restoring them afterwards reported every captured attribute — including
        // the `com.apple.provenance` macOS gives every new file — as unrestored.
        let mut restored = Vec::new();
        for (name, value) in &self.xattrs {
            match rustix::fs::fsetxattr(file, name.as_str(), value, rustix::fs::XattrFlags::empty()) { Ok(()) => restored.push(name.clone()), Err(error) => warnings.push(format!("extended attribute {name} was not restored ({error})")) }
        }
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
        let omitted = restored.len().saturating_sub(16); restored.truncate(16);
        let omitted_warnings = warnings.len().saturating_sub(16); warnings.truncate(16);
        if omitted_warnings > 0 { warnings.push(format!("{omitted_warnings} additional metadata warnings omitted")); }
        Ok((json!({"mode": format!("{:04o}", self.mode & 0o7777), "owner": owner, "acl": acl, "xattrs": restored, "xattrsOmitted": omitted}), warnings))
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
pub fn lock_and_read_for_update(file: &Path) -> Result<(UpdateLock, Vec<u8>)> {
    let raw = file.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked_leaf(raw, true)?;
    // The lock inode must survive replacement of the target inode, so it is a
    // sidecar next to it, keyed by the target's name and not by its bytes.
    let key = format!("{:x}", Sha256::digest(checked.name.to_lowercase().as_bytes()));
    let lock = UpdateLock::acquire(&checked.parent, &format!(".dsh-ops-update-{key}.lock"), "another writer is updating this path; nothing was changed, retry")?;
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
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<Option<(Value, Vec<String>)>> {
    let raw = path.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
    let checked = crate::file_path::checked(raw)?;
    // Capture what the file carries before creating its replacement: publication is
    // a rename, so the new inode arrives with none of it.
    #[cfg(unix)]
    let preserved = PreservedMetadata::of(&checked)?;
    #[cfg(windows)]
    let preserved = publication::Preserved::capture(&checked, true)?;
    #[cfg(target_os = "macos")]
    dsh_ops_darwin_metadata::require_no_extended_acl(&crate::file_path::read_file(&checked)?.into_std())
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
        Err(failure) => { publication::discard_sibling(parent, &temporary, file)?; return Err(failure); }
    };
    if let Err(failure) = parent.symlink_metadata(name).map_err(Failure::from).and_then(|metadata| crate::file_path::regular(&metadata, false)) {
        publication::discard_sibling(parent, &temporary, file)?;
        return Err(failure);
    }
    // Publication stays handle-relative and does not traverse links.
    let publish = parent.rename(&temporary, parent, name);
    if let Err(error) = publish {
        publication::discard_sibling(parent, &temporary, file)?;
        return Err(Failure::new("ACCESS_DENIED", format!("Atomic replacement publish: {error}")));
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
        let mut failure = Failure::new("SYNC_FAILED", format!("Atomic replacement published, but the directory entry could not be synced: {}", error.message));
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
