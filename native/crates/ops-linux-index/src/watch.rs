// Design informed by mustafaahci/goz (MIT).
//! Watch session: notify's inotify backend, polling fallback, and the bridge
//! between backend events and the [`crate::state`] decision machine.
//!
//! The session's contract with the caller:
//!
//! 1. [`WatchSession::start`] opens the watcher on the root *before* the cold
//!    walk, so changes during enumeration are buffered.
//! 2. `walk::enumerate` builds the snapshot.
//! 3. [`WatchSession::adopt_directories`] records which relative paths are
//!    directories in that snapshot. This step is required: until it runs the
//!    baseline is not ready and every structural event conservatively requires
//!    a rescan.
//! 4. [`WatchSession::poll`] drains the buffer. The caller applies the events;
//!    when `invalidated` is set it must discard the snapshot and rescan, then
//!    call [`WatchSession::resync_baseline`].
//!
//! Event loss or a watch that can no longer be attributed is never replayed
//! onto the snapshot; see [`crate::state`] for the invalidation rules.
//!
//! A directory created after the baseline also requires a rescan. notify's
//! recursive inotify backend registers the new directory's watch
//! asynchronously, so children created before registration would never emit
//! events; expanding the subtree ourselves would race the same window. L2
//! therefore invalidates instead of guessing, and a later slice may replace
//! that with an explicit expansion once it can prove the watch is live.

use crate::limits::{DegradeReason, WatchLimits};
use crate::state::{InvalidationReason, SessionCore, WatchEvent, WatchMode, WatchUpdate};
use notify::event::{Event, EventKind, ModifyKind, RenameMode};
use notify::{Config, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use ops_index::ChangeAction;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::Duration;

/// Poll interval used when the native watcher cannot be maintained.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// A live watch session over one root.
pub struct WatchSession {
    backend: Backend,
    receiver: Receiver<notify::Result<Event>>,
    core: SessionCore,
    poll_interval: Duration,
}

/// The concrete watcher is held only to keep its background thread alive:
/// events travel through the session's channel, and dropping the backend stops
/// delivery.
#[allow(dead_code)]
enum Backend {
    Native(RecommendedWatcher),
    Polling(PollWatcher),
}

impl WatchSession {
    /// Starts watching `root` recursively.
    ///
    /// A zero watch budget, or any failure to establish the native watcher,
    /// falls back to notify's polling watcher. The call fails only when the
    /// polling watcher cannot be established either.
    pub fn start(
        root: &Path,
        limits: &WatchLimits,
        poll_interval: Duration,
    ) -> Result<Self, DegradeReason> {
        if limits.can_watch()
            && let Ok((backend, receiver)) = open_native(root)
        {
            return Ok(Self {
                backend,
                receiver,
                core: SessionCore::new(root.to_path_buf()),
                poll_interval,
            });
        }
        log::warn!("no native inotify session; starting the watcher in polling mode");
        let (backend, receiver) = open_polling(root, poll_interval)?;
        let mut core = SessionCore::new(root.to_path_buf());
        core.set_mode(WatchMode::Polling);
        Ok(Self {
            backend,
            receiver,
            core,
            poll_interval,
        })
    }

    /// Backend currently in use.
    pub fn mode(&self) -> WatchMode {
        self.core.mode()
    }

    /// Why a rescan is required, if it is.
    pub fn invalidated(&self) -> Option<InvalidationReason> {
        self.core.invalidated()
    }

    /// Records the relative paths that are directories in the cold snapshot.
    ///
    /// Required after the cold walk: until this runs, the session treats every
    /// structural event as unattributable and requires a rescan.
    pub fn adopt_directories(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.core.adopt_directories(dirs);
    }

    /// Clears the invalidation after the caller rebuilt its snapshot.
    pub fn resync_baseline(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.core.resync_baseline(dirs);
    }

    /// Drains the backend buffer.
    pub fn poll(&mut self) -> WatchUpdate {
        let mut events = Vec::new();
        loop {
            match self.receiver.try_recv() {
                Ok(Ok(event)) => {
                    if event.need_rescan() {
                        self.core.note_queue_overflow();
                    } else {
                        let mapped = map_event(self.core.root(), &event);
                        note_structural_changes(&mut self.core, &event);
                        events.extend(mapped);
                    }
                }
                Ok(Err(error)) => {
                    log::warn!("watch backend error: {error}");
                    if self.core.on_backend_error() {
                        self.switch_to_polling();
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.core.on_backend_disconnected();
                    break;
                }
            }
        }
        if self.core.invalidated().is_some() {
            return WatchUpdate {
                events: Vec::new(),
                mode: self.core.mode(),
                invalidated: self.core.invalidated(),
            };
        }
        WatchUpdate {
            events,
            mode: self.core.mode(),
            invalidated: None,
        }
    }

    fn switch_to_polling(&mut self) {
        if let Ok((backend, receiver)) = open_polling(self.core.root(), self.poll_interval) {
            self.backend = backend;
            self.receiver = receiver;
        } else {
            log::error!("could not establish the polling watcher; requiring a rescan");
            self.core.on_backend_disconnected();
        }
    }
}

fn open_native(root: &Path) -> Result<(Backend, Receiver<notify::Result<Event>>), notify::Error> {
    let (sender, receiver) = mpsc::channel();
    let mut watcher = RecommendedWatcher::new(
        move |result| {
            let _ = sender.send(result);
        },
        Config::default(),
    )?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok((Backend::Native(watcher), receiver))
}

fn open_polling(
    root: &Path,
    poll_interval: Duration,
) -> Result<(Backend, Receiver<notify::Result<Event>>), DegradeReason> {
    let (sender, receiver) = mpsc::channel();
    let mut watcher = PollWatcher::new(
        move |result| {
            let _ = sender.send(result);
        },
        Config::default().with_poll_interval(poll_interval),
    )
    .map_err(classify_notify_error)?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(classify_notify_error)?;
    Ok((Backend::Polling(watcher), receiver))
}

fn classify_notify_error(error: notify::Error) -> DegradeReason {
    match error.kind {
        notify::ErrorKind::MaxFilesWatch => DegradeReason::WatchLimitExhausted,
        notify::ErrorKind::Io(io_error) => DegradeReason::classify(&io_error),
        _ => DegradeReason::Io(std::io::ErrorKind::Other),
    }
}

/// Reports structural changes that make the snapshot unattributable.
///
/// Anything the file system cannot classify also invalidates: guessing whether
/// an unreadable path is a file or a directory is exactly how a subtree gets
/// silently dropped.
fn note_structural_changes(core: &mut SessionCore, event: &Event) {
    if core.invalidated().is_some() {
        return;
    }
    let create = matches!(event.kind, EventKind::Create(_));
    let remove = matches!(event.kind, EventKind::Remove(_));
    let rename = matches!(&event.kind, EventKind::Modify(ModifyKind::Name(_)));
    if !(create || remove || rename) {
        return;
    }

    if create {
        for path in &event.paths {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if !metadata.is_dir() => {}
                // A directory appeared (its watch registration races its
                // children) or the path cannot be classified.
                Ok(_) | Err(_) => {
                    core.note_structure_changed();
                    return;
                }
            }
        }
        return;
    }

    let removed_side = remove
        || matches!(
            &event.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::From | RenameMode::Both))
        );
    let moved_in = matches!(
        &event.kind,
        EventKind::Modify(ModifyKind::Name(RenameMode::To | RenameMode::Both))
    );
    for path in &event.paths {
        if moved_in {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) if !metadata.is_dir() => {}
                Ok(_) | Err(_) => {
                    core.note_structure_changed();
                    return;
                }
            }
        }
        let Ok(rel) = path.strip_prefix(core.root()) else {
            continue;
        };
        if removed_side && core.tracks(rel) {
            core.note_structure_changed();
            return;
        }
    }
}

