use super::*;
use crate::ids::EntryId;

#[test]
fn storage_types_are_re_exported() {
    assert_eq!(ENTRY_BYTES, 57);
    assert_eq!(SIZE_UNKNOWN, u64::MAX);
    assert_eq!(MTIME_UNKNOWN, i64::MIN);
    assert!(!EntryFlags::EMPTY.contains(EntryFlags::DIR));

    let mut store = NameStore::new();
    assert_eq!(store.live_names(), 0);
    assert_eq!(store.slot_count(), 0);
    let id = store.intern(b"x");
    let span = store.folded_span(id);
    assert_eq!(span.range(), 0..1);
    assert!(span.in_folded());

    let table = EntryTable::new();
    assert!(table.is_empty());
    assert!(table.get(EntryId::NIL).is_none());

    let map = RecordMap::sparse();
    assert!(map.is_empty());
}
