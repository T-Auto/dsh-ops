//! A level-triggered wake for sealing pending channel connects, never active reads.
use super::{check, owned};
use std::{
    io,
    os::windows::io::{AsRawHandle, OwnedHandle},
    sync::atomic::{AtomicBool, Ordering},
    thread::JoinHandle,
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects},
};

/// Wait for physical reader termination, including thread-local destructors.
/// Borrowed handles remain owned by their JoinHandles until the wait returns.
pub(super) fn wait_readers(readers: &[JoinHandle<()>], deadline: Instant) -> io::Result<bool> {
    if readers.is_empty() {
        return Ok(true);
    }
    let handles: Vec<_> = readers.iter().map(AsRawHandle::as_raw_handle).collect();
    let remaining = deadline.saturating_duration_since(Instant::now());
    let millis = remaining
        .as_nanos()
        .div_ceil(1_000_000)
        .min(u32::MAX as u128 - 1) as u32;
    // Channel creation bounds this set to four readers. Wait-all observes actual
    // exit without racing an application notification sent just before exit.
    match unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 1, millis) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Ok(false),
        _ => Err(io::Error::last_os_error()),
    }
}

pub(super) struct ConnectSeal {
    pub flag: AtomicBool,
    pub event: OwnedHandle,
}

impl ConnectSeal {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            flag: AtomicBool::new(false),
            event: owned(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?,
        })
    }

    pub fn set(&self) -> io::Result<()> {
        self.flag.store(true, Ordering::Release);
        check(unsafe { SetEvent(self.event.as_raw_handle()) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, thread};
    use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject};

    #[test]
    fn sealing_wakes_all_connectors_including_late_waiters() {
        let seal = Arc::new(ConnectSeal::new().unwrap());
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let seal = seal.clone();
                thread::spawn(move || unsafe {
                    WaitForSingleObject(seal.event.as_raw_handle(), 2000)
                })
            })
            .collect();
        seal.set().unwrap();
        for reader in readers {
            assert_eq!(reader.join().unwrap(), WAIT_OBJECT_0);
        }
        assert!(seal.flag.load(Ordering::Acquire));
        // A connector may arm after sealing; its notification must not be lost.
        assert_eq!(
            unsafe { WaitForSingleObject(seal.event.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
        seal.set().unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(seal.event.as_raw_handle(), 0) },
            WAIT_OBJECT_0
        );
    }

    #[test]
    fn reader_wait_requires_every_thread_and_keeps_join_ownership() {
        let (release, blocked) = std::sync::mpsc::channel();
        let readers = vec![
            thread::spawn(|| {}),
            thread::spawn(move || blocked.recv().unwrap()),
        ];
        assert!(!wait_readers(&readers, Instant::now()).unwrap());
        release.send(()).unwrap();
        assert!(
            wait_readers(&readers, Instant::now() + std::time::Duration::from_secs(2)).unwrap()
        );
        for reader in readers {
            reader.join().unwrap();
        }
        assert!(wait_readers(&[], Instant::now()).unwrap());
    }
}
