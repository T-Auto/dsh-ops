use super::*;
use crate::ids::{EntryId, NameId, RecordId};

fn alloc(table: &mut EntryTable, record: u64, name: NameId) -> EntryId {
    table.alloc(RecordId::new(record), EntryId::NIL, name, EntryFlags::EMPTY)
}

#[test]
fn flags_are_one_byte_and_compose() {
    assert_eq!(size_of::<EntryFlags>(), 1);
    assert_eq!(EntryFlags::EMPTY.bits(), 0);
    assert!(EntryFlags::DIR.contains(EntryFlags::DIR));
    assert!(!EntryFlags::EMPTY.contains(EntryFlags::DIR));

    let flags = EntryFlags::EMPTY
        .with(EntryFlags::DIR, true)
        .with(EntryFlags::NON_UNICODE_NAME, true);
    assert!(flags.contains(EntryFlags::DIR));
    assert!(flags.contains(EntryFlags::NON_UNICODE_NAME));
    assert!(!flags.contains(EntryFlags::PLACEHOLDER));
    assert!(!flags.with(EntryFlags::DIR, false).contains(EntryFlags::DIR));
    assert_eq!(EntryFlags::from_bits(0xff).bits(), 0xff);
    assert_eq!(format!("{:?}", EntryFlags::DIR), "EntryFlags(0x01)");
}

#[test]
fn table_costs_57_bytes_per_slot() {
    assert_eq!(ENTRY_BYTES, 57);
    let columns = size_of::<RecordId>()
        + size_of::<EntryId>()
        + size_of::<NameId>()
        + size_of::<EntryFlags>()
        + size_of::<u64>()
        + size_of::<i64>()
        + 6 * size_of::<u32>();
    assert_eq!(columns, ENTRY_BYTES);
}

#[test]
fn alloc_writes_every_field() {
    let mut table = EntryTable::new();
    let record = RecordId::from_parts(7, 3);
    let entry = table.alloc(record, EntryId::new(0), NameId::new(4), EntryFlags::DIR);

    assert_eq!(entry, EntryId::new(0));
    assert_eq!(table.len(), 1);
    assert_eq!(table.allocated(), 1);
    assert_eq!(table.free_slots(), 0);
    assert_eq!(table.record(entry), record);
    assert_eq!(table.parent(entry), EntryId::new(0));
    assert_eq!(table.name_id(entry), NameId::new(4));
    assert!(table.flags(entry).contains(EntryFlags::DIR));
    assert_eq!(table.size(entry), None);
    assert_eq!(table.mtime(entry), None);
    assert_eq!(table.next_link(entry), EntryId::NIL);
    assert!(table.is_live(entry));
    assert!(!table.is_tombstone(entry));
}

#[test]
fn tombstone_clears_links_and_frees_the_slot() {
    let mut table = EntryTable::new();
    let entry = alloc(&mut table, 1, NameId::new(1));
    table.set_next_link(entry, EntryId::new(9));
    table.set_same_links(entry, EntryId::new(8), EntryId::new(7));
    table.set_next_child(entry, EntryId::new(6));
    table.set_prev_child(entry, EntryId::new(5));

    table.tombstone(entry);

    assert!(table.is_tombstone(entry));
    assert!(!table.is_live(entry));
    assert_eq!(table.len(), 0);
    assert_eq!(table.free_slots(), 1);
    assert_eq!(table.next_link(entry), EntryId::NIL);
    assert_eq!(table.next_same(entry), EntryId::NIL);
    assert_eq!(table.prev_same(entry), EntryId::NIL);
    assert_eq!(table.next_child(entry), EntryId::NIL);
    assert_eq!(table.prev_child(entry), EntryId::NIL);
}

#[test]
#[should_panic(expected = "already tombstoned")]
fn tombstoning_twice_panics() {
    let mut table = EntryTable::new();
    let entry = alloc(&mut table, 1, NameId::new(1));
    table.tombstone(entry);
    table.tombstone(entry);
}

#[test]
#[should_panic(expected = "children")]
fn a_directory_with_children_cannot_be_tombstoned() {
    let mut table = EntryTable::new();
    let entry = alloc(&mut table, 1, NameId::new(1));
    table.set_first_child(entry, EntryId::new(4));
    table.tombstone(entry);
}

#[test]
fn free_slots_are_reused_last_in_first_out() {
    let mut table = EntryTable::new();
    let first = alloc(&mut table, 1, NameId::new(1));
    let second = alloc(&mut table, 2, NameId::new(2));
    let third = alloc(&mut table, 3, NameId::new(3));
    table.set_next_link(first, EntryId::new(9));
    table.set_same_links(first, EntryId::new(8), EntryId::new(7));
    table.set_next_child(first, EntryId::new(6));
    table.set_prev_child(first, EntryId::new(5));
    table.set_next_link(third, EntryId::new(4));

    table.tombstone(first);
    table.tombstone(third);
    assert_eq!(table.free_slots(), 2);
    assert_eq!(table.allocated(), 3);

    assert_eq!(alloc(&mut table, 4, NameId::new(4)), third);
    assert_eq!(alloc(&mut table, 5, NameId::new(5)), first);
    assert_eq!(table.allocated(), 3);
    assert_eq!(table.len(), 3);
    assert_eq!(table.free_slots(), 0);
    assert_eq!(table.record(second), RecordId::new(2));
    for reused in [first, third] {
        assert_eq!(table.next_link(reused), EntryId::NIL);
        assert_eq!(table.next_same(reused), EntryId::NIL);
        assert_eq!(table.prev_same(reused), EntryId::NIL);
        assert_eq!(table.next_child(reused), EntryId::NIL);
        assert_eq!(table.prev_child(reused), EntryId::NIL);
    }

    let fresh = alloc(&mut table, 6, NameId::new(6));
    assert_eq!(fresh, EntryId::new(3));
    assert_eq!(table.allocated(), 4);
}

