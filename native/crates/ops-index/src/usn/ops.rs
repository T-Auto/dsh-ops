// Design informed by mustafaahci/goz (MIT).
//! Reason-bit normalization: accumulated USN masks into idempotent index ops.
//!
//! A record's `reason` is not one event. The kernel accumulates every reason
//! since the handle was opened, so a record carries the bitwise OR of all of
//! them, and later records repeat that growing mask until `CLOSE`. [`ops_for`]
//! collapses such a mask into the smallest set of operations an index needs;
//! applying one record twice, or applying a later record whose mask is a
//! superset of an earlier one, therefore converges to the same state.
//!
//! Three invariants bind every consumer:
//!
//! 1. Apply in journal order (ascending `usn`). The table has no OLD/NEW
//!    pairing state machine, so out-of-order application can interleave a
//!    create and a delete incorrectly.
//! 2. Apply idempotently. `Upsert` overwrites, `Delete` removes if present, and
//!    the dirty signals may repeat; nothing here deduplicates.
//! 3. Never skip a record. The parser rejects a malformed page with its offset
//!    and the caller rescans; dropping one record loses an update forever.
//!
//! Every bit test is a bitwise `&`, never equality: an accumulated mask can
//! carry any combination of unrelated bits.
//!
//! `FILE_DELETE` means the file record died (the last hard link was removed).
//! Removing one of several hard links arrives as `HARD_LINK_CHANGE`, which must
//! never be applied as an upsert: the record may name a link that is already
//! dead, so the link set has to be recomputed outside this module.
//!
//! `RENAME_OLD_NAME` alone is telemetry. Only the NEW record carries committed
//! state, and it is self-sufficient: the record's name and parent are the
//! file's current location, so no OLD/NEW state machine exists by design.
//!
//! A record has no size and no timestamps (`timestamp_ft` is when the record
//! was written, not the file mtime), so anything that may have changed them
//! emits `StatDirty` for the caller to re-stat.

use super::record::{
    ParsedUsnRecord, USN_REASON_BASIC_INFO_CHANGE, USN_REASON_CLOSE, USN_REASON_DATA_EXTEND,
    USN_REASON_DATA_OVERWRITE, USN_REASON_DATA_TRUNCATION, USN_REASON_FILE_CREATE,
    USN_REASON_FILE_DELETE, USN_REASON_HARD_LINK_CHANGE, USN_REASON_RENAME_NEW_NAME,
    USN_REASON_RENAME_OLD_NAME,
};
use crate::ids::RecordId;
use std::array::IntoIter;
use std::iter::Take;
use std::ops::Deref;

/// Maximum number of operations one record can produce.
///
/// The decision table below has three cumulative rows after the delete
/// short-circuit, so this bound is structural, not a tunable.
pub const MAX_OPS_PER_RECORD: usize = 3;

/// Reason bits a journal read must request so that no update is lost.
///
/// This is the mask for `FSCTL_READ_USN_JOURNAL`: everything that changes a
/// name, a hard link, or a file's size or timestamps. It is a superset of the
/// bits [`ops_for`] reacts to, because `CLOSE` drifts no key on its own but the
/// caller needs the window boundary. The converse must never be true: a bit
/// that can produce an op but is absent here would make the kernel stop
/// reporting that class of update, and the index would silently stop tracking
/// it. `ops_tests.rs` sweeps all 32 bit positions to pin that direction.
pub const REASON_MASK: u32 = USN_REASON_FILE_CREATE
    | USN_REASON_FILE_DELETE
    | USN_REASON_RENAME_OLD_NAME
    | USN_REASON_RENAME_NEW_NAME
    | USN_REASON_HARD_LINK_CHANGE
    | USN_REASON_BASIC_INFO_CHANGE
    | USN_REASON_DATA_OVERWRITE
    | USN_REASON_DATA_EXTEND
    | USN_REASON_DATA_TRUNCATION
    | USN_REASON_CLOSE;

