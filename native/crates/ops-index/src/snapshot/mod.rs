// Design informed by mustafaahci/goz (MIT).
//! Persistent snapshot: a self-contained on-disk image of one index root.
//!
//! A worker process is spawned per call, so an index cannot live in memory
//! between calls. [`format`] defines the byte image and [`store`] publishes and
//! reads it atomically; whether using it is safe for a request is the caller's
//! decision (only an `InSync` source may answer from a snapshot).
//!
//! The image is deliberately self-contained: a header with the volume, root
//! identity, generation and CRCs; a name table of raw WTF-8 bytes; and a compact
//! record table. Folded names are **not** stored — they are rebuilt on load with
//! the current fold implementation (P1), and `SCHEMA_VERSION` is tied to that fold
//! behaviour so an older image is discarded instead of silently comparing
//! against a different fold.
//!
//! The store publishes [`store::SNAPSHOT_FILE`] (`index.snapshot`) in a
//! host-provided cache directory; the host must create that directory private
//! (0700 on POSIX) because a snapshot carries every file name under the root.
//!
//! [`cursor`] decides whether a saved cursor may be replayed (or forces a full
//! rescan) and delegates the USN truth table to [`crate::usn::cursor`]; [`lock`]
//! serialises writers with an advisory file lock; [`gc`] removes crash residue,
//! enforces the size cap and implements uninstall cleanup.

pub mod cursor;
pub mod format;
pub mod gc;
pub mod lock;
pub mod store;

pub use crate::usn::cursor::JournalInfo;
pub use cursor::{Cursor, Replay, RescanReason, Resync, validate_cursor};
pub use format::{
    FORMAT_VERSION, HEADER_LEN, MAGIC, NAME_ID_MAX, PARENT_NIL, RECORD_LEN, RecordFlags,
    SCHEMA_VERSION, Snapshot, SnapshotError, SnapshotRecord, crc32, decode, encode,
};
pub use gc::{GcError, GcReport, collect_locked, remove_all};
pub use lock::{LOCK_FILE, LockError, SnapshotLock};
pub use store::{MAX_SNAPSHOT_BYTES, SNAPSHOT_FILE, SnapshotStore, StoreError};
