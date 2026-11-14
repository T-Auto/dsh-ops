//! A generation-local progress hint. Callers must still verify receipts, EOF,
//! errors, ownership and deadlines; a wake never authorizes completion.
use std::{
    sync::{Arc, Condvar, Mutex},
    time::Instant,
};

#[derive(Default)]
struct State {
    revision: Mutex<u64>,
    ready: Condvar,
}
#[derive(Clone, Default)]
pub struct ChannelProgress(Arc<State>);
impl ChannelProgress {
    pub fn version(&self) -> u64 {
        *self.0.revision.lock().unwrap()
    }
    pub(super) fn changed(&self) {
        let mut revision = self.0.revision.lock().unwrap();
        *revision = revision.wrapping_add(1);
        self.0.ready.notify_all();
    }
    /// Capture the version before observing channels, then wait on that version.
    /// A notification between the observation and this wait cannot be lost.
    pub fn wait(&self, observed: u64, deadline: Instant) -> bool {
        let revision = self.0.revision.lock().unwrap();
        let (revision, _) = self
            .0
            .ready
            .wait_timeout_while(
                revision,
                deadline.saturating_duration_since(Instant::now()),
                |value| *value == observed,
            )
            .unwrap();
        *revision != observed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Duration};
    #[test]
    fn a_notification_before_wait_is_not_lost() {
        let progress = ChannelProgress::default();
        let observed = progress.version();
        progress.changed();
        assert!(progress.wait(observed, Instant::now()));
        assert!(!progress.wait(progress.version(), Instant::now()));
    }
    #[test]
    fn notification_wakes_waiters_and_unrelated_generations_do_not_share_state() {
        let progress = ChannelProgress::default();
        let other = ChannelProgress::default();
        let observed = progress.version();
        let (started, entered) = mpsc::channel();
        let waiter = progress.clone();
        let thread = thread::spawn(move || {
            started.send(()).unwrap();
            waiter.wait(observed, Instant::now() + Duration::from_secs(2))
        });
        entered.recv().unwrap();
        progress.changed();
        assert!(thread.join().unwrap());
        assert_eq!(other.version(), 0);
        assert!(!other.wait(0, Instant::now()));
    }
}
