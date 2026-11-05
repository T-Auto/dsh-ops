use super::*;

#[test]
fn identifier_widths_are_part_of_the_contract() {
    assert_eq!(size_of::<EntryId>(), 4);
    assert_eq!(size_of::<NameId>(), 4);
    assert_eq!(size_of::<RecordId>(), 8);
    assert_eq!(size_of::<VolumeId>(), 8);
    assert_eq!(size_of::<SnapshotId>(), 8);
    assert_eq!(size_of::<FileKey>(), 16);
}

#[test]
fn entry_id_nil_is_the_chain_terminator() {
    assert!(EntryId::NIL.is_nil());
    assert_eq!(EntryId::NIL.get(), u32::MAX);
    assert_eq!(EntryId::NIL.index(), u32::MAX as usize);
    let live = EntryId::new(7);
    assert!(!live.is_nil());
    assert_eq!(live.index(), 7);
    assert_eq!(format!("{live:?}"), "EntryId(7)");
    assert_eq!(format!("{:?}", EntryId::NIL), "EntryId(NIL)");
}

#[test]
fn name_id_round_trips_its_raw_index() {
    let id = NameId::new(42);
    assert_eq!(id.get(), 42);
    assert_eq!(id.index(), 42);
}

#[test]
fn record_id_splits_number_and_generation() {
    let id = RecordId::new(0xABCD_0000_0001_0002);
    assert_eq!(id.record_number(), 0x0000_0001_0002);
    assert_eq!(id.sequence(), 0xABCD);
    assert_eq!(RecordId::from_parts(0x1_0002, 0xABCD), id);
    assert_eq!(format!("{id:?}"), "RecordId(record=65538, sequence=43981)");
}

#[test]
fn record_id_masks_numbers_that_do_not_fit_48_bits() {
    let id = RecordId::from_parts(u64::MAX, 0x1234);
    assert_eq!(id.record_number(), 0x0000_FFFF_FFFF_FFFF);
    assert_eq!(id.sequence(), 0x1234);
    assert_eq!(id.get(), 0x1234_FFFF_FFFF_FFFF);
}

#[test]
fn file_key_keeps_both_64_bit_halves() {
    let key = FileKey::new(0x0102_0304_0506_0708, 0xFEDC_BA98_7654_3210);
    assert_eq!(key.volume, 0x0102_0304_0506_0708);
    assert_eq!(key.file, 0xFEDC_BA98_7654_3210);
    assert_eq!(
        format!("{key:?}"),
        "FileKey(0x102030405060708:0xfedcba9876543210)"
    );
}

#[test]
fn ordering_is_by_raw_value_not_by_generation_first() {
    let low_sequence = RecordId::from_parts(1, 0);
    let high_sequence = RecordId::from_parts(2, 1);
    assert!(low_sequence < high_sequence);
    assert!(SnapshotId::new(1) < SnapshotId::new(2));
    assert!(EntryId::new(1) < EntryId::new(2));
    assert!(FileKey::new(1, 9) < FileKey::new(2, 0));
}