#[test]
#[should_panic(expected = "tombstoned")]
fn alloc_rejects_the_tombstone_flag() {
    let mut table = EntryTable::new();
    table.alloc(
        RecordId::new(1),
        EntryId::NIL,
        NameId::new(0),
        EntryFlags::TOMBSTONE,
    );
}

#[test]
fn size_and_mtime_use_sentinels() {
    let mut table = EntryTable::new();
    let entry = alloc(&mut table, 1, NameId::new(1));
    assert_eq!(table.size(entry), None);
    assert_eq!(table.mtime(entry), None);
    assert_eq!(SIZE_UNKNOWN, u64::MAX);
    assert_eq!(MTIME_UNKNOWN, i64::MIN);

    table.set_size(entry, Some(4096));
    table.set_mtime(entry, Some(-5));
    assert_eq!(table.size(entry), Some(4096));
    assert_eq!(table.mtime(entry), Some(-5));

    table.set_size(entry, None);
    table.set_mtime(entry, None);
    assert_eq!(table.size(entry), None);
    assert_eq!(table.mtime(entry), None);
}

#[test]
fn same_name_and_child_links_round_trip() {
    let mut table = EntryTable::new();
    let entry = alloc(&mut table, 1, NameId::new(1));

    table.set_same_links(entry, EntryId::new(2), EntryId::new(3));
    assert_eq!(table.next_same(entry), EntryId::new(2));
    assert_eq!(table.prev_same(entry), EntryId::new(3));
    table.set_next_same(entry, EntryId::new(4));
    table.set_prev_same(entry, EntryId::new(5));
    assert_eq!(table.next_same(entry), EntryId::new(4));
    assert_eq!(table.prev_same(entry), EntryId::new(5));

    table.set_first_child(entry, EntryId::new(6));
    table.set_next_child(entry, EntryId::new(7));
    table.set_prev_child(entry, EntryId::new(8));
    assert_eq!(table.first_child(entry), EntryId::new(6));
    assert_eq!(table.next_child(entry), EntryId::new(7));
    assert_eq!(table.prev_child(entry), EntryId::new(8));
}

#[test]
fn live_entries_skips_tombstones_in_slot_order() {
    let mut table = EntryTable::new();
    let first = alloc(&mut table, 1, NameId::new(1));
    let second = alloc(&mut table, 2, NameId::new(2));
    let third = alloc(&mut table, 3, NameId::new(3));
    table.tombstone(second);

    let live: Vec<EntryId> = table.live_entries().collect();
    assert_eq!(live, vec![first, third]);
}

#[test]
fn entry_view_reports_scalar_columns() {
    let mut table = EntryTable::new();
    let record = RecordId::from_parts(7, 3);
    let entry = table.alloc(record, EntryId::new(0), NameId::new(4), EntryFlags::DIR);
    table.set_size(entry, Some(4096));
    table.set_mtime(entry, Some(-5));

    let view = table.get(entry).expect("a live entry has a view");
    assert_eq!(view.record(), record);
    assert_eq!(view.parent(), EntryId::new(0));
    assert_eq!(view.name_id(), NameId::new(4));
    assert_eq!(view.size(), Some(4096));
    assert_eq!(view.mtime(), Some(-5));
    assert!(view.is_dir());
    assert!(!view.is_synthetic());
    assert!(view.is_presentable());
}

#[test]
fn entry_view_rejects_dead_and_out_of_range_slots() {
    let mut table = EntryTable::new();
    let entry = alloc(&mut table, 1, NameId::new(1));
    assert!(table.get(EntryId::new(99)).is_none());
    table.tombstone(entry);
    assert!(table.get(entry).is_none());
}

#[test]
fn presentability_excludes_synthetic_and_detached_entries() {
    let mut table = EntryTable::new();
    let placeholder = table.alloc(
        RecordId::new(1),
        EntryId::NIL,
        NameId::new(1),
        EntryFlags::PLACEHOLDER,
    );
    let lost_found = table.alloc(
        RecordId::new(2),
        EntryId::NIL,
        NameId::new(2),
        EntryFlags::DIR.with(EntryFlags::LOST_FOUND, true),
    );
    let detached = table.alloc(
        RecordId::new(3),
        EntryId::NIL,
        NameId::new(3),
        EntryFlags::EMPTY.with(EntryFlags::CHAIN_DETACHED, true),
    );

    let placeholder = table.get(placeholder).expect("live placeholder");
    assert!(placeholder.is_synthetic());
    assert!(!placeholder.is_presentable());

    let lost_found = table.get(lost_found).expect("live lost-and-found");
    assert!(lost_found.is_synthetic());
    assert!(!lost_found.is_presentable());

    let detached = table.get(detached).expect("live detached entry");
    assert!(!detached.is_synthetic());
    assert!(!detached.is_presentable());
}
