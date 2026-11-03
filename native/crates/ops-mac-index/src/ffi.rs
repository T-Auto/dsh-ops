// Design informed by mustafaahci/goz (MIT).

//! Raw FSEvents FFI: the single `unsafe` island of this crate.
//!
//! Every other module is safe Rust; this one owns all pointer handling. Each
//! `unsafe` block carries a SAFETY comment naming the invariant that makes it
//! sound, and the crate root sets `unsafe_op_in_unsafe_fn = deny`, so even
//! inside an `unsafe fn` nothing is implicitly unsafe.
//!
//! ## Ownership
//!
//! [`Stream`] owns the `FSEventStreamRef`. The delivery sink is an
//! `Arc<Mutex<Vec<RawEvent>>>`; a raw pointer to it goes into the stream
//! context, and FSEvents calls the context's `release` callback exactly once
//! when it deallocates the stream. That callback drops the raw reference, so a
//! forgotten or leaked stream can leak the sink but can never leave a callback
//! pointing at freed memory.
//!
//! ## Delivery
//!
//! The callback is invoked on the thread that runs the stream's run loop, and
//! it does only three things: read the arrays the kernel passed, convert each
//! item to an owned [`RawEvent`], and append it under the mutex. It never
//! panics, never allocates unboundedly per event beyond the path string, and
//! never calls back into Rust code that could re-enter the stream.
//!
//! ## Threading
//!
//! A stream is created, scheduled and delivered on one thread's run loop. The
//! handle is a raw pointer and therefore neither `Send` nor `Sync`; moving an
//! `EventStream` to another thread does not compile, which is what keeps "the
//! thread that schedules it also runs it" from becoming a runtime accident.

use crate::fsevents::{EventError, EventId};
use objc2_core_foundation::{
    CFArray, CFDictionary, CFGetTypeID, CFIndex, CFNumber, CFRetained, CFRunLoop, CFString, CFType,
    ConcreteType, kCFRunLoopDefaultMode,
};
use objc2_core_services::{
    ConstFSEventStreamRef, FSEventStreamContext, FSEventStreamCopyPathsBeingWatched,
    FSEventStreamCreate, FSEventStreamCreateFlags, FSEventStreamEventFlags, FSEventStreamEventId,
    FSEventStreamGetLatestEventId, FSEventStreamInvalidate, FSEventStreamRef, FSEventStreamRelease,
    FSEventStreamStart, FSEventStreamStop, FSEventsGetCurrentEventId,
    kFSEventStreamCreateFlagFileEvents, kFSEventStreamCreateFlagUseCFTypes,
    kFSEventStreamCreateFlagUseExtendedData,
};
use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Creation flags this source always uses.
///
/// - `FileEvents`: report individual entries instead of whole directories; a
///   name index cannot do anything with "rescan this directory".
/// - `UseCFTypes`: required by `UseExtendedData`; it makes the callback
///   receive CoreFoundation objects instead of C string arrays.
/// - `UseExtendedData`: the callback receives a dictionary per event whose
///   `"path"` and `"fileID"` deliver the file id for free, so a rename can be
///   attributed without a second `stat`.
pub(crate) const CREATE_FLAGS: FSEventStreamCreateFlags = kFSEventStreamCreateFlagFileEvents
    | kFSEventStreamCreateFlagUseCFTypes
    | kFSEventStreamCreateFlagUseExtendedData;

/// Dictionary key whose value is the event path (a `CFString`).
pub(crate) const EXTENDED_PATH_KEY: &str = "path";

/// Dictionary key whose value is the file id (a `CFNumber`, signed 64-bit).
pub(crate) const EXTENDED_FILE_ID_KEY: &str = "fileID";

/// Runs the calling thread's run loop for at most `seconds`.
///
/// This is the delivery pump behind [`Stream::take_events`]: FSEvents invokes
/// the callback only while the stream's run loop runs, so the safe layer asks
/// for one bounded slice at a time instead of owning a loop of its own.
pub(crate) fn run_current_run_loop(seconds: f64) {
    // SAFETY: the default mode is an immutable CoreFoundation string owned by
    // the framework for the process lifetime; running the loop needs no other
    // precondition.
    let mode = unsafe { kCFRunLoopDefaultMode };
    let _ = CFRunLoop::run_in_mode(mode, seconds, false);
}