/// One normalized operation an index applies to converge to journal state.
///
/// `Upsert` borrows the name from the parsed record: a consumer that interns or
/// copies the name would copy it anyway, so normalization itself never
/// allocates. Every field is `Copy`, so the whole operation is cheap to pass
/// around and the list below iterates by value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsnOp<'a> {
    /// Create or update the entry for `record`.
    ///
    /// The record's name and parent are the file's current state; this is
    /// emitted for `FILE_CREATE` and for `RENAME_NEW_NAME`, which is
    /// authoritative and self-sufficient.
    Upsert {
        /// File record the entry belongs to.
        record: RecordId,
        /// Record of the directory that now contains the name.
        parent: RecordId,
        /// Current name in WTF-8, borrowed from the parsed record.
        name: &'a [u8],
        /// The name contained unpaired UTF-16 surrogates.
        name_lossy: bool,
        /// The entry is a directory.
        is_dir: bool,
    },
    /// The file record died: remove every entry for `record`.
    Delete {
        /// Dead file record.
        record: RecordId,
    },
    /// The set of hard links changed.
    ///
    /// Never an upsert: the record may name a link that is already dead, so
    /// the caller recomputes the file's link set externally and applies that.
    LinkDirty {
        /// File record whose links must be reconciled.
        record: RecordId,
    },
    /// Size and/or timestamps may have changed.
    ///
    /// A USN record carries neither, so the caller must re-stat the file.
    StatDirty {
        /// File record that needs a stat.
        record: RecordId,
    },
    /// A `RENAME_OLD_NAME` record without a NEW/CREATE/DELETE in the same mask.
    ///
    /// Telemetry only; the index ignores it, because the NEW record alone
    /// carries the committed state.
    RenameOldSeen {
        /// File record that was renamed.
        record: RecordId,
    },
}

/// The operations one record produces, in decision-table order.
///
/// At most [`MAX_OPS_PER_RECORD`], so the list lives inline and normalization
/// does not allocate. It dereferences to a slice and iterates by value.
#[derive(Clone, Copy, Debug)]
pub struct OpList<'a> {
    items: [UsnOp<'a>; MAX_OPS_PER_RECORD],
    len: usize,
}

impl<'a> OpList<'a> {
    /// An empty list. The unused slots keep a never-observed placeholder; only
    /// `items[..len]` is ever exposed.
    fn empty(record: RecordId) -> Self {
        Self {
            items: [UsnOp::RenameOldSeen { record }; MAX_OPS_PER_RECORD],
            len: 0,
        }
    }

    fn push(&mut self, op: UsnOp<'a>) {
        debug_assert!(
            self.len < MAX_OPS_PER_RECORD,
            "decision table produced more than {MAX_OPS_PER_RECORD} ops"
        );
        self.items[self.len] = op;
        self.len += 1;
    }

    /// Operations in decision-table order.
    pub fn as_slice(&self) -> &[UsnOp<'a>] {
        &self.items[..self.len]
    }
}

impl<'a> Deref for OpList<'a> {
    type Target = [UsnOp<'a>];

    fn deref(&self) -> &Self::Target {
        self.as_slice()
    }
}

impl<'a> IntoIterator for OpList<'a> {
    type Item = UsnOp<'a>;
    type IntoIter = Take<IntoIter<UsnOp<'a>, MAX_OPS_PER_RECORD>>;

    fn into_iter(self) -> Self::IntoIter {
        self.items.into_iter().take(self.len)
    }
}

impl<'a, 'b> IntoIterator for &'b OpList<'a> {
    type Item = &'b UsnOp<'a>;
    type IntoIter = std::slice::Iter<'b, UsnOp<'a>>;

