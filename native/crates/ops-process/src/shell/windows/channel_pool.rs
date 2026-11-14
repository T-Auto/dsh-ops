//! Fixed private pipe instances and readers. Every checkout owns fresh capture,
//! cancellation and prefix state; reuse waits for physical operation retirement.
use super::{channel::Channel, job::Job, owned, security, spill_file::SpillStore};
use std::{
    ffi::OsString,
    io,
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, OwnedHandle, RawHandle},
    },
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
};
use windows_sys::Win32::{
    Foundation::{ERROR_PIPE_NOT_CONNECTED, WAIT_OBJECT_0},
    Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
    },
    System::{
        Pipes::{CreateNamedPipeW, DisconnectNamedPipe, PIPE_REJECT_REMOTE_CLIENTS},
        Threading::{CreateEventW, INFINITE, SetEvent, WaitForSingleObject},
    },
};

type Work = Box<dyn FnOnce() + Send + 'static>;
struct Task {
    work: Work,
    done: Arc<Done>,
}
pub(super) struct Done {
    event: OwnedHandle,
    finished: AtomicBool,
    failed: AtomicBool,
}
pub(super) enum Reader {
    Dedicated(JoinHandle<()>),
    Pooled(Arc<Done>),
}
impl Reader {
    pub fn is_finished(&self) -> bool {
        match self {
            Self::Dedicated(reader) => reader.is_finished(),
            Self::Pooled(done) => done.finished.load(Ordering::Acquire),
        }
    }
    pub fn join(self) -> thread::Result<()> {
        match self {
            Self::Dedicated(reader) => reader.join(),
            Self::Pooled(done) => {
                while !done.finished.load(Ordering::Acquire) {
                    // Only teardown may wait without a deadline. Never detach an
                    // operation retaining its OVERLAPPED or spill buffers.
                    if unsafe { WaitForSingleObject(done.event.as_raw_handle(), INFINITE) }
                        != WAIT_OBJECT_0
                    {
                        thread::yield_now();
                    }
                }
                if done.failed.load(Ordering::Acquire) {
                    Err(Box::new("pooled reader failed"))
                } else {
                    Ok(())
                }
            }
        }
    }
}
impl AsRawHandle for Reader {
    fn as_raw_handle(&self) -> RawHandle {
        match self {
            Self::Dedicated(reader) => reader.as_raw_handle(),
            Self::Pooled(done) => done.event.as_raw_handle(),
        }
    }
}
struct Slot {
    handle: Arc<OwnedHandle>,
    send: Option<mpsc::SyncSender<Task>>,
    reader: Option<JoinHandle<()>>,
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.send.take();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
struct Pool {
    job: Arc<Job>,
    name: OsString,
    slots: Vec<Slot>,
    leased: AtomicBool,
    poisoned: Arc<AtomicBool>,
}
/// One generation at a time. A live or unconfirmed lease cannot be replaced.
#[derive(Clone)]
pub struct ChannelPool(Arc<Pool>);
pub(super) struct Lease(Arc<Pool>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.leased.store(false, Ordering::Release);
    }
}
impl Lease {
    pub fn poison(&self) {
        self.0.poisoned.store(true, Ordering::Release);
    }
    pub fn name(&self) -> OsString {
        self.0.name.clone()
    }
    pub fn job(&self) -> Arc<Job> {
        self.0.job.clone()
    }
    pub fn handles(&self) -> Vec<Arc<OwnedHandle>> {
        self.0
            .slots
            .iter()
            .map(|slot| slot.handle.clone())
            .collect()
    }
    pub fn start(&self, index: usize, work: Work) -> io::Result<Reader> {
        let done = Arc::new(Done {
            event: owned(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?,
            finished: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        });
        self.0.slots[index]
            .send
            .as_ref()
            .unwrap()
            .send(Task {
                work,
                done: done.clone(),
            })
            .map_err(|_| io::Error::other("pooled channel reader stopped"))?;
        Ok(Reader::Pooled(done))
    }
}
impl ChannelPool {
    pub(super) fn new(job: Arc<Job>) -> io::Result<Self> {
        let name = security::private_name()?;
        let descriptor = security::Security::new()?;
        let attributes = descriptor.attributes();
        let mut slots = Vec::with_capacity(4);
        let poisoned = Arc::new(AtomicBool::new(false));
        for index in 0..4 {
            let handle = Arc::new(owned(unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_DUPLEX
                        | FILE_FLAG_OVERLAPPED
                        | if index == 0 {
                            FILE_FLAG_FIRST_PIPE_INSTANCE
                        } else {
                            0
                        },
                    PIPE_REJECT_REMOTE_CLIENTS,
                    4,
                    65536,
                    65536,
                    0,
                    &attributes,
                )
            })?);
            let (send, receive) = mpsc::sync_channel::<Task>(1);
            let failed_pool = poisoned.clone();
            let reader = thread::Builder::new()
                .name("ops-shell-pool".into())
                .spawn(move || {
                    for Task { work, done } in receive {
                        // The FnOnce and all its captures retire before completion is
                        // signalled. Nothing from an old operation may borrow new state.
                        let failed = catch_unwind(AssertUnwindSafe(work)).is_err();
                        if failed {
                            failed_pool.store(true, Ordering::Release);
                        }
                        done.failed.store(failed, Ordering::Release);
                        done.finished.store(true, Ordering::Release);
                        if unsafe { SetEvent(done.event.as_raw_handle()) } == 0 {
                            done.failed.store(true, Ordering::Release);
                            failed_pool.store(true, Ordering::Release);
                        }
                    }
                })?;
            slots.push(Slot {
                handle,
                send: Some(send),
                reader: Some(reader),
            });
        }
        Ok(Self(Arc::new(Pool {
            job,
            name: OsString::from_wide(&name[..name.len() - 1]),
            slots,
            leased: AtomicBool::new(false),
            poisoned,
        })))
    }
    pub(super) fn lease(&self) -> io::Result<Lease> {
        if self.0.poisoned.load(Ordering::Acquire) {
            return Err(io::Error::other("channel pool is poisoned"));
        }
        if self.0.leased.swap(true, Ordering::AcqRel) {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "previous channel generation has not retired",
            ));
        }
        // A concurrently retiring generation can poison before releasing its lease.
        if self.0.poisoned.load(Ordering::Acquire) {
            self.0.leased.store(false, Ordering::Release);
            return Err(io::Error::other("channel pool is poisoned"));
        }
        Ok(Lease(self.0.clone()))
    }
    pub fn framed(&self, cap: usize, prefix: &[u8]) -> io::Result<Channel> {
        Channel::pooled(self.lease()?, cap, prefix, None)
    }
    pub fn spilling(
        &self,
        cap: usize,
        prefix: &[u8],
        store: SpillStore,
        stream: &'static str,
    ) -> io::Result<Channel> {
        Channel::pooled(self.lease()?, cap, prefix, Some((store, stream)))
    }
}

/// Retire the connection only after receive has joined all pending operations.
pub(super) fn disconnect(handle: &OwnedHandle) -> io::Result<()> {
    if unsafe { DisconnectNamedPipe(handle.as_raw_handle()) } != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_PIPE_NOT_CONNECTED as i32) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(test)]
#[path = "channel_pool_tests.rs"]
mod tests;