/// Maps one backend event to normalized changes relative to `root`.
fn map_event(root: &Path, event: &Event) -> Vec<WatchEvent> {
    let mut changes: Vec<(PathBuf, ChangeAction)> = Vec::new();
    let push_all = |changes: &mut Vec<(PathBuf, ChangeAction)>, action: ChangeAction| {
        changes.extend(event.paths.iter().cloned().map(|path| (path, action)));
    };
    match &event.kind {
        EventKind::Create(_) => push_all(&mut changes, ChangeAction::Added),
        EventKind::Remove(_) => push_all(&mut changes, ChangeAction::Removed),
        EventKind::Modify(ModifyKind::Name(mode)) => match mode {
            RenameMode::From => push_all(&mut changes, ChangeAction::Removed),
            RenameMode::To => push_all(&mut changes, ChangeAction::Added),
            RenameMode::Both => {
                if let Some(path) = event.paths.first() {
                    changes.push((path.clone(), ChangeAction::Removed));
                }
                changes.extend(
                    event
                        .paths
                        .iter()
                        .skip(1)
                        .cloned()
                        .map(|path| (path, ChangeAction::Added)),
                );
            }
            // The direction is unknown: use the file system to tell whether the
            // path exists now.
            RenameMode::Any | RenameMode::Other => {
                changes.extend(event.paths.iter().cloned().map(|path| {
                    let action = if path.exists() {
                        ChangeAction::Added
                    } else {
                        ChangeAction::Removed
                    };
                    (path, action)
                }))
            }
        },
        EventKind::Modify(_) => push_all(&mut changes, ChangeAction::Modified),
        EventKind::Access(_) | EventKind::Other | EventKind::Any => {}
    }
    changes
        .into_iter()
        .filter_map(|(path, action)| {
            path.strip_prefix(root)
                .ok()
                .map(Path::to_path_buf)
                .map(|rel| WatchEvent { rel, action })
        })
        .collect()
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod watch_tests;
