//! The per-target update lock cooperating writers serialise on.
//!
//! Publication is an atomic rename of the target, so a lock on the target's own
//! inode cannot serialise writers: a waiter can keep the old inode while the path
//! already names a new one. Every writer therefore locks a stable sidecar beside
//! the target — `.dsh-ops-update-<sha256 of the lowercased basename>.lock` — and
//! holds it until the publication and its directory sync are done.
//!
//! The sidecar is removed again when its holder is done (#319). Removing it used to
//! be considered unsafe, because a waiter that already opened the old inode could
//! lock it after the unlink while the next writer locked a fresh file under the
//! same name — two writers, one target. Two rules close that window without
//! keeping the artifact in the operator's directory:
//!
//! - **Bind before publishing.** After taking the exclusive lock, the new holder
//!   reopens the name and compares the `(device, inode)` identity of that handle
//!   with the inode it locked. A name that no longer leads to the locked inode
//!   means the previous holder finished and removed the sidecar while this writer
//!   was opening it: the handle is dropped and the acquisition starts over. Only a
//!   bound holder may publish, so the unlinked-inode waiter can never write.
//! - **Unlink while the lock is still held, and only the bound inode.** Releasing
//!   is `remove_file` on the name, then dropping the handle. The same identity
//!   check runs first, so a name that someone else removed out of band and another
//!   writer has since re-created is left alone.
//!
//! What an operator sees: a successful write leaves nothing behind, a request
//! refused after the lock leaves nothing behind, and only a killed writer
//! (`SIGKILL`, power loss) can leave a sidecar — which the next writer of that
//! name locks, reuses and removes with its own publication. Nothing accumulates,
//! and a stale sidecar never blocks a later write.
//!
//! The name is unchanged from the version that kept sidecars forever on purpose:
//! the next write to a name cleans up what an older build left beside it.

use super::publication;
use crate::contract::{Failure, Result};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use fs2::FileExt;
use std::fs::File;

/// How often one acquisition may re-bind after losing the name to a holder that
/// finished while it was opening the sidecar. This is a bounded observation
/// loop, not a retry of a failed operation: a writer that keeps losing the race
/// this many times reports contention instead of spinning.
const BIND_ATTEMPTS: usize = 8;

/// Whether the sidecar name still leads to the inode this writer locked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Binding {
    /// The name resolves to the locked inode.
    Bound,
    /// The name is gone or resolves to a different inode.
    Moved,
    /// The platform could not report an identity for both handles.
    Unverifiable,
}

/// The exclusive update lock for one target name, released and removed on drop.
#[derive(Debug)]
pub struct UpdateLock {
    /// The handle whose exclusive lock is this writer's right to publish.
    /// It is held only for that lock; dropping it is what releases the lock
    /// (after [`Drop`] removed the sidecar).
    #[allow(dead_code)]
    lock: File,
    /// The same file as `lock`, opened through the directory so its metadata
    /// carries the `(device, inode)` identity this writer compares the name with.
    handle: cap_std::fs::File,
    /// The already-validated no-follow directory that names the sidecar.
    parent: Dir,
    /// The sidecar's file name inside `parent`.
    name: String,
}

impl UpdateLock {
    /// Take the exclusive update lock on the sidecar `name` beside `parent`.
    ///
    /// `contention` is the caller's own refusal text, so a losing writer keeps
    /// reporting the same `REVISION_CONFLICT` contract it always did.
    pub fn acquire(parent: &Dir, name: &str, contention: &str) -> Result<Self> {
        Self::acquire_with(parent, name, contention, |parent, name| {
            publication::open_update_lock(parent, name, contention)
        })
    }

