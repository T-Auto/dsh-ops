use super::*;
use crate::ids::RecordId;
use crate::usn::record::{
    FILE_ATTRIBUTE_DIRECTORY, ParsedUsnRecord, USN_REASON_BASIC_INFO_CHANGE, USN_REASON_CLOSE,
    USN_REASON_DATA_EXTEND, USN_REASON_DATA_OVERWRITE, USN_REASON_DATA_TRUNCATION,
    USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE, USN_REASON_HARD_LINK_CHANGE,
    USN_REASON_RENAME_NEW_NAME, USN_REASON_RENAME_OLD_NAME,
};
use std::collections::BTreeMap;

const RECORD: RecordId = RecordId::new(0x1_0002_0003);
const PARENT: RecordId = RecordId::new(0x00AA);
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x20;

/// Reason bits a name/size/mtime index ignores: they never produce an op.
const IGNORED_REASON_BITS: [u32; 13] = [
    0x0000_0010, // NAMED_DATA_OVERWRITE
    0x0000_0020, // NAMED_DATA_EXTEND
    0x0000_0040, // NAMED_DATA_TRUNCATION
    0x0000_0400, // EA_CHANGE
    0x0000_0800, // SECURITY_CHANGE
    0x0000_4000, // INDEXABLE_CHANGE
    0x0002_0000, // COMPRESSION_CHANGE
    0x0004_0000, // ENCRYPTION_CHANGE
    0x0008_0000, // OBJECT_ID_CHANGE
    0x0010_0000, // REPARSE_POINT_CHANGE
    0x0020_0000, // STREAM_CHANGE
    0x0040_0000, // TRANSACTED_CHANGE
    0x0080_0000, // INTEGRITY_CHANGE
];

/// Bits that can drive a decision-table row, plus CLOSE (window boundary).
const DECISION_BITS: [u32; 10] = [
    USN_REASON_FILE_CREATE,
    USN_REASON_FILE_DELETE,
    USN_REASON_RENAME_OLD_NAME,
    USN_REASON_RENAME_NEW_NAME,
    USN_REASON_HARD_LINK_CHANGE,
    USN_REASON_BASIC_INFO_CHANGE,
    USN_REASON_DATA_OVERWRITE,
    USN_REASON_DATA_EXTEND,
    USN_REASON_DATA_TRUNCATION,
    USN_REASON_CLOSE,
];

const STAT_BITS: u32 = USN_REASON_FILE_CREATE
    | USN_REASON_DATA_OVERWRITE
    | USN_REASON_DATA_EXTEND
    | USN_REASON_DATA_TRUNCATION
    | USN_REASON_BASIC_INFO_CHANGE;

fn record(reason: u32) -> ParsedUsnRecord {
    record_with(reason, FILE_ATTRIBUTE_ARCHIVE, b"a.txt", false)
}

fn record_with(reason: u32, attributes: u32, name: &[u8], name_lossy: bool) -> ParsedUsnRecord {
    ParsedUsnRecord {
        major_version: 2,
        record: RECORD,
        parent: PARENT,
        usn: 0,
        timestamp_ft: 0,
        reason,
        attributes,
        name: name.to_vec(),
        name_lossy,
    }
}

fn upsert(is_dir: bool) -> UsnOp<'static> {
    UsnOp::Upsert {
        record: RECORD,
        parent: PARENT,
        name: b"a.txt",
        name_lossy: false,
        is_dir,
    }
}

/// Collects the list by value; also exercises the owned iterator.
fn collected(rec: &ParsedUsnRecord) -> Vec<UsnOp<'_>> {
    ops_for(rec).into_iter().collect()
}

/// Every combination of the ten decision bits, built from the bit list so a
/// new row cannot silently escape the sweeps below.
fn every_mask() -> impl Iterator<Item = u32> {
    (0u32..1 << DECISION_BITS.len()).map(|combo| {
        DECISION_BITS
            .iter()
            .enumerate()
            .filter(|&(index, _)| combo & (1u32 << index) != 0)
            .fold(0, |mask, (_, &bit)| mask | bit)
    })
}

