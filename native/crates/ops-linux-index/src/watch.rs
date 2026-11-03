// Design informed by mustafaahci/goz (MIT).
//! Incremental watch session: notify's inotify backend, polling fallback, and
//! invalidation when the watch tree can no longer be trusted.
//!
//! The session's contract with the caller:
//!
//! 1. [`WatchSession::start`] opens the watcher on the root *before* the cold
//!    walk, so changes during enumeration are buffered.
//! 2. `walk::enumerate` builds the snapshot.
//! 3. [`WatchSession::adopt_directories`] records which relative paths are
//!    directories in that snapshot.
//! 4. [`WatchSession::poll`] drains the buffer. The caller applies the events;
//!    when `invalidated` is set it must discard the snapshot and rescan, then
//!    call [`WatchSession::resync_baseline`].
//!
//! Why invalidation instead of best-effort replay: an inotify watch is attached
//! to an inode. Rename or delete a watched directory and the kernel either
//! moves the watch with it or drops it; events produced afterwards can no
//! longer be attributed to the paths in the snapshot. A directory moved *into*
//! the tree has the same problem in reverse: its existing children emit no
//! creation events, so an index would miss them. Applying such events would
//! silently corrupt the index, so the session reports the need for a rescan.
//!
//! Event loss is treated the same way: the kernel flags a queue overflow as a
//! "rescan" event, and a native watcher that fails is replaced by a polling
//! watcher while the session demands a rescan, because notifications between
//! the failure and the polling baseline may be missing.

use crate::limits::{DegradeReason, WatchLimits};
use notify::event::{Event, EventKind, ModifyKind, RenameMode};
use notify::{Config, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use ops_index::ChangeAction;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::Duration;

/// Poll interval used when the native watcher cannot be maintained.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Which backend is delivering events.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchMode {
    /// The kernel event backend (`inotify` through notify's
    /// `RecommendedWatcher`).
    Native,
    /// notify's `PollWatcher`, used when a native watcher cannot be
    /// established or maintained.
    Polling,
}

/// Why incremental tracking gave up and the caller must rescan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidationReason {
    /// The kernel reported a queue overflow: notifications were dropped.
    QueueOverflow,
    /// A tracked directory (or one of its ancestors) was removed or moved, or a
    /// directory was moved into the tree.
    WatchedTreeMoved,
    /// The native watcher failed and the session degraded to polling; events
    /// between the failure and the polling baseline may be missing.
    DegradedToPolling,
    /// No backend is delivering events any more.
    BackendLost,
}

impl InvalidationReason {
    /// Stable, machine-readable code for host error mapping.
    pub fn code(self) -> &'static str {
        match self {
            Self::QueueOverflow => "INDEX_WATCH_QUEUE_OVERFLOW",
            Self::WatchedTreeMoved => "INDEX_WATCH_TREE_MOVED",
            Self::DegradedToPolling => "INDEX_WATCH_DEGRADED",
            Self::BackendLost => "INDEX_WATCH_BACKEND_LOST",
        }
    }
}

/// One normalized change, relative to the watch root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchEvent {
    /// Path relative to the watch root; empty for the root itself.
    pub rel: PathBuf,
    /// What happened to it.
    pub action: ChangeAction,
}

/// One [`WatchSession::poll`] result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchUpdate {
    /// Events in delivery order. Empty when `invalidated` is set: a rescan
    /// makes individual changes irrelevant.
    pub events: Vec<WatchEvent>,
    /// Backend currently in use.
    pub mode: WatchMode,
    /// Set when the snapshot must be rebuilt; sticky until
    /// [`WatchSession::resync_baseline`].
    pub invalidated: Option<InvalidationReason>,
}

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

/// The backend-independent decision state, testable without a kernel watcher.
struct SessionCore {
    root: PathBuf,
    known_dirs: HashSet<PathBuf>,
    mode: WatchMode,
    invalidated: Option<InvalidationReason>,
}

impl SessionCore {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            known_dirs: HashSet::new(),
            mode: WatchMode::Native,
            invalidated: None,
        }
    }

    fn adopt_directories(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.known_dirs.extend(dirs);
    }

    fn resync_baseline(&mut self, dirs: impl IntoIterator<Item = PathBuf>) {
        self.known_dirs.clear();
        self.known_dirs.extend(dirs);
        self.invalidated = None;
    }

    /// Consumes one backend event, returning the normalized changes.
    fn on_event(&mut self, event: &Event) -> Vec<WatchEvent> {
        if event.need_rescan() {
            self.invalidate(InvalidationReason::QueueOverflow);
            return Vec::new();
        }
        let mapped = map_event(&self.root, event);
        self.check_cascade(event);
        mapped
    }

    /// Returns whether the caller should try to switch to the polling backend.
    fn on_backend_error(&mut self) -> bool {
        match self.mode {
            WatchMode::Native => {
                self.mode = WatchMode::Polling;
                self.invalidate(InvalidationReason::DegradedToPolling);
                true
            }
            WatchMode::Polling => {
                self.invalidate(InvalidationReason::BackendLost);
                false
            }
        }
    }

    fn invalidate(&mut self, reason: InvalidationReason) {
        if self.invalidated.is_none() {
            self.invalidated = Some(reason);
        }
    }

    /// Whether `rel` is a tracked directory or an ancestor of one.
    fn tracks(&self, rel: &Path) -> bool {
        self.known_dirs.contains(rel) || self.known_dirs.iter().any(|dir| dir.starts_with(rel))
    }

    /// Structural removals/moves cannot be replayed against the snapshot.
    fn check_cascade(&mut self, event: &Event) {
        if self.invalidated.is_some() {
            return;
        }
        let rename = matches!(&event.kind, EventKind::Modify(ModifyKind::Name(_)));
        let remove = matches!(event.kind, EventKind::Remove(_));
        if !rename && !remove {
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
            let rel = match path.strip_prefix(&self.root) {
                Ok(rel) => rel.to_path_buf(),
                Err(_) => continue,
            };
            if (moved_in && path.is_dir()) || (removed_side && self.tracks(&rel)) {
                self.invalidate(InvalidationReason::WatchedTreeMoved);
                return;
            }
        }
    }
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
        core.mode = WatchMode::Polling;
        Ok(Self {
            backend,
            receiver,
            core,
            poll_interval,
        })
    }

    /// Backend currently in use.
    pub fn mode(&self) -> WatchMode {
        self.core.mode
    }

    /// Why a rescan is required, if it is.
    pub fn invalidated(&self) -> Option<InvalidationReason> {
        self.core.invalidated
    }

    /// Records the relative paths that are directories in the cold snapshot.
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
                Ok(Ok(event)) => events.extend(self.core.on_event(&event)),
                Ok(Err(error)) => {
                    log::warn!("watch backend error: {error}");
                    if self.core.on_backend_error() {
                        self.switch_to_polling();
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.core.invalidate(InvalidationReason::BackendLost);
                    break;
                }
            }
        }
        if self.core.invalidated.is_some() {
            return WatchUpdate {
                events: Vec::new(),
                mode: self.core.mode,
                invalidated: self.core.invalidated,
            };
        }
        WatchUpdate {
            events,
            mode: self.core.mode,
            invalidated: None,
        }
    }

    fn switch_to_polling(&mut self) {
        if let Ok((backend, receiver)) = open_polling(&self.core.root, self.poll_interval) {
            self.backend = backend;
            self.receiver = receiver;
        } else {
            log::error!("could not establish the polling watcher; requiring a rescan");
            self.core.invalidate(InvalidationReason::BackendLost);
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
