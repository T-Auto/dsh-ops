//! Which path components a search may observe.
//!
//! Two rules live here, and they are deliberately separate. [`dotdir`] marks
//! caller content that an opt-in flag may lift; [`internal`] marks the plugin's
//! own bookkeeping, which no request shape may reach. [`reserved`] covers the
//! dependency and build trees that are always pruned.
use ops_protocol::{Failure, Result};
use std::path::Path;

/// An ordinary dot-prefixed path component (`.github`, `.config`, `.env`).
///
/// This is user content that a caller may ask to traverse. It is kept separate
/// from [`internal`] so that opting in cannot reach the plugin's own sidecars.
pub(crate) fn dotdir(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .into_iter()
        .flat_map(|p| p.components())
        .any(|c| {
            let name = c.as_os_str().to_string_lossy();
            name.starts_with('.') && !internal(&name)
        })
}

/// The plugin's own bookkeeping, which no selection tool may observe.
///
/// `ops_glob`, `ops_grep` and a directory-wide `ops_replace` must never return,
/// count or rewrite these: the update lock in particular is what keeps two
/// concurrent writes from interleaving, and the atomic-write temporary carries
/// the not-yet-durable bytes of a file that is being replaced. There is
/// deliberately no flag that lifts this predicate.
///
/// This matches whole shapes, never a prefix. `ops-files` already paid for that
/// lesson once: `sweep_debris` used to delete anything beginning the same way and
/// took an operator's `.notes.txt.dsh-ops-personal-backup` with it (review of
/// #81). A directory named `.dsh-ops-backup` or a file named `.dsh-ops.json` is
/// the caller's content, and `test/audit-store-paths.test.mjs` writes exactly
/// those and expects them to remain readable.
pub(crate) fn internal(name: &str) -> bool {
    name.eq_ignore_ascii_case(".dsh-ops") || update_lock(name) || atomic_temporary(name)
}

/// `.dsh-ops-update-<sha256 hex>.lock`, the name `lock_for_update` acquires.
///
/// The digest is `Sha256` of the lowercased target name formatted `{:x}`, so the
/// tail is exactly 64 lowercase hex digits. Checking the shape keeps a file such
/// as `.dsh-ops-update-notes.lock` — which no writer ever creates — in the
/// caller's hands.
fn update_lock(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".dsh-ops-update-") else {
        return false;
    };
    let Some(digest) = rest.strip_suffix(".lock") else {
        return false;
    };
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `.<target>.dsh-ops-<uuid>`, the sibling `atomic_write` stages before rename.
///
/// `ops-files/src/file.rs` writes the replacement bytes here, restores mode,
/// owner and ACLs on it, syncs, and only then renames it over the target. Until
/// that rename the file holds content the caller has not committed — and it is
/// dropped under a dot name, which is why the old blanket rule used to hide it
/// and why `includeHidden` must not start exposing it. `sweep_debris` clears
/// leftovers of a killed writer on its own schedule; that is not a caller's
/// business either.
///
/// The suffix must parse as a v4 UUID, the same test `sweep_debris` applies, so
/// an operator file such as `.notes.txt.dsh-ops-personal-backup` stays theirs.
fn atomic_temporary(name: &str) -> bool {
    let Some(dot) = name.strip_prefix('.') else {
        return false;
    };
    let Some(at) = dot.rfind(".dsh-ops-") else {
        return false;
    };
    if at == 0 {
        return false;
    }
    v4_uuid(&dot[at + ".dsh-ops-".len()..])
}

/// Whether `value` is a hyphenated v4 UUID, the tail `atomic_write` generates.
///
/// Spelled out rather than parsed with `uuid`: that crate is a dev-dependency
/// here, and the shape is fixed. A v4 UUID is 36 characters of `8-4-4-4-12`
/// lowercase hex with a `4` version nibble and an RFC 4122 variant nibble.
fn v4_uuid(value: &str) -> bool {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let mut rest = value;
    for (index, width) in GROUPS.into_iter().enumerate() {
        if index > 0 {
            match rest.strip_prefix('-') {
                Some(tail) => rest = tail,
                None => return false,
            }
        }
        if rest.len() < width {
            return false;
        }
        let (group, tail) = rest.split_at(width);
        if !group.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return false;
        }
        match index {
            // Version nibble: `atomic_write` calls `Uuid::new_v4`.
            2 if group.as_bytes()[0] != b'4' => return false,
            // RFC 4122 variant: the top two bits are `10`.
            3 if !matches!(group.as_bytes()[0], b'8' | b'9' | b'a' | b'b') => return false,
            _ => {}
        }
        rest = tail;
    }
    rest.is_empty()
}

/// Every exclusion the walk applies that is not a caller-selectable dot path.
pub(crate) fn reserved(name: &str) -> bool {
    matches!(name, "node_modules" | "target" | ".venv" | ".git")
}

/// Rejects a caller-supplied root that is, or sits inside, this plugin's own
/// bookkeeping.
///
/// The walk drops these while enumerating, but an explicit `path` never reaches
/// the enumerator when it names a file: `Scan::walk` hands a file root straight
/// to `each`, and `files_for` returns it as the only match. Enumerating and
/// naming the same path therefore disagree, and the narrower contract is the
/// honest one to keep. `ops-files` already refuses the exact `.dsh-ops` store
/// component; this also refuses the update lock, which is the one internal name
/// that is not the store itself. It is deliberately not a flag: the lock is not
/// caller-selectable content, so no request shape may observe it.
pub(crate) fn reject_internal_root(root: &Path) -> Result<()> {
    let offender = root.components().find_map(|component| {
        let name = component.as_os_str().to_string_lossy();
        internal(&name).then(|| name.into_owned())
    });
    match offender {
        Some(name) => Err(Failure::new(
            "PATH_RESTRICTED",
            format!("{name} is reserved for internal operations"),
        )),
        None => Ok(()),
    }
}