/// Independent count of the rows the documented table matches for one mask.
fn expected_op_count(mask: u32) -> usize {
    if mask & USN_REASON_FILE_DELETE != 0 {
        return 1;
    }
    let mut count = 0;
    if mask & (USN_REASON_RENAME_NEW_NAME | USN_REASON_FILE_CREATE) != 0 {
        count += 1;
    }
    if mask & USN_REASON_RENAME_OLD_NAME != 0
        && mask & (USN_REASON_RENAME_NEW_NAME | USN_REASON_FILE_CREATE) == 0
    {
        count += 1;
    }
    if mask & USN_REASON_HARD_LINK_CHANGE != 0 {
        count += 1;
    }
    if mask & STAT_BITS != 0 {
        count += 1;
    }
    count
}

#[test]
fn create_emits_upsert_then_stat() {
    assert_eq!(
        collected(&record(USN_REASON_FILE_CREATE)),
        vec![upsert(false), UsnOp::StatDirty { record: RECORD }]
    );
}

/// The regression row 5 exists for: a file created and never written emits no
/// DATA_* bit ever, so this record is the only chance to learn its size.
#[test]
fn created_but_never_written_is_still_stat_dirty() {
    assert_eq!(
        collected(&record(USN_REASON_FILE_CREATE | USN_REASON_CLOSE)),
        vec![upsert(false), UsnOp::StatDirty { record: RECORD }]
    );
}

#[test]
fn rename_new_emits_upsert_only() {
    assert_eq!(
        collected(&record(USN_REASON_RENAME_NEW_NAME)),
        vec![upsert(false)]
    );
}

#[test]
fn upsert_carries_the_directory_flag_and_name() {
    let rec = record_with(
        USN_REASON_FILE_CREATE,
        FILE_ATTRIBUTE_DIRECTORY,
        b"docs",
        false,
    );
    assert_eq!(
        collected(&rec),
        vec![
            UsnOp::Upsert {
                record: RECORD,
                parent: PARENT,
                name: b"docs",
                name_lossy: false,
                is_dir: true,
            },
            UsnOp::StatDirty { record: RECORD },
        ]
    );
}

#[test]
fn upsert_borrows_the_record_name_instead_of_copying_it() {
    let rec = record_with(USN_REASON_FILE_CREATE, 0, b"borrowed.zip", true);
    let list = ops_for(&rec);
    match list[0] {
        UsnOp::Upsert {
            name, name_lossy, ..
        } => {
            assert!(std::ptr::eq(name, rec.name.as_slice()));
            assert!(name_lossy);
        }
        other => panic!("expected an upsert, got {other:?}"),
    }
}

#[test]
fn empty_name_is_upserted_unchanged() {
    let rec = record_with(USN_REASON_FILE_CREATE, 0, b"", false);
    assert_eq!(
        collected(&rec),
        vec![
            UsnOp::Upsert {
                record: RECORD,
                parent: PARENT,
                name: b"",
                name_lossy: false,
                is_dir: false,
            },
            UsnOp::StatDirty { record: RECORD },
        ]
    );
}

#[test]
fn rename_old_alone_is_telemetry_only() {
    assert_eq!(
        collected(&record(USN_REASON_RENAME_OLD_NAME)),
        vec![UsnOp::RenameOldSeen { record: RECORD }]
    );
}

#[test]
fn rename_old_and_new_in_one_record_emit_upsert_only() {
    assert_eq!(
        collected(&record(
            USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME
        )),
        vec![upsert(false)]
    );
}

#[test]
fn delete_wins_over_every_accumulated_bit() {
    let reason = USN_REASON_FILE_DELETE
        | USN_REASON_FILE_CREATE
        | USN_REASON_RENAME_OLD_NAME
        | USN_REASON_RENAME_NEW_NAME
        | USN_REASON_HARD_LINK_CHANGE
        | USN_REASON_DATA_EXTEND
        | USN_REASON_BASIC_INFO_CHANGE
        | USN_REASON_CLOSE;
    assert_eq!(
        collected(&record(reason)),
        vec![UsnOp::Delete { record: RECORD }]
    );
}