/// The latest event id the system has assigned, for starting from "now".
pub(crate) fn current_event_id() -> EventId {
    // SAFETY: the function takes no arguments and returns a plain integer.
    EventId::from_raw(unsafe { FSEventsGetCurrentEventId() })
}

/// One event exactly as the kernel reported it, still untyped by policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RawEvent {
    /// Kernel event id; exclusive, monotonically increasing per volume.
    pub(crate) id: u64,
    /// Raw `FSEventStreamEventFlags` bits.
    pub(crate) flags: u32,
    /// Absolute path the event refers to.
    pub(crate) path: String,
    /// File id from the extended data, when this macOS reports it.
    pub(crate) file_id: Option<u64>,
}

/// An owned, started FSEvents stream.
///
/// Not `Send`/`Sync` on purpose: it is bound to the run loop of the thread
/// that created it (a raw pointer field makes both traits unavailable).
pub(crate) struct Stream {
    /// Non-null by construction; FSEvents returns NULL only on allocation
    /// failure, which [`Stream::create`] turns into an error.
    handle: FSEventStreamRef,
    /// Sink the callback appends to. The stream context holds another strong
    /// reference to this allocation through the `release` callback.
    sink: Arc<Mutex<Vec<RawEvent>>>,
    /// Paths the kernel reported at creation; captured before the stream starts
    /// so a later query cannot be confused by replay traffic.
    watched: Vec<PathBuf>,
    /// Whether `FSEventStreamStart` succeeded, so `Drop` knows to stop first.
    started: bool,
}

impl Stream {
    /// Creates, schedules and starts a stream watching every root in one
    /// stream.
    ///
    /// All roots go into a single `FSEventStreamCreate` call: the kernel
    /// multiplexes them, so the number of streams does not grow with the number
    /// of roots. `since` replays from that event id (pass [`EventId::SINCE_NOW`]
    /// for live-only delivery). `latency` is the kernel's coalescing window.
    ///
    /// # Errors
    ///
    /// - [`EventError::NonUtf8Root`] when a root cannot be represented as a
    ///   CoreFoundation string.
    /// - [`EventError::CreationFailed`] when FSEvents refuses to create the
    ///   stream (allocation failure, unsupported volume).
    /// - [`EventError::ScheduleFailed`] when the calling thread has no run
    ///   loop.
    /// - [`EventError::StartFailed`] when the stream cannot be started
    ///   (permissions, invalid paths).
    pub(crate) fn create(
        roots: &[PathBuf],
        since: EventId,
        latency: Duration,
    ) -> Result<Self, EventError> {
        let paths = path_array(roots)?;
        let sink = Arc::new(Mutex::new(Vec::new()));
        // The stream takes ownership of one strong reference through the
        // context; the raw pointer is reclaimed either by `release_sink` (on
        // success) or explicitly below (on creation failure).
        let context_info = Arc::into_raw(Arc::clone(&sink)).cast_mut().cast::<c_void>();
        let mut context = FSEventStreamContext {
            version: 0,
            info: context_info,
            retain: None,
            release: Some(release_sink),
            copyDescription: None,
        };
        // SAFETY: `context` lives for the whole call (FSEventStreamCreate copies
        // it), the callback matches the required signature, `paths` is a live
        // CFArray of CFString, and every argument is a plain scalar.
        let handle = unsafe {
            FSEventStreamCreate(
                None,
                Some(on_events),
                &mut context,
                paths.as_opaque(),
                since.raw(),
                latency.as_secs_f64(),
                CREATE_FLAGS,
            )
        };
        if handle.is_null() {
            // SAFETY: creation failed, so the stream never took ownership of
            // the context; this drops the reference `Arc::into_raw` produced.
            drop(unsafe { Arc::from_raw(context_info.cast::<Mutex<Vec<RawEvent>>>()) });
            return Err(EventError::CreationFailed);
        }

        let run_loop = match CFRunLoop::current() {
            Some(run_loop) => run_loop,
            None => return Err(abandon(handle, EventError::ScheduleFailed)),
        };
        // SAFETY: the static is an immutable CoreFoundation string owned by the
        // framework for the process lifetime.
        let mode = match unsafe { kCFRunLoopDefaultMode } {
            Some(mode) => mode,
            None => return Err(abandon(handle, EventError::ScheduleFailed)),
        };
        // SAFETY: `handle` is live and `run_loop`/`mode` are valid CF objects for the
        // duration of the call. The run-loop scheduling entry point is marked
        // deprecated upstream in favour of dispatch queues; it is still the
        // documented way to drive a stream from the caller's run loop, and the
        // dispatch-queue alternative would add a queue dependency for the same
        // single-threaded delivery.
        #[allow(deprecated)]
        unsafe {
            objc2_core_services::FSEventStreamScheduleWithRunLoop(handle, &run_loop, mode);
        }
        // SAFETY: the stream is live and scheduled; `FSEventStreamStart` only
        // reads the handle it is given.
        let started = unsafe { FSEventStreamStart(handle) };
        if !started {
            return Err(abandon(handle, EventError::StartFailed));
        }
        let watched = copy_paths(handle);
        Ok(Self {
            handle,
            sink,
            watched,
            started: true,
        })
    }

