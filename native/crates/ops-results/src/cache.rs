//! Immutable session snapshots with quota and LRU decisions under one process-shared lock.
use crate::contract::{Failure, Request, Result};
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use fs2::FileExt;
use ops_files::{cache_io, file_path};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::time::{Duration, SystemTime};
pub const MAX_RESULT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_SESSION_BYTES: u64 = 100 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;

pub struct Cache {
    dir: Dir,
    _lock: std::fs::File,
    read_only: bool,
    write_sid: Option<String>,
}
struct Entry {
    name: String,
    bytes: u64,
    modified: SystemTime,
    evictable: bool,
    temporary: bool,
}
impl Cache {
    pub fn open(request: &Request) -> Result<Self> {
        Self::open_mode(request, true)
    }
    pub fn existing(request: &Request) -> Result<Self> {
        Self::open_mode(request, false)
    }
    fn open_mode(request: &Request, create: bool) -> Result<Self> {
        let context = request.storage.as_ref().ok_or_else(|| {
            Failure::new(
                "POLICY_DENIED",
                "Trusted storage context is required for this reference",
            )
        })?;
        context.validate()?;
        request.authorize_path(std::path::Path::new(&context.root))?;
        let checked = file_path::checked(&context.root)?;
        let root = checked.parent.open_dir_nofollow(&checked.name)?;
        // Trusted storage.root grants cache-only access independently of business write roots.
        // Never widen request.write_roots: business publication still checks its own authority.
        let name = format!("s-{:x}", Sha256::digest(request.scope.as_bytes()));
        let dir = cache_io::directory(
            &root,
            &name,
            create && !request.read_only,
            context.windows_write_sid.as_deref(),
        )?;
        let lock = if create {
            cache_io::lock_file(
                &dir,
                !request.read_only,
                context.windows_write_sid.as_deref(),
            )?
        } else {
            cache_io::open_file(
                &dir,
                "lock",
                !request.read_only,
                context.windows_write_sid.as_deref(),
            )?
        }
        .into_std();
        let locked = if request.read_only {
            FileExt::try_lock_shared(&lock)
        } else {
            FileExt::try_lock_exclusive(&lock)
        };
        locked.map_err(|_| {
            Failure::new(
                "JOB_BUSY",
                "Another process owns this session cache; no business operation was retried",
            )
        })?;
        Ok(Self {
            dir,
            _lock: lock,
            read_only: request.read_only,
            write_sid: context.windows_write_sid.clone(),
        })
    }
    fn name(id: &str) -> Result<String> {
        if uuid::Uuid::parse_str(id).is_err() || id.to_ascii_lowercase() != id || id.len() != 36 {
            return Err(Failure::new("INVALID_ARGUMENT", "Invalid reference UUID"));
        }
        Ok(format!("{id}.json"))
    }
    fn entries(&self) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        for entry in self.dir.entries()? {
            if entries.len() >= MAX_ENTRIES {
                return Err(Failure::new(
                    "QUOTA_EXCEEDED",
                    "Session cache entry quota exhausted",
                ));
            }
            let name = entry?
                .file_name()
                .into_string()
                .map_err(|_| Failure::new("PATH_RESTRICTED", "Non-UTF8 cache entry"))?;
            let file = cache_io::open_file(&self.dir, &name, false, self.write_sid.as_deref())?;
            let metadata = file.metadata()?;
            let is_uuid = |suffix: &str| {
                name.strip_suffix(suffix)
                    .is_some_and(|id| Self::name(id).is_ok())
            };
            entries.push(Entry {
                evictable: is_uuid(".json"),
                temporary: is_uuid(".tmp"),
                name,
                bytes: metadata.len(),
                modified: metadata.modified()?.into_std(),
            });
        }
        Ok(entries)
    }
    fn next_touch(entries: &[Entry]) -> SystemTime {
        entries
            .iter()
            .map(|entry| entry.modified)
            .max()
            .unwrap_or(SystemTime::UNIX_EPOCH)
            .max(SystemTime::now())
            .checked_add(Duration::from_millis(1))
            .unwrap_or(SystemTime::now())
    }
    pub fn read<T: for<'de> Deserialize<'de>>(&self, id: &str) -> Result<(T, usize)> {
        let name = Self::name(id)?;
        let file = cache_io::open_file(&self.dir, &name, false, self.write_sid.as_deref())
            .map_err(|error| {
                if error.code == "NOT_FOUND" {
                    Failure::new(
                        "REFERENCE_EXPIRED",
                        "Reference is missing, expired, released, or evicted",
                    )
                } else {
                    error
                }
            })?;
        let mut bytes = Vec::new();
        file.take((MAX_RESULT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_RESULT_BYTES {
            return Err(Failure::new(
                "QUOTA_EXCEEDED",
                "Cached snapshot exceeds 10 MiB",
            ));
        }
        Ok((serde_json::from_slice(&bytes)?, bytes.len()))
    }
    pub fn touch(&self, id: &str) -> Result<()> {
        if self.read_only {
            return Ok(());
        }
        let file =
            cache_io::open_file(&self.dir, &Self::name(id)?, true, self.write_sid.as_deref())?;
        let time = Self::next_touch(&self.entries()?);
        file.into_std()
            .set_times(std::fs::FileTimes::new().set_modified(time))?;
        Ok(())
    }
    pub fn save<T: Serialize>(&self, id: &str, record: &T) -> Result<usize> {
        if self.read_only {
            return Err(Failure::policy(
                "read-only",
                "Read-only calls cannot create references",
            ));
        }
        let name = Self::name(id)?;
        let bytes = serde_json::to_vec(record)?;
        if bytes.len() > MAX_RESULT_BYTES {
            return Err(Failure::new(
                "QUOTA_EXCEEDED",
                "One result may occupy at most 10 MiB",
            ));
        }
        // Reject any collision; never overwrite an existing snapshot.
        match self.dir.symlink_metadata(&name) {
            Ok(_) => {
                return Err(Failure::new(
                    "REVISION_CONFLICT",
                    "Reference already exists",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        let mut entries = self.entries()?;
        // Orphans count toward the measured quota before cleanup. Only our exact temporary
        // namespace is disposable, and the exclusive session lock proves no writer owns it.
        let mut used: u64 = entries.iter().map(|entry| entry.bytes).sum();
        let touch = Self::next_touch(&entries);
        let mut remove: Vec<_> = entries
            .iter()
            .filter(|entry| entry.temporary)
            .map(|entry| entry.name.clone())
            .collect();
        used = used.saturating_sub(
            entries
                .iter()
                .filter(|entry| entry.temporary)
                .map(|entry| entry.bytes)
                .sum(),
        );
        entries.retain(|entry| !entry.temporary);
        entries.sort_by(|a, b| a.modified.cmp(&b.modified).then(a.name.cmp(&b.name)));
        let mut count = entries.len();
        for entry in entries.iter().filter(|entry| entry.evictable) {
            if used + bytes.len() as u64 <= MAX_SESSION_BYTES && count + 1 < MAX_ENTRIES {
                break;
            }
            remove.push(entry.name.clone());
            used = used.saturating_sub(entry.bytes);
            count -= 1;
        }
        if used + bytes.len() as u64 > MAX_SESSION_BYTES || count + 1 >= MAX_ENTRIES {
            return Err(Failure::new(
                "QUOTA_EXCEEDED",
                "Session cache quota exhausted; non-cache records are never evicted",
            ));
        }
        let temporary = format!("{id}.tmp");
        let mut changed = false;
        let prepared = (|| -> Result<()> {
            for name in remove {
                self.dir.remove_file(name)?;
                changed = true;
            }
            let mut file = cache_io::create_file(&self.dir, &temporary, self.write_sid.as_deref())?;
            file.write_all(&bytes)?;
            file.try_clone()?
                .into_std()
                .set_times(std::fs::FileTimes::new().set_modified(touch))?;
            file.sync_all()?;
            drop(file);
            self.dir.rename(&temporary, &self.dir, &name)?;
            changed = true;
            #[cfg(unix)]
            ops_files::sync_directory(&self.dir)?;
            Ok(())
        })();
        if let Err(mut error) = prepared {
            if let Err(cleanup) = self.dir.remove_file(&temporary)
                && cleanup.kind() != std::io::ErrorKind::NotFound
            {
                changed = true;
            }
            if changed {
                error.phase = "execute".into();
                error.effect_state = "partial".into();
                error.next_action = "Cache cleanup or publication may have changed references; inspect cache state. Never rerun business operations.".into();
            }
            return Err(error);
        }
        Ok(bytes.len())
    }
    /// Session exit destroys only validated snapshot/stage names. The lock inode remains
    /// stable so a concurrent opener cannot form a second serialization domain.
    pub fn purge(&self) -> Result<(usize, usize)> {
        if self.read_only {
            return Err(Failure::policy(
                "read-only",
                "Read-only calls cannot purge references",
            ));
        }
        let mut entries = self.entries()?;
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let mut removed = 0;
        let mut retained = 0;
        for entry in entries {
            if !entry.evictable && !entry.temporary {
                retained += 1;
                continue;
            }
            if let Err(error) = self.dir.remove_file(&entry.name) {
                let mut failure = Failure::new(
                    "CACHE_PURGE_FAILED",
                    format!("Removed {removed} cache objects before cleanup failed: {error}"),
                );
                failure.phase = "execute".into();
                failure.effect_state = if removed == 0 { "none" } else { "partial" }.into();
                failure.next_action = "Keep this session's references logically expired; inspect deferred cache cleanup. Never rerun business operations.".into();
                return Err(failure);
            }
            removed += 1;
        }
        Ok((removed, retained))
    }
    pub fn release(&self, id: &str) -> Result<()> {
        if self.read_only {
            return Err(Failure::policy(
                "read-only",
                "Read-only calls cannot release references",
            ));
        }
        let name = Self::name(id)?;
        let _file = cache_io::open_file(&self.dir, &name, false, self.write_sid.as_deref())?;
        self.dir.remove_file(&name)?;
        #[cfg(unix)]
        ops_files::sync_directory(&self.dir)?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