#[test]
fn a_mask_of_every_bit_set_is_only_a_delete() {
    assert_eq!(
        collected(&record(u32::MAX)),
        vec![UsnOp::Delete { record: RECORD }]
    );
}

#[test]
fn hard_link_change_never_upserts() {
    assert_eq!(
        collected(&record(USN_REASON_HARD_LINK_CHANGE | USN_REASON_CLOSE)),
        vec![UsnOp::LinkDirty { record: RECORD }]
    );
}

#[test]
fn each_data_and_basic_bit_emits_stat_dirty() {
    for reason in [
        USN_REASON_DATA_OVERWRITE,
        USN_REASON_DATA_EXTEND,
        USN_REASON_DATA_TRUNCATION,
        USN_REASON_BASIC_INFO_CHANGE,
    ] {
        assert_eq!(
            collected(&record(reason)),
            vec![UsnOp::StatDirty { record: RECORD }],
            "reason {reason:#010x}"
        );
    }
}

#[test]
fn close_alone_emits_nothing() {
    assert!(ops_for(&record(USN_REASON_CLOSE)).is_empty());
}

#[test]
fn no_bits_emit_nothing() {
    assert!(ops_for(&record(0)).is_empty());
}

#[test]
fn ignored_bits_alone_emit_nothing() {
    for bit in IGNORED_REASON_BITS {
        assert!(
            ops_for(&record(bit)).is_empty(),
            "ignored reason bit {bit:#010x} produced an op"
        );
    }
}

#[test]
fn ignored_bits_do_not_mask_matching_rows() {
    let reason = USN_REASON_FILE_CREATE | 0x0000_0800 | USN_REASON_CLOSE;
    assert_eq!(
        collected(&record(reason)),
        vec![upsert(false), UsnOp::StatDirty { record: RECORD }]
    );
}

#[test]
fn decision_rows_keep_table_order() {
    assert_eq!(
        collected(&record(
            USN_REASON_RENAME_OLD_NAME | USN_REASON_HARD_LINK_CHANGE | USN_REASON_BASIC_INFO_CHANGE
        )),
        vec![
            UsnOp::RenameOldSeen { record: RECORD },
            UsnOp::LinkDirty { record: RECORD },
            UsnOp::StatDirty { record: RECORD },
        ]
    );
    assert_eq!(
        collected(&record(
            USN_REASON_RENAME_NEW_NAME
                | USN_REASON_HARD_LINK_CHANGE
                | USN_REASON_BASIC_INFO_CHANGE
                | USN_REASON_CLOSE
        )),
        vec![
            upsert(false),
            UsnOp::LinkDirty { record: RECORD },
            UsnOp::StatDirty { record: RECORD },
        ]
    );
}

#[test]
fn op_list_is_copy_and_iterates_by_value() {
    let rec = record(
        USN_REASON_RENAME_NEW_NAME | USN_REASON_HARD_LINK_CHANGE | USN_REASON_BASIC_INFO_CHANGE,
    );
    let list = ops_for(&rec);
    assert_eq!(list.len(), MAX_OPS_PER_RECORD);
    assert_eq!(list[0], upsert(false));

    let by_value: Vec<UsnOp<'_>> = list.into_iter().collect();
    let by_ref: Vec<UsnOp<'_>> = list.iter().copied().collect();
    assert_eq!(by_value, by_ref);

    let copied = list;
    assert_eq!(copied.as_slice(), list.as_slice());
}