    /// Removes every event the callback collected since the last call.
    pub(crate) fn take_events(&self) -> Vec<RawEvent> {
        let mut sink = match self.sink.lock() {
            Ok(guard) => guard,
            // The callback cannot panic while holding the lock, so poisoning is
            // not reachable from this crate; recover instead of propagating it.
            Err(poisoned) => poisoned.into_inner(),
        };
        std::mem::take(&mut *sink)
    }

    /// Paths FSEvents reported as being watched when the stream was created.
    ///
    /// Used by tests to prove that one stream covers every root.
    pub(crate) fn watched_paths(&self) -> Vec<PathBuf> {
        self.watched.clone()
    }

    /// Latest event id the stream has processed.
    pub(crate) fn latest_event_id(&self) -> EventId {
        // SAFETY: `handle` is live for as long as `self`.
        EventId::from_raw(unsafe { FSEventStreamGetLatestEventId(self.handle) })
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: `handle` is the live stream created in `create` and has not
        // been released yet. Stop is only valid on a started stream; invalidate
        // then unschedules it and marks it unusable; release drops the last
        // reference, which runs the context's `release` callback.
        unsafe {
            if self.started {
                FSEventStreamStop(self.handle);
            }
            FSEventStreamInvalidate(self.handle);
            FSEventStreamRelease(self.handle);
        }
    }
}

/// Releases a stream that never finished construction and returns the error.
fn abandon(handle: FSEventStreamRef, error: EventError) -> EventError {
    // SAFETY: the handle is live and was never released; invalidate plus
    // release is the documented teardown order and runs the context release
    // callback, which drops the strong reference `create` transferred.
    unsafe {
        FSEventStreamInvalidate(handle);
        FSEventStreamRelease(handle);
    }
    error
}

/// Reads back the path list the kernel accepted for `handle`.
fn copy_paths(handle: FSEventStreamRef) -> Vec<PathBuf> {
    // SAFETY: `handle` is live, and `FSEventStreamCopyPathsBeingWatched`
    // returns a +1 retained CFArray.
    let array = unsafe { FSEventStreamCopyPathsBeingWatched(handle) };
    // SAFETY: FSEvents fills this array with CFString paths (the same values
    // passed to `create`), so re-typing the opaque array is sound.
    let paths: &CFArray<CFString> =
        unsafe { &*(CFRetained::as_ptr(&array).as_ptr() as *const CFArray<CFString>) };
    paths
        .to_vec()
        .iter()
        .map(|path| PathBuf::from(path.to_string()))
        .collect()
}

/// Builds the `CFArray` of watched paths, refusing non-UTF-8 ones.
fn path_array(roots: &[PathBuf]) -> Result<CFRetained<CFArray<CFString>>, EventError> {
    let mut strings = Vec::with_capacity(roots.len());
    for root in roots {
        // FSEvents takes CFString paths; a POSIX path that is not valid UTF-8
        // cannot be represented, and guessing an encoding would watch the wrong
        // path. Refuse instead of silently watching nothing.
        let Some(text) = root.to_str() else {
            return Err(EventError::NonUtf8Root(root.clone()));
        };
        strings.push(CFString::from_str(text));
    }
    Ok(CFArray::from_retained_objects(&strings))
}

/// Drops the sink reference the stream context holds.
///
/// # Safety
///
/// FSEvents calls this exactly once, when the stream is deallocated, with the
/// `info` pointer passed to `FSEventStreamCreate`; that pointer came from
/// `Arc::into_raw` and has not been reclaimed anywhere else.
unsafe extern "C-unwind" fn release_sink(info: *const c_void) {
    if info.is_null() {
        return;
    }
    // SAFETY: per the contract above this pointer owns exactly one strong
    // reference created by `Arc::into_raw`.
    drop(unsafe { Arc::from_raw(info.cast::<Mutex<Vec<RawEvent>>>()) });
}