    fn into_iter(self) -> Self::IntoIter {
        self.as_slice().iter()
    }
}

/// Normalizes one record's accumulated reason mask into index operations.
///
/// Rows are evaluated top to bottom; row 1 returns immediately and rows 2-5
/// each test their own bits and append at most one op, so the output is in
/// table order and never longer than [`MAX_OPS_PER_RECORD`]:
///
/// | # | Bitwise `&` test | Operation |
/// | --- | --- | --- |
/// | 1 | `FILE_DELETE` | [`UsnOp::Delete`] and nothing else: delete wins over all accumulated bits |
/// | 2 | `RENAME_NEW_NAME` or `FILE_CREATE` | [`UsnOp::Upsert`] (the record's name/parent are the current state) |
/// | 3 | `RENAME_OLD_NAME` and none of NEW/CREATE/DELETE | [`UsnOp::RenameOldSeen`] (telemetry) |
/// | 4 | `HARD_LINK_CHANGE` | [`UsnOp::LinkDirty`] (never an upsert) |
/// | 5 | `FILE_CREATE`, `DATA_OVERWRITE`, `DATA_EXTEND`, `DATA_TRUNCATION`, or `BASIC_INFO_CHANGE` | [`UsnOp::StatDirty`] |
/// | 6 | none of the above (e.g. CLOSE-only or security-only) | empty |
///
/// `FILE_CREATE` appears in rows 2 and 5 on purpose: a USN record carries no
/// size or mtime, and a file created and never written emits no `DATA_*` bit
/// ever, so without row 5 its size would stay unknown for the life of the
/// index.
///
/// Bits that are deliberately ignored (they drive no op): the
/// `NAMED_DATA_*` bits, `EA_CHANGE`, `SECURITY_CHANGE`, `INDEXABLE_CHANGE`,
/// `COMPRESSION_CHANGE`, `ENCRYPTION_CHANGE`, `OBJECT_ID_CHANGE`,
/// `REPARSE_POINT_CHANGE`, `STREAM_CHANGE`, `TRANSACTED_CHANGE` and
/// `INTEGRITY_CHANGE`. A name/size/mtime index does not care about alternate
/// data streams, ACLs, attributes or reparse points, and unrelated bits never
/// turn a matching row off because every test is a bitwise `&`.
///
/// A record may legally carry an empty name (the parser accepts
/// `FileNameLength == 0`); it is upserted unchanged. Whether an empty name can
/// be represented as a path component is the index layer's decision, not this
/// normalization's.
pub fn ops_for(record: &ParsedUsnRecord) -> OpList<'_> {
    let mut ops = OpList::empty(record.record);
    let reason = record.reason;

    // Row 1: death of the file record overrides every accumulated bit. It is
    // the last hard link that disappeared; removing one of several links
    // reports HARD_LINK_CHANGE instead.
    if reason & USN_REASON_FILE_DELETE != 0 {
        ops.push(UsnOp::Delete {
            record: record.record,
        });
        return ops;
    }

    // Row 2: the record's name and parent are the file's current state.
    if reason & (USN_REASON_RENAME_NEW_NAME | USN_REASON_FILE_CREATE) != 0 {
        ops.push(UsnOp::Upsert {
            record: record.record,
            parent: record.parent,
            name: &record.name,
            name_lossy: record.name_lossy,
            is_dir: record.is_dir(),
        });
    }

    // Row 3: OLD without NEW/CREATE/DELETE in the same record. The DELETE test
    // is unreachable after row 1; it stays to keep the documented condition
    // literally true if the short-circuit ever moves.
    if reason & USN_REASON_RENAME_OLD_NAME != 0
        && reason & (USN_REASON_RENAME_NEW_NAME | USN_REASON_FILE_CREATE | USN_REASON_FILE_DELETE)
            == 0
    {
        ops.push(UsnOp::RenameOldSeen {
            record: record.record,
        });
    }

    // Row 4.
    if reason & USN_REASON_HARD_LINK_CHANGE != 0 {
        ops.push(UsnOp::LinkDirty {
            record: record.record,
        });
    }

    // Row 5.
    if reason
        & (USN_REASON_FILE_CREATE
            | USN_REASON_DATA_OVERWRITE
            | USN_REASON_DATA_EXTEND
            | USN_REASON_DATA_TRUNCATION
            | USN_REASON_BASIC_INFO_CHANGE)
        != 0
    {
        ops.push(UsnOp::StatDirty {
            record: record.record,
        });
    }

    ops
}

#[cfg(test)]
#[path = "ops_tests.rs"]
mod ops_tests;