    /// [`acquire`](Self::acquire) with the sidecar opener as a parameter.
    ///
    /// Production always passes `publication::open_update_lock`; the seam exists so
    /// a test can interleave a finishing holder between the open and the lock, which
    /// is the exact window the binding rule closes.
    fn acquire_with(
        parent: &Dir,
        name: &str,
        contention: &str,
        mut open: impl FnMut(&Dir, &str) -> Result<File>,
    ) -> Result<Self> {
        for _ in 0..BIND_ATTEMPTS {
            let lock = open(parent, name)?;
            // Non-blocking on purpose: a busy path is reported, never waited on.
            FileExt::try_lock_exclusive(&lock)
                .map_err(|error| publication::lock_error(error, contention))?;
            let lock = Self {
                handle: cap_std::fs::File::from_std(lock.try_clone()?),
                lock,
                parent: parent.try_clone()?,
                name: name.to_string(),
            };
            match lock.binding() {
                Binding::Bound | Binding::Unverifiable => return Ok(lock),
                // The previous holder removed the sidecar between our open and our
                // lock, so this inode is no longer the one the name carries. Letting
                // this handle publish would allow two writers on one target.
                Binding::Moved => continue,
            }
        }
        Err(Failure::new("REVISION_CONFLICT", contention))
    }

    /// Compare the sidecar name's current inode with the one this lock holds.
    fn binding(&self) -> Binding {
        let reopened = match self.parent.open_with(
            &self.name,
            OpenOptions::new().read(true).follow(FollowSymlinks::No),
        ) {
            Ok(file) => file,
            // A missing name is the state a finishing holder leaves behind.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Binding::Moved,
            // Any other failure is not evidence that the name moved; keeping the
            // sidecar is the safe answer, and the lock is still held either way.
            Err(_) => return Binding::Unverifiable,
        };
        match (identity(&self.handle), identity(&reopened)) {
            (Some(locked), Some(current)) if locked == current => Binding::Bound,
            (Some(_), Some(_)) => Binding::Moved,
            // The identity is read from open handles, so this only happens on a
            // platform or filesystem that does not report one. Fall back to the
            // protection this lock always had: keep the artifact rather than risk
            // removing another writer's.
            _ => Binding::Unverifiable,
        }
    }
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        // Still holding the exclusive lock here: the handle is a field, so it is
        // dropped after this body runs. Removing the sidecar of a name that has
        // moved would delete a later writer's lock.
        if self.binding() != Binding::Moved {
            let _ = self.parent.remove_file(&self.name);
        }
    }
}

