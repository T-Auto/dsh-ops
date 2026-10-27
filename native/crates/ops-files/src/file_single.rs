//! Single-regular-file operations sharing file.rs's no-follow and metadata primitives.
use super::*;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StatArgs {
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WriteArgs {
    path: String,
    content: String,
    expected_revision: String,
    #[serde(default)]
    dry_run: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TextEdit {
    old_text: String,
    new_text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EditArgs {
    path: String,
    edits: Vec<TextEdit>,
    expected_revision: String,
    #[serde(default)]
    dry_run: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TransferArgs {
    path: String,
    to: String,
    expected_revision: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RemoveArgs {
    path: String,
    expected_revision: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DiffArgs {
    path: String,
    content: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "one_hundred")]
    limit: usize,
}

pub(super) fn content_facts(bytes: &[u8]) -> Value {
    json!({"revision":format!("{:x}", Sha256::digest(bytes)), "bytes":bytes.len(),
        "lineCount":std::str::from_utf8(bytes).ok().map(|s| s.lines().count())})
}
pub(super) fn run(request: &Request) -> Result<Value> {
    match request.tool.as_str() {
        "stat" => stat_file(request),
        "diff" => diff_file(request),
        "write_file" => {
            let args: WriteArgs = serde_json::from_value(request.args.clone())?;
            write_single(
                request,
                &args.path,
                &args.expected_revision,
                args.dry_run,
                |_| Ok(args.content.clone().into_bytes()),
            )
        }
        "edit_file" => {
            let args: EditArgs = serde_json::from_value(request.args.clone())?;
            valid_revision(&args.expected_revision, false)?;
            write_single(
                request,
                &args.path,
                &args.expected_revision,
                args.dry_run,
                |original| {
                    let text = std::str::from_utf8(original.ok_or_else(|| {
                        Failure::new("NOT_FOUND", "Edit requires an existing file")
                    })?)
                    .map_err(|_| Failure::new("ERR_INVALID_ENCODING", "Edit requires UTF-8"))?;
                    if args.edits.is_empty() || args.edits.len() > 100 {
                        return Err(Failure::new("INVALID_ARGUMENT", "Use 1-100 exact edits"));
                    }
                    let mut spans = Vec::new();
                    for edit in &args.edits {
                        if edit.old_text.is_empty() {
                            return Err(Failure::new(
                                "INVALID_ARGUMENT",
                                "oldText must not be empty",
                            ));
                        }
                        // Count overlapping occurrences as well ("aa" in "aaa" is ambiguous).
                        let at = text.find(&edit.old_text).ok_or_else(|| {
                            Failure::new(
                                "EDIT_CONFLICT",
                                "oldText was not found; inspect the current file",
                            )
                        })?;
                        let next_character = text[at..]
                            .chars()
                            .next()
                            .expect("nonempty match")
                            .len_utf8();
                        if text[at + next_character..].contains(&edit.old_text) {
                            return Err(Failure::new(
                                "EDIT_CONFLICT",
                                "oldText is not unique; include more surrounding text",
                            ));
                        }
                        spans.push((at, at + edit.old_text.len(), edit.new_text.as_str()));
                    }
                    spans.sort_by_key(|span| span.0);
                    if spans.windows(2).any(|pair| pair[0].1 > pair[1].0) {
                        return Err(Failure::new(
                            "EDIT_CONFLICT",
                            "Edits overlap in the original file; no edits applied",
                        ));
                    }
                    let mut next = String::new();
                    let mut cursor = 0;
                    for (start, end, replacement) in spans {
                        next.push_str(&text[cursor..start]);
                        next.push_str(replacement);
                        cursor = end;
                    }
                    next.push_str(&text[cursor..]);
                    Ok(next.into_bytes())
                },
            )
        }
        "copy" | "move" => transfer_file(request),
        "remove" => remove_file(request),
        _ => Err(Failure::new(
            "INVALID_ARGUMENT",
            "Unknown single file operation",
        )),
    }
}
fn valid_revision(revision: &str, absent: bool) -> Result<()> {
    if (absent && revision == "absent")
        || (revision.len() == 64
            && revision
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    {
        return Ok(());
    }
    Err(Failure::new(
        "INVALID_ARGUMENT",
        "expectedRevision must be an observed lowercase SHA-256 (write create-only also accepts absent)",
    ))
}
fn check_revision(bytes: Option<&[u8]>, expected: &str) -> Result<()> {
    let revision = bytes
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        .unwrap_or_else(|| "absent".into());
    if revision != expected {
        return Err(Failure::new(
            "REVISION_CONFLICT",
            "Revision differs from expectedRevision; nothing was changed. Inspect before retrying.",
        ));
    }
    Ok(())
}
pub(super) fn authorize_write(request: &Request, raw: &str) -> Result<PathBuf> {
    if request.read_only {
        return Err(Failure::policy(
            "read-only",
            "User authorization is read-only. Ask the user to select workspace-write; do not retry or bypass.",
        ));
    }
    let checked = crate::file_path::checked_leaf(raw, true)?;
    request.authorize_path(&checked.display)?;
    if let Some(roots) = &request.write_roots {
        // Canonicalize only after rejecting linked ancestry. A missing leaf uses its parent identity.
        let parent = std::fs::canonicalize(
            checked
                .display
                .parent()
                .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "No parent"))?,
        )?;
        let candidate = parent.join(&checked.name);
        if !roots
            .iter()
            .any(|root| std::fs::canonicalize(root).is_ok_and(|root| candidate.starts_with(root)))
        {
            return Err(Failure::policy(
                "write-roots",
                "User authorized workspace writes only. Ask the user for full access for an external target; do not retry or bypass.",
            ));
        }
    }
    Ok(checked.display)
}
/// Same per-name update lock as [`lock_and_read_for_update`], returned as the
/// caller's guard so the sidecar lives exactly as long as the write it protects.
fn lock_single(raw: &str) -> Result<UpdateLock> {
    let checked = crate::file_path::checked_leaf(raw, true)?;
    let key = format!(
        "{:x}",
        Sha256::digest(checked.name.to_lowercase().as_bytes())
    );
    UpdateLock::acquire(
        &checked.parent,
        &format!(".dsh-ops-update-{key}.lock"),
        "Another writer holds this path; inspect before retrying",
    )
}
fn optional_bytes(raw: &str) -> Result<Option<Vec<u8>>> {
    let checked = crate::file_path::checked_leaf(raw, true)?;
    match checked.parent.symlink_metadata(&checked.name) {
        Ok(_) => Ok(Some(read_bytes(&checked.display)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn stat_file(request: &Request) -> Result<Value> {
    let args: StatArgs = serde_json::from_value(request.args.clone())?;
    let checked = crate::file_path::checked_leaf(&args.path, true)?;
    let Some(bytes) = optional_bytes(&args.path)? else {
        return Ok(
            json!({"status":"completed","complete":true,"exists":false,"revision":"absent","items":[]}),
        );
    };
    let metadata = crate::file_path::read_file(&checked)?.metadata()?;
    let mut output = content_facts(&bytes);
    output["status"] = json!("completed");
    output["complete"] = json!(true);
    output["exists"] = json!(true);
    output["path"] = json!(checked.display);
    output["readonly"] = json!(metadata.permissions().readonly());
    output["modifiedMs"] = json!(
        metadata
            .modified()
            .ok()
            .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_millis())
    );
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        output["mode"] = json!(format!("{:04o}", metadata.permissions().mode() & 0o7777));
    }
    Ok(output)
}
fn diff_file(request: &Request) -> Result<Value> {
    let args: DiffArgs = serde_json::from_value(request.args.clone())?;
    if args.limit == 0 || args.limit > 1000 {
        return Err(Failure::new("INVALID_ARGUMENT", "diff limit is 1-1000"));
    }
    let bytes = read_bytes(Path::new(&args.path))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| Failure::new("ERR_INVALID_ENCODING", "Diff requires UTF-8"))?;
    let old: Vec<_> = text.split_inclusive('\n').collect();
    let new: Vec<_> = args.content.split_inclusive('\n').collect();
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let removed = &old[prefix..old.len() - suffix];
    let added = &new[prefix..new.len() - suffix];
    let total = removed.len() + added.len();
    let items = removed
        .iter()
        .enumerate()
        .map(|(i, line)| json!({"kind":"remove","line":prefix+i+1,"text":line}))
        .chain(
            added
                .iter()
                .enumerate()
                .map(|(i, line)| json!({"kind":"add","line":prefix+i+1,"text":line})),
        )
        .skip(args.offset)
        .take(args.limit)
        .collect();
    let mut output = result(request, items, total, args.offset, args.offset, total, false);
    output["before"] = content_facts(&bytes);
    output["after"] = content_facts(args.content.as_bytes());
    output["hunk"] = json!({"startLine":prefix+1,"removed":removed.len(),"added":added.len()});
    Ok(output)
}
fn receipt(path: &Path, before: Option<&[u8]>, next: &[u8], dry_run: bool, changed: bool) -> Value {
    let mut item = content_facts(next);
    item["path"] = json!(path);
    item["bytesAfter"] = json!(next.len());
    item["bytesBefore"] = json!(before.map_or(0, |b| b.len()));
    item["revisionBefore"] = json!(
        before
            .map(|b| format!("{:x}", Sha256::digest(b)))
            .unwrap_or_else(|| "absent".into())
    );
    let mut output = content_facts(next);
    output["status"] = json!("completed");
    output["phase"] = json!(if dry_run { "observe" } else { "verify" });
    output["complete"] = json!(true);
    output["changed"] = json!(usize::from(changed && !dry_run));
    output["dryRun"] = json!(dry_run);
    output["items"] = json!([item]);
    output
}
fn write_single(
    request: &Request,
    raw: &str,
    expected: &str,
    dry_run: bool,
    prepare: impl Fn(Option<&[u8]>) -> Result<Vec<u8>>,
) -> Result<Value> {
    valid_revision(expected, true)?;
    let path = authorize_write(request, raw)?;
    // Every validation below is a pure function of the bytes and the arguments, so it also runs
    // once *before* the update sidecar exists: a request that is going to be refused must not
    // leave a `.dsh-ops-update-*.lock` beside a file it never touched. The pass under the lock is
    // still the authoritative one — a concurrent writer may replace the file in between.
    let validate = |bytes: Option<&[u8]>| -> Result<Vec<u8>> {
        check_revision(bytes, expected)?;
        let next = prepare(bytes)?;
        if next.len() as u64 > MAX_FILE_BYTES {
            return Err(Failure::new("OUTPUT_LIMIT", "Proposed file exceeds 32 MiB"));
        }
        Ok(next)
    };
    let snapshot = optional_bytes(raw)?;
    let preview = validate(snapshot.as_deref())?;
    if dry_run {
        // A dry run answers a question; it must not create the persistent lock sidecar.
        let changed = snapshot.as_deref() != Some(preview.as_slice());
        return Ok(receipt(&path, snapshot.as_deref(), &preview, true, changed));
    }
    let _lock = lock_single(raw)?;
    let original = optional_bytes(raw)?;
    // `prepare` is pure, so the snapshot's result is still exact when the locked read returned the
    // same bytes, and the locked comparison is what makes that claim authoritative. Re-planning the
    // same input would only duplicate the copy of the proposed content on every write.
    let next = if original.as_deref() == snapshot.as_deref() { preview } else { validate(original.as_deref())? };
    let changed = original.as_deref() != Some(next.as_slice());
    let mut output = receipt(&path, original.as_deref(), &next, false, changed);
    if !changed {
        return Ok(output);
    }
    authorize_write(request, raw)?;
    check_revision(optional_bytes(raw)?.as_deref(), expected)?;
    if original.is_some() {
        if let Some((metadata, warnings)) = atomic_write(&path, &next)? {
            output["items"][0]["metadata"] = metadata;
            if !warnings.is_empty() {
                output["items"][0]["metadataWarnings"] = json!(warnings);
            }
        }
    } else {
        publish_new(&path, &next, None, None)?;
        output["items"][0]["metadata"] = json!({"created":true});
    }
    Ok(output)
}
/// Prepare a private sibling, then hard-link it to an absent destination. Unlike
/// rename this publication cannot clobber even a non-cooperating creator.
fn publish_new(
    path: &Path,
    bytes: &[u8],
    source: Option<&crate::file_path::Target>,
    expected_source: Option<&str>,
) -> Result<()> {
    let checked = crate::file_path::checked_leaf(
        path.to_str()
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?,
        true,
    )?;
    #[cfg(windows)]
    let preserved = source.map(|source| publication::Preserved::capture(source, false)).transpose()?;
    #[cfg(unix)]
    let preserved = source.map(PreservedMetadata::of).transpose()?;
    let temporary = format!(".{}.dsh-ops-{}", checked.name, uuid::Uuid::new_v4());
    let mut file = publication::create_sibling(&checked.parent, &temporary, source)?;
    let prepared = (|| -> Result<()> {
        file.write_all(bytes)?;
        if let Some(source) = source {
            let metadata = crate::file_path::read_file(source)?.metadata()?;
            let times = std::fs::FileTimes::new()
                .set_accessed(metadata.accessed()?.into_std())
                .set_modified(metadata.modified()?.into_std());
            file.try_clone()?.into_std().set_times(times)?;
        }
        #[cfg(any(unix, windows))]
        if let Some(preserved) = &preserved {
            let (_, warnings) = preserved.restore(&file)?;
            if !warnings.is_empty() {
                return Err(Failure::new(
                    "METADATA_UNSUPPORTED",
                    "Copy metadata could not be fully restored; nothing published",
                ));
            }
        }
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = prepared {
        publication::discard_sibling(&checked.parent, &temporary, file)?;
        return Err(error);
    }
    if let (Some(source), Some(expected)) = (source, expected_source) {
        if let Err(error) =
            read_bytes(&source.display).and_then(|bytes| check_revision(Some(&bytes), expected))
        {
            publication::discard_sibling(&checked.parent, &temporary, file)?;
            return Err(error);
        }
    }
    #[cfg(windows)]
    if source.is_none() {
        // The private staging DACL exists to hide half-written bytes; it must not outlive
        // publication. Adopt the directory's inheritable grants before the link is made so
        // the workspace token that owns the new file can still unlink it afterwards.
        let parent = checked.parent.try_clone()?.into_std_file();
        let child = file.try_clone()?.into_std();
        let adopted = dsh_ops_windows_metadata::adopt_parent_dacl(&parent, &child)
            .map_err(publication::metadata_error);
        drop(child);
        if let Err(error) = adopted {
            publication::discard_sibling(&checked.parent, &temporary, file)?;
            return Err(error);
        }
    }
    #[cfg(target_os = "macos")]
    {
        // RENAME_EXCL publishes an absent destination without a staging unlink.
        // A preserved Darwin deny-delete ACE must not strand a second hardlink.
        let published = rustix::fs::renameat_with(
            &checked.parent, temporary.as_str(), &checked.parent, checked.name.as_str(),
            rustix::fs::RenameFlags::NOREPLACE,
        );
        if let Err(error) = published {
            publication::discard_sibling(&checked.parent, &temporary, file)?;
            return Err(std::io::Error::from(error).into());
        }
        drop(file);
        return sync_applied(&checked.parent);
    }
    #[cfg(not(target_os = "macos"))]
    let published = checked
        .parent
        .hard_link(&temporary, &checked.parent, &checked.name);
    #[cfg(not(target_os = "macos"))]
    let cleanup = publication::discard_sibling(&checked.parent, &temporary, file);
    #[cfg(not(target_os = "macos"))]
    if let Err(mut failure) = cleanup {
        if published.is_ok() {
            failure.effect_state = "applied".into();
            failure.next_action = "The destination is published but a staging link may remain. Inspect both; do not repeat the copy.".into();
        }
        return Err(failure);
    }
    #[cfg(not(target_os = "macos"))]
    published?;
    #[cfg(windows)]
    if let Some(preserved) = &preserved { preserved.verify(&checked.parent, &checked.name)?; }
    #[cfg(not(target_os = "macos"))]
    sync_applied(&checked.parent)
}
fn sync_applied(parent: &cap_std::fs::Dir) -> Result<()> {
    #[cfg(unix)]
    if let Err(error) = crate::sync_directory(parent) {
        return Err(applied_failure(
            "SYNC_FAILED",
            format!(
                "Publication occurred but directory sync failed: {}",
                error.message
            ),
        ));
    }
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}
fn applied_failure(code: &str, message: impl ToString) -> Failure {
    let mut failure = Failure::new(code, message);
    failure.phase = "publish".into();
    failure.effect_state = "applied".into();
    failure.next_action = "A filesystem effect is already published. Inspect source and destination; do not blindly retry.".into();
    failure
}
fn transfer_file(request: &Request) -> Result<Value> {
    let args: TransferArgs = serde_json::from_value(request.args.clone())?;
    valid_revision(&args.expected_revision, false)?;
    request.authorize_path(Path::new(&args.path))?;
    let source = crate::file_path::checked(&args.path)?;
    let dest = authorize_write(request, &args.to)?;
    if request.tool == "move" {
        authorize_write(request, &args.path)?;
    }
    if source.display == dest {
        return Err(Failure::new(
            "REVISION_CONFLICT",
            "Source and destination are the same path",
        ));
    }
    // Same reason as write_single: a request that cannot succeed must not create the update
    // sidecar. These are pure snapshots of the source and the destination; the checks below the
    // locks stay the authoritative ones and still decide when a concurrent writer won the race.
    let snapshot_source = read_bytes(&source.display)?;
    check_revision(Some(&snapshot_source), &args.expected_revision)?;
    let snapshot_target = crate::file_path::checked_leaf(&args.to, true)?;
    match snapshot_target.parent.symlink_metadata(&snapshot_target.name) {
        Ok(_) => {
            return Err(Failure::new(
                "REVISION_CONFLICT",
                "Destination exists; no clobber is permitted",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    // Total path order avoids deadlock; try-lock still reports concurrency as a CAS conflict.
    let mut names = [args.path.as_str(), args.to.as_str()];
    names.sort();
    let _locks = if request.tool == "copy" {
        // A readable external source may be outside every writable root: no source sidecar.
        vec![lock_single(&args.to)?]
    } else {
        vec![lock_single(names[0])?, lock_single(names[1])?]
    };
    let bytes = if request.tool == "copy" {
        // The pre-lock snapshot already carries the bytes copy publishes and passed the revision
        // check, and `publish_new` re-reads the source and discards the staging sibling when its
        // revision no longer matches, so the CAS is still enforced after the lock; re-reading (and
        // re-hashing) here would only duplicate I/O on every copy.
        snapshot_source
    } else {
        read_bytes(&source.display)?
    };
    if request.tool != "copy" { check_revision(Some(&bytes), &args.expected_revision)?; }
    let target = crate::file_path::checked_leaf(&args.to, true)?;
    match target.parent.symlink_metadata(&target.name) {
        Ok(_) => {
            return Err(Failure::new(
                "REVISION_CONFLICT",
                "Destination exists; no clobber is permitted",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
    }
    let mut output = receipt(&dest, None, &bytes, false, true);
    if request.tool == "copy" {
        publish_new(&dest, &bytes, Some(&source), Some(&args.expected_revision))?;
    } else {
        // A hard link is atomic no-clobber and preserves the original security metadata.
        // The OS rejects cross-device links; never degrade into copy/delete.
        source
            .parent
            .hard_link(&source.name, &target.parent, &target.name)
            .map_err(|error| {
                if error.raw_os_error() == Some(if cfg!(windows) { 17 } else { 18 }) {
                    Failure::new(
                        "CROSS_DEVICE",
                        "Move requires the same filesystem; no copy-delete fallback",
                    )
                } else {
                    error.into()
                }
            })?;
        sync_applied(&target.parent)?;
        check_revision(
            optional_bytes(&args.to)
                .map_err(|error| applied_failure("RESULT_PARTIAL", error.message))?
                .as_deref(),
            &args.expected_revision,
        )
        .map_err(|_| {
            applied_failure(
                "RESULT_PARTIAL",
                "Destination published but its revision differs; source was retained",
            )
        })?;
        check_revision(
            optional_bytes(&args.path)
                .map_err(|error| applied_failure("RESULT_PARTIAL", error.message))?
                .as_deref(),
            &args.expected_revision,
        )
        .map_err(|_| {
            applied_failure(
                "RESULT_PARTIAL",
                "Destination published but source changed; source was retained",
            )
        })?;
        source.parent.remove_file(&source.name).map_err(|error| {
            applied_failure(
                "RESULT_PARTIAL",
                format!("Destination published but source unlink failed: {error}"),
            )
        })?;
        sync_applied(&source.parent)?;
        output["items"]
            .as_array_mut()
            .expect("receipt items")
            .push(json!({"path":source.display,"removed":true}));
    }
    output["items"][0]["metadata"] = json!({"preserved":true});
    Ok(output)
}
fn remove_file(request: &Request) -> Result<Value> {
    let args: RemoveArgs = serde_json::from_value(request.args.clone())?;
    valid_revision(&args.expected_revision, false)?;
    let path = authorize_write(request, &args.path)?;
    // Same reason as write_single: a refused removal must not leave the update sidecar. The check
    // before the lock is a pure snapshot; the one below it stays authoritative.
    let snapshot = read_bytes(&path)?;
    check_revision(Some(&snapshot), &args.expected_revision)?;
    let _lock = lock_single(&args.path)?;
    let bytes = read_bytes(&path)?;
    // The locked read is authoritative; when it stayed identical the validated snapshot still
    // decides, so no second hash of the same bytes is needed.
    if bytes != snapshot { check_revision(Some(&bytes), &args.expected_revision)?; }
    let checked = crate::file_path::checked(&args.path)?;
    checked.parent.remove_file(&checked.name)?;
    sync_applied(&checked.parent)?;
    Ok(
        json!({"status":"completed","phase":"verify","complete":true,"changed":1,"revisionBefore":args.expected_revision,"items":[{"path":path,"removed":true}]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_changed_source_is_not_published() {
        // Darwin's `TMPDIR` sits under `/var`, itself a symlink to `/private/var`, and the
        // no-follow traversal refuses any linked component. Resolve the ambient root first so
        // the fixture exercises the copy CAS rather than the platform's temp spelling.
        let ambient = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = ambient.join(format!("dsh-ops-copy-cas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let dest = root.join("dest");
        let original = b"original snapshot";
        let expected = format!("{:x}", Sha256::digest(original));
        std::fs::write(&source, b"concurrent writer").unwrap();
        let checked = crate::file_path::checked(source.to_str().unwrap()).unwrap();
        let error = publish_new(&dest, original, Some(&checked), Some(&expected)).unwrap_err();
        assert_eq!(error.code, "REVISION_CONFLICT");
        assert_eq!(&*error.effect_state, "none");
        assert!(!dest.exists());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        drop(checked);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    fn fixture() -> std::path::PathBuf {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("dsh-ops-inherit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[cfg(windows)]
    #[test]
    fn new_file_adopts_directory_grants() {
        use windows_permissions::{
            LocalBox, SecurityDescriptor,
            constants::{AceFlags, SeObjectType::SE_FILE_OBJECT, SecurityInformation as Info},
            wrappers::{GetNamedSecurityInfo, SetNamedSecurityInfo},
        };
        let root = fixture();
        let creator = windows_permissions::utilities::current_process_sid().unwrap();
        // A confined token authorizes through inherited grants, never through the creator,
        // so the directory carries a mask the private staging DACL does not name.
        let directory: LocalBox<SecurityDescriptor> =
            format!("D:(A;OICI;FA;;;{creator})(A;OICI;0x10001;;;S-1-5-32-545)").parse().unwrap();
        SetNamedSecurityInfo(&root, SE_FILE_OBJECT, Info::Dacl, None, None, directory.dacl(), None)
            .unwrap();
        let destination = root.join("published");
        publish_new(&destination, b"payload", None, None).unwrap();
        let published: LocalBox<SecurityDescriptor> =
            GetNamedSecurityInfo(&destination, SE_FILE_OBJECT, Info::Dacl).unwrap();
        let granted = published.dacl().expect("a published file has a DACL");
        let inherited = (0..granted.len()).any(|index| {
            granted.get_ace(index).is_some_and(|ace| {
                ace.flags().contains(AceFlags::Inherited)
                    && ace.mask().bits() == 0x10001
                    && ace.sid().is_some_and(|sid| {
                        windows_permissions::wrappers::ConvertSidToStringSid(sid)
                            .is_ok_and(|sid| sid == "S-1-5-32-545")
                    })
            })
        });
        assert!(
            inherited,
            "a published file must inherit the directory grants the staging DACL hid: {:?}",
            published.as_sddl().map(|text| text.to_string_lossy().into_owned())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_directory_without_inheritable_grants_still_publishes_an_accessible_file() {
        use windows_permissions::{
            LocalBox, SecurityDescriptor,
            constants::{SeObjectType::SE_FILE_OBJECT, SecurityInformation as Info},
            wrappers::SetNamedSecurityInfo,
        };
        let root = fixture();
        let creator = windows_permissions::utilities::current_process_sid().unwrap();
        // Nothing here is inheritable, so adoption has no grant to copy; the publisher must
        // still be able to read back and delete what it published.
        let locked: LocalBox<SecurityDescriptor> =
            format!("D:P(A;;FA;;;{creator})").parse().unwrap();
        SetNamedSecurityInfo(&root, SE_FILE_OBJECT, Info::Dacl | Info::ProtectedDacl, None, None, locked.dacl(), None)
            .unwrap();
        let destination = root.join("published");
        publish_new(&destination, b"payload", None, None).unwrap();
        std::fs::File::open(&destination).unwrap();
        std::fs::remove_file(&destination).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
