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

pub(crate) fn batch(
    paths: &[PathBuf],
    deadline: Instant,
    #[cfg(test)] hook: Option<&OpenHook>,
) -> Vec<(PathBuf, Opened)> {
    let paths = &paths[..paths.len().min(WINDOW)];
    let next = AtomicUsize::new(0);
    let results = Mutex::new((0..paths.len()).map(|_| None).collect::<Vec<_>>());
    std::thread::scope(|scope| {
        for _ in 0..paths.len().min(WORKERS) {
            let next = &next;
            let results = &results;
            scope.spawn(move || {
                while Instant::now() < deadline {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(index) else {
                        break;
                    };
                    #[cfg(test)]
                    if let Some(hook) = hook {
                        hook(path);
                    }
                    let opened = checked(path);
                    results.lock().unwrap()[index] = Some((path.clone(), opened));
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