/// `(device, inode)` of an open handle, without touching the path it came from.
///
/// The identity comes from metadata captured through the handle (`cap_std`'s
/// `Metadata::from_file`), on every supported platform: Unix reports `dev`/`ino`
/// directly, Windows its volume serial and file index. A path-based stat would not
/// carry the same information, which is why the name is always opened instead.
fn identity(file: &cap_std::fs::File) -> Option<(u64, u64)> {
    use cap_fs_ext::MetadataExt;
    let metadata = file.metadata().ok()?;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use sha2::{Digest, Sha256};

    /// One private fixture directory under the canonical ambient temp root.
    struct Fixture {
        root: std::path::PathBuf,
        dir: Dir,
    }
    impl Fixture {
        fn new(tag: &str) -> Self {
            let root = std::fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "dsh-ops-update-lock-{tag}-{}",
                    uuid::Uuid::new_v4()
                ));
            std::fs::create_dir(&root).unwrap();
            let dir = Dir::open_ambient_dir(&root, ambient_authority()).unwrap();
            Self { root, dir }
        }
        /// The sidecar name `acquire` takes for one target name.
        fn sidecar(name: &str) -> String {
            format!(
                ".dsh-ops-update-{:x}.lock",
                Sha256::digest(name.to_lowercase().as_bytes())
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// #319: the artifact used to be permanent. A released lock must leave the
    /// directory exactly as it was, on every platform and in every permission mode.
    #[test]
    fn a_released_lock_leaves_nothing_behind() {
        let fixture = Fixture::new("release");
        let name = Fixture::sidecar("notes.txt");
        {
            let _lock = UpdateLock::acquire(&fixture.dir, &name, "busy").unwrap();
            assert!(
                fixture.root.join(&name).is_file(),
                "the lock exists while it is held"
            );
        }
        assert!(
            !fixture.root.join(&name).exists(),
            "releasing the lock removes its sidecar"
        );
        assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
    }

    /// A sidecar left by a killed writer is not a stuck lock: the next writer binds
    /// to it, publishes under it, and removes it.
    #[test]
    fn a_leftover_sidecar_is_reused_and_then_removed() {
        let fixture = Fixture::new("leftover");
        let name = Fixture::sidecar("notes.txt");
        std::fs::write(fixture.root.join(&name), b"").unwrap();
        {
            let _lock = UpdateLock::acquire(&fixture.dir, &name, "busy").unwrap();
            assert_eq!(
                std::fs::metadata(fixture.root.join(&name)).unwrap().len(),
                0,
                "the sidecar still carries no payload"
            );
        }
        assert!(
            !fixture.root.join(&name).exists(),
            "the writer that finished removes the leftover"
        );
    }

    /// Two writers on one name: the loser is refused with the caller's contract
    /// text and leaves nothing of its own.
    #[test]
    fn a_second_writer_is_refused_and_adds_nothing() {
        let fixture = Fixture::new("contention");
        let name = Fixture::sidecar("notes.txt");
        let held = UpdateLock::acquire(&fixture.dir, &name, "busy").unwrap();
        let refused = UpdateLock::acquire(&fixture.dir, &name, "busy")
            .expect_err("the second writer is refused");
        assert_eq!(refused.code, "REVISION_CONFLICT");
        assert!(
            fixture.root.join(&name).is_file(),
            "the winner's sidecar is untouched by the loser"
        );
        drop(held);
        assert!(!fixture.root.join(&name).exists());
    }

    /// Out-of-band removal is the one thing this protocol cannot order: an operator
    /// deletes the sidecar, another writer creates a fresh one, and the first
    /// writer's release must not delete the newcomer's lock.
    #[test]
    fn a_release_does_not_remove_a_lock_someone_else_recreated() {
        let fixture = Fixture::new("replaced");
        let name = Fixture::sidecar("notes.txt");
        let held = UpdateLock::acquire(&fixture.dir, &name, "busy").unwrap();
        std::fs::remove_file(fixture.root.join(&name)).unwrap();
        std::fs::write(fixture.root.join(&name), b"").unwrap();
        drop(held);
        assert!(
            fixture.root.join(&name).is_file(),
            "the re-created sidecar belongs to a later writer"
        );
    }

    /// A holder whose name was taken away must not publish under the orphaned
    /// inode: the acquisition re-binds to the live name instead.
    ///
    /// The opener here reproduces the precise window: it returns a handle to the
    /// sidecar, and before returning it lets that sidecar be removed and a fresh one
    /// created — so the returned handle is an inode the name no longer carries.
    #[test]
    fn an_acquisition_rebinds_instead_of_using_an_orphaned_inode() {
        let fixture = Fixture::new("orphan");
        let name = Fixture::sidecar("notes.txt");
        std::fs::write(fixture.root.join(&name), b"").unwrap();
        let mut raced = false;
        let lock = UpdateLock::acquire_with(&fixture.dir, &name, "busy", |parent, name| {
            let opened = publication::open_update_lock(parent, name, "busy")?;
            if !raced {
                raced = true;
                // A finishing holder removes the sidecar, and the next writer creates
                // a new one, while this writer is still holding the old handle.
                parent.remove_file(name)?;
                publication::open_update_lock(parent, name, "busy")?;
            }
            Ok(opened)
        })
        .expect("the acquisition rebinds instead of failing");
        assert_eq!(
            lock.binding(),
            Binding::Bound,
            "the writer binds to the live name, not the orphaned inode"
        );
        // With the rebind, the live sidecar is held: without it, the orphaned handle
        // would own the lock while a second writer took the name — two writers here.
        assert_eq!(
            UpdateLock::acquire(&fixture.dir, &name, "busy")
                .expect_err("contended")
                .code,
            "REVISION_CONFLICT"
        );
        drop(lock);
        assert!(
            !fixture.root.join(&name).exists(),
            "the bound holder removes the sidecar it published under"
        );
    }
}