#[test]
fn op_list_debug_prints_only_live_ops() {
    assert_eq!(format!("{:?}", ops_for(&record(0))), "[]");

    let rec = record(
        USN_REASON_RENAME_NEW_NAME | USN_REASON_HARD_LINK_CHANGE | USN_REASON_BASIC_INFO_CHANGE,
    );
    let printed = format!("{:?}", ops_for(&rec));
    assert!(
        printed.starts_with('[') && printed.ends_with(']'),
        "unexpected Debug output: {printed}"
    );
    assert!(printed.contains("Upsert"), "{printed}");
    assert!(printed.contains("LinkDirty"), "{printed}");
    assert!(printed.contains("StatDirty"), "{printed}");
    assert!(
        !printed.contains("RenameOldSeen"),
        "the placeholder slot leaked into Debug: {printed}"
    );
}

#[test]
fn every_decision_mask_produces_the_table_row_count_in_order() {
    for mask in every_mask() {
        let rec = record(mask);
        let list = ops_for(&rec);
        assert_eq!(
            list.len(),
            expected_op_count(mask),
            "mask {mask:#010x} produced {list:?}"
        );
        assert!(list.len() <= MAX_OPS_PER_RECORD);
        let mut last_row = 0;
        for op in &list {
            let row = match op {
                UsnOp::Delete { .. } => 1,
                UsnOp::Upsert { .. } => 2,
                UsnOp::RenameOldSeen { .. } => 3,
                UsnOp::LinkDirty { .. } => 4,
                UsnOp::StatDirty { .. } => 5,
            };
            assert!(
                row > last_row,
                "mask {mask:#010x} produced rows out of table order: {list:?}"
            );
            last_row = row;
        }
    }
}

#[test]
fn reason_mask_covers_every_bit_that_drives_an_op() {
    for position in 0..32 {
        let bit = 1u32 << position;
        let rec = record(bit);
        let list = ops_for(&rec);
        if !list.is_empty() {
            assert_ne!(
                REASON_MASK & bit,
                0,
                "reason bit {bit:#010x} yields {list:?}, but REASON_MASK omits it; the update would vanish silently"
            );
        }
    }
}

#[test]
fn close_is_requested_even_though_it_drives_no_op_alone() {
    assert!(ops_for(&record(USN_REASON_CLOSE)).is_empty());
    assert_ne!(REASON_MASK & USN_REASON_CLOSE, 0);
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct MockIndex {
    entries: BTreeMap<u64, Entry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    parent: u64,
    name: Vec<u8>,
    is_dir: bool,
}

fn apply(index: &mut MockIndex, ops: OpList<'_>) {
    for op in ops {
        match op {
            UsnOp::Upsert {
                record,
                parent,
                name,
                is_dir,
                ..
            } => {
                index.entries.insert(
                    record.get(),
                    Entry {
                        parent: parent.get(),
                        name: name.to_vec(),
                        is_dir,
                    },
                );
            }
            UsnOp::Delete { record } => {
                index.entries.remove(&record.get());
            }
            UsnOp::LinkDirty { .. } | UsnOp::StatDirty { .. } | UsnOp::RenameOldSeen { .. } => {}
        }
    }
}

#[test]
fn applying_the_same_record_twice_equals_applying_it_once() {
    for mask in every_mask() {
        let rec = record(mask);
        let mut once = MockIndex::default();
        apply(&mut once, ops_for(&rec));

        let mut twice = MockIndex::default();
        apply(&mut twice, ops_for(&rec));
        let after_first = twice.clone();
        apply(&mut twice, ops_for(&rec));

        assert_eq!(
            twice, after_first,
            "re-applying mask {mask:#010x} changed state"
        );
        assert_eq!(twice, once, "mask {mask:#010x}");
    }
}

#[test]
fn a_later_accumulated_record_converges_to_the_same_state() {
    for mask in every_mask() {
        for bit in DECISION_BITS {
            let earlier = record(mask);
            let later = record(mask | bit);

            let mut cumulative = MockIndex::default();
            apply(&mut cumulative, ops_for(&earlier));
            apply(&mut cumulative, ops_for(&later));

            let mut only_later = MockIndex::default();
            apply(&mut only_later, ops_for(&later));

            assert_eq!(
                cumulative,
                only_later,
                "mask {mask:#010x} then {:#010x} did not converge",
                mask | bit
            );
        }
    }
}
