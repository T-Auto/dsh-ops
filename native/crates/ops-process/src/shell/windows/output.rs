//! Filesystem I/O belongs to the existing reader thread, outside snapshot locks.
use super::{
    spill_file::{SpillFile, SpillStore},
    spill_io::Cancellation,
};
use crate::shell::{Capture, CaptureView, SpillSnapshot};
use std::io;

pub(super) struct Output {
    view: CaptureView,
    cap: usize,
    store: Option<SpillStore>,
    stream: &'static str,
    cancel: Cancellation,
    file: Option<SpillFile>,
    disabled: bool,
    error: Option<String>,
    observed: u64,
}

impl Output {
    pub fn new(
        view: CaptureView,
        cap: usize,
        store: Option<SpillStore>,
        stream: &'static str,
        cancel: Cancellation,
    ) -> Self {
        Self {
            view,
            cap,
            store,
            stream,
            cancel,
            file: None,
            disabled: false,
            error: None,
            observed: 0,
        }
    }
    pub fn start(&mut self) {
        if self.store.is_some()
            && let Err(error) = self.cancel.register()
        {
            self.disabled = true;
            self.error = Some(error.to_string());
        }
    }
    pub fn append(&mut self, bytes: &[u8]) -> u64 {
        if self.view.poisoned() {
            self.discard("output cleanup unconfirmed".into());
        }
        let observed = self.observed.saturating_add(bytes.len() as u64);
        if !self.disabled
            && let Some(store) = &self.store
        {
            if observed > store.cap() {
                self.discard("spill cap exceeded".into());
            } else if observed > self.cap as u64 {
                let result = (|| {
                    if self.file.is_none() {
                        let mut file = store.create(self.stream, &self.cancel)?;
                        // Before the first overflow, memory still contains the whole stream.
                        let result = file.write(&self.view.snapshot().bytes);
                        self.file = Some(file);
                        result?;
                    }
                    self.file.as_mut().unwrap().write(bytes)
                })();
                if let Err(error) = result {
                    self.discard(error.to_string());
                }
            }
        }
        if self.view.poisoned() {
            self.discard("output cleanup unconfirmed".into());
        }
        // A live file covers this exact reported observed prefix. Pending writes have
        // not committed their chunk yet; the prior snapshot remains independently readable.
        let spill = self.file.as_ref().map(|file| SpillSnapshot {
            path: file.path.clone(),
            pid: std::process::id(),
            sealed: false,
        });
        self.observed = self.view.commit(bytes, spill, self.error.clone());
        self.observed
    }
    fn discard(&mut self, error: String) {
        self.error = Some(error);
        self.disabled = true;
        self.view.commit(&[], None, self.error.clone());
        if let Some(file) = self.file.as_mut()
            && let Err(error) = file.close(false)
        {
            self.view
                .poison(format!("spill cleanup unconfirmed: {error}"));
            // The bounded owner retains this thread, its file and operation. The
            // coordinator must close admission and trigger managed-kernel teardown.
            // Dropping a JoinHandle here would silently detach an unconfirmed owner.
            loop {
                std::thread::park();
            }
        }
        self.file = None;
    }
    pub fn finish(mut self, result: &io::Result<()>) -> Capture {
        if self.view.poisoned() {
            self.discard("output cleanup unconfirmed".into());
        }
        if result.is_err() && self.store.is_some() {
            self.discard("raw stream did not reach EOF".into());
        }
        let mut sealed = None;
        if let Some(file) = self.file.as_mut() {
            match file.close(true) {
                Ok(path) => {
                    sealed = Some(SpillSnapshot {
                        path,
                        pid: std::process::id(),
                        sealed: true,
                    })
                }
                Err(error) => self.discard(error.to_string()),
            }
        }
        self.view.commit(&[], sealed, self.error.clone());
        self.view.finish(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Retention;

    #[test]
    fn unavailable_lazy_store_preserves_raw_eof_and_tail() {
        let root = std::env::temp_dir().join(format!(
            "missing-spill-{}",
            super::super::security::random_suffix().unwrap()
        ));
        let store = SpillStore::new(&root, 1024).unwrap();
        let view = CaptureView::new(4, Retention::Tail).unwrap();
        let mut output = Output::new(
            view.clone(),
            4,
            Some(store),
            "stdout",
            Cancellation::default(),
        );
        output.start();
        output.append(b"abcd");
        assert!(view.snapshot().spill_error.is_none());
        output.append(b"efgh");
        output.finish(&Ok(()));
        let snapshot = view.snapshot();
        assert_eq!(snapshot.bytes, b"efgh");
        assert_eq!(snapshot.observed, 8);
        assert!(snapshot.eof && snapshot.error.is_none());
        assert!(snapshot.spill.is_none() && snapshot.spill_error.is_some());
        assert!(!root.exists());
    }

    #[test]
    fn write_cancel_and_seal_failure_withdraw_the_complete_file() {
        for seal_failure in [false, true] {
            let store = SpillStore::new(&std::env::temp_dir(), 1024).unwrap();
            let view = CaptureView::new(4, Retention::Tail).unwrap();
            let cancel = Cancellation::default();
            let mut output = Output::new(
                view.clone(),
                4,
                Some(store.clone()),
                "stdout",
                cancel.clone(),
            );
            output.start();
            output.append(b"abcdef");
            let path = view.snapshot().spill.unwrap().path;
            assert_eq!(std::fs::read(&path).unwrap(), b"abcdef");
            if seal_failure {
                output.file.as_mut().unwrap().fail_seal = true;
            } else {
                cancel.cancel();
                output.append(b"gh");
            }
            output.finish(&Ok(()));
            let snapshot = view.snapshot();
            assert_eq!(snapshot.observed, if seal_failure { 6 } else { 8 });
            assert_eq!(snapshot.bytes, if seal_failure { b"cdef" } else { b"efgh" });
            assert!(snapshot.eof && snapshot.error.is_none());
            assert!(snapshot.spill.is_none() && snapshot.spill_error.is_some());
            assert!(!snapshot.cleanup_unconfirmed);
            assert!(!path.exists());
            let directory = store.test_directory();
            drop(store);
            std::fs::remove_dir(directory).unwrap();
        }
    }
}
