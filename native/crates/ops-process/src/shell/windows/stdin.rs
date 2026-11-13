//! One owned, bounded input record. The writer closes EOF only after its bytes settle.
use super::spill_io::Cancellation;
use crate::shell::MAX_INPUT_BYTES;
use std::{
    fs::File,
    io::{self, Write},
    os::windows::io::{AsRawHandle, OwnedHandle},
    thread::{self, JoinHandle},
};

pub(super) struct Input {
    writer: Option<OwnedHandle>,
    thread: Option<JoinHandle<io::Result<()>>>,
    pub control: Cancellation,
    #[cfg(test)]
    pub written: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl Input {
    pub fn new(writer: OwnedHandle) -> Self {
        Self {
            writer: Some(writer),
            thread: None,
            control: Cancellation::default(),
            #[cfg(test)]
            written: Default::default(),
        }
    }
    pub fn start(&mut self, bytes: Vec<u8>) -> io::Result<()> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "stdin exceeds 2 MiB",
            ));
        }
        let writer = self
            .writer
            .take()
            .ok_or_else(|| io::Error::other("stdin already closed or started"))?;
        let control = self.control.clone();
        #[cfg(test)]
        let written = self.written.clone();
        self.thread = Some(
            thread::Builder::new()
                .name("ops-owned-stdin".into())
                .spawn(move || {
                    control.register()?;
                    let mut file = File::from(writer);
                    let mut remaining = bytes.as_slice();
                    while !remaining.is_empty() {
                        let count = control.operation(Some(file.as_raw_handle()), false, || {
                            file.write(&remaining[..remaining.len().min(8192)])
                        })?;
                        if count == 0 {
                            return Err(io::Error::new(
                                io::ErrorKind::WriteZero,
                                "stdin wrote no bytes",
                            ));
                        }
                        remaining = &remaining[count..];
                        #[cfg(test)]
                        written.fetch_add(count, std::sync::atomic::Ordering::Release);
                    }
                    // File drop closes the sole parent writer before the thread reports completion.
                    drop(file);
                    #[cfg(test)]
                    control.wait_close_gate();
                    Ok(())
                })?,
        );
        Ok(())
    }
    pub fn cancel(&mut self) {
        self.writer.take();
        self.control.cancel();
    }
    pub fn is_finished(&self) -> bool {
        self.writer.is_none() && self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }
    pub fn join(&mut self) -> io::Result<()> {
        self.writer.take();
        self.thread.take().map_or(Ok(()), |thread| {
            thread
                .join()
                .map_err(|_| io::Error::other("stdin writer panicked"))?
        })
    }
}
