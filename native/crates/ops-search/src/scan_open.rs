//! Bounded read-ahead opens. Content and scan accounting remain on the caller.
use super::*;
use std::{
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

pub(crate) const WINDOW: usize = 32;
pub(crate) const WORKERS: usize = 8;
pub(crate) type Opened = Result<cap_std::fs::File>;
#[cfg(test)]
pub(crate) type OpenHook = std::sync::Arc<dyn Fn(&Path) + Send + Sync>;

pub(crate) fn checked(path: &Path) -> Opened {
    let target = file_path::checked(
        path.to_str()
            .ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?,
    )?;
    file_path::read_file(&target)
}

pub(crate) struct Candidate {
    pub name: String,
    pub path: PathBuf,
    pub may_read: bool,
}
pub(crate) struct Observation {
    pub name: String,
    pub path: PathBuf,
    pub metadata: std::io::Result<cap_std::fs::Metadata>,
    pub opened: Option<Opened>,
}

pub(crate) fn observe(
    directory: &cap_std::fs::Dir,
    candidates: &[Candidate],
    deadline: Instant,
    #[cfg(test)] metadata_hook: Option<&OpenHook>,
    #[cfg(test)] open_hook: Option<&OpenHook>,
) -> Vec<Observation> {
    let candidates = &candidates[..candidates.len().min(WINDOW)];
    let next = AtomicUsize::new(0);
    let results = Mutex::new((0..candidates.len()).map(|_| None).collect::<Vec<_>>());
    std::thread::scope(|scope| {
        for _ in 0..candidates.len().min(WORKERS) {
            let next = &next;
            let results = &results;
            scope.spawn(move || {
                while Instant::now() < deadline {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(candidate) = candidates.get(index) else {
                        break;
                    };
                    #[cfg(test)]
                    if let Some(hook) = metadata_hook {
                        hook(Path::new(&candidate.name));
                    }
                    let metadata = directory.symlink_metadata(&candidate.name);
                    let opened = if candidate.may_read
                        && metadata
                            .as_ref()
                            .is_ok_and(|value| value.is_file() && !file_path::link(value))
                        && Instant::now() < deadline
                    {
                        #[cfg(test)]
                        if let Some(hook) = open_hook {
                            hook(&candidate.path);
                        }
                        Some(checked(&candidate.path))
                    } else {
                        None
                    };
                    results.lock().unwrap()[index] = Some(Observation {
                        name: candidate.name.clone(),
                        path: candidate.path.clone(),
                        metadata,
                        opened,
                    });
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .flatten()
        .collect()
}