/// FSEvents delivery callback.
///
/// # Safety
///
/// The kernel calls this with `num_events` valid entries in each of the three
/// arrays and with `info` pointing at the sink from `FSEventStreamCreate`.
unsafe extern "C-unwind" fn on_events(
    _stream: ConstFSEventStreamRef,
    info: *mut c_void,
    num_events: usize,
    event_paths: NonNull<c_void>,
    event_flags: NonNull<FSEventStreamEventFlags>,
    event_ids: NonNull<FSEventStreamEventId>,
) {
    if info.is_null() || num_events == 0 {
        return;
    }
    // SAFETY: `info` is the sink pointer installed by `Stream::create`, and the
    // stream context holds a strong reference for as long as callbacks can run.
    let sink = unsafe { &*info.cast::<Mutex<Vec<RawEvent>>>() };
    let Ok(mut sink) = sink.lock() else {
        // A poisoned sink would mean a panic in a path that cannot panic; do
        // not propagate, just drop this batch.
        return;
    };
    // SAFETY: the callback contract documents `num_events` entries in both
    // arrays; they are valid for the duration of the call.
    let flags = unsafe { std::slice::from_raw_parts(event_flags.as_ptr(), num_events) };
    // SAFETY: same contract as above.
    let ids = unsafe { std::slice::from_raw_parts(event_ids.as_ptr(), num_events) };
    // SAFETY: with `UseCFTypes`, `eventPaths` is a CFArray; the callback contract
    // guarantees it is valid for the duration of the call.
    let paths: &CFArray = unsafe { &*event_paths.as_ptr().cast::<CFArray>() };
    let path_key = CFString::from_static_str(EXTENDED_PATH_KEY);
    let file_id_key = CFString::from_static_str(EXTENDED_FILE_ID_KEY);
    for index in 0..num_events {
        let Some(event) = read_path(paths, index as CFIndex, &path_key, &file_id_key) else {
            continue;
        };
        sink.push(RawEvent {
            id: ids[index],
            flags: flags[index],
            path: event.0,
            file_id: event.1,
        });
    }
}

/// Reads one `eventPaths` element, accepting both the extended-data dictionary
/// and the plain-CFString form.
fn read_path(
    paths: &CFArray,
    index: CFIndex,
    path_key: &CFString,
    file_id_key: &CFString,
) -> Option<(String, Option<u64>)> {
    // SAFETY: `index` comes from the callback's `num_events` count, which the
    // kernel guarantees matches this array. The element is a live CF object for
    // the duration of the callback, and therefore non-NULL.
    let raw = unsafe { paths.value_at_index(index) };
    if raw.is_null() {
        return None;
    }
    // SAFETY: non-NULL CF object handed to us by the framework, valid for the
    // duration of the callback.
    let value: &CFType = unsafe { &*raw.cast::<CFType>() };
    let type_id = CFGetTypeID(Some(value));
    if type_id == CFString::type_id() {
        // SAFETY: the type id just identified the object as a CFString.
        let text: &CFString = unsafe { &*raw.cast::<CFString>() };
        return Some((text.to_string(), None));
    }
    if type_id != CFDictionary::type_id() {
        return None;
    }
    // SAFETY: the type id identified a CFDictionary. Its keys are CFStrings and
    // the value under `path_key` is a CFString; viewing the same object with
    // those types is what the extended-data contract documents.
    let dictionary: &CFDictionary<CFString, CFString> =
        unsafe { &*raw.cast::<CFDictionary<CFString, CFString>>() };
    // SAFETY: the dictionary is immutable and lives for the whole callback.
    let path = unsafe { dictionary.get_unchecked(path_key) }?.to_string();
    // SAFETY: same dictionary, viewed with the value type the extended data
    // documents: `fileID` is a CFNumber.
    let numbers: &CFDictionary<CFString, CFNumber> =
        unsafe { &*raw.cast::<CFDictionary<CFString, CFNumber>>() };
    // SAFETY: the dictionary and its values are immutable for the callback.
    let file_id = unsafe { numbers.get_unchecked(file_id_key) }
        .and_then(CFNumber::as_i64)
        .and_then(|raw| u64::try_from(raw).ok());
    Some((path, file_id))
}
