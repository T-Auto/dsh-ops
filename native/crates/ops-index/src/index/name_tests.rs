use super::*;
use crate::ids::{EntryId, NameId, RecordId};
use crate::index::entry::{EntryFlags, EntryTable, NO_NAME};

fn entry(table: &mut EntryTable, name: NameId, record: u64) -> EntryId {
    table.alloc(
        RecordId::new(record),
        EntryId::NIL,
        name,
        EntryFlags::EMPTY,
    )
}

#[test]
fn name_reference_widths_are_part_of_the_contract() {
    assert_eq!(size_of::<NameRef>(), 8);
    assert_eq!(size_of::<NamePair>(), 16);

    let raw = NameRef::new(3, 5);
    assert_eq!(raw.offset(), 3);
    assert_eq!(raw.len(), 5);
    assert!(!raw.in_folded());

    let shared = NameRef::shared(9, 4);
    assert_eq!(shared.offset(), 9);
    assert_eq!(shared.len(), 4);
    assert!(shared.in_folded());

    let pair = NamePair {
        raw: shared,
        folded: raw,
    };
    assert_eq!(pair.raw(), shared);
    assert_eq!(pair.folded(), raw);
}

#[test]
fn intern_dedups_raw_bytes_and_counts_refs() {
    let mut store = NameStore::new();
    let first = store.intern(b"alpha");
    let second = store.intern(b"alpha");

    assert_eq!(first, second);
    assert_eq!(first, NameId::new(0));
    assert_eq!(store.slot_count(), 1);
    assert_eq!(store.live_names(), 1);
    assert_eq!(store.refcount(first), 2);
    assert!(store.is_live(first));
    assert_eq!(store.raw_bytes(first), b"alpha");
    assert_eq!(store.folded_bytes(first), b"alpha");
}

#[test]
fn differently_cased_names_get_distinct_ids_with_one_folded_key() {
    let mut store = NameStore::new();
    let upper = store.intern(b"README");
    let lower = store.intern(b"readme");

    assert_ne!(upper, lower);
    assert_eq!(store.slot_count(), 2);
    assert_eq!(store.live_names(), 2);
    assert_eq!(store.raw_bytes(upper), b"README");
    assert_eq!(store.raw_bytes(lower), b"readme");
    assert_eq!(store.folded_bytes(upper), b"readme");
    assert_eq!(store.folded_bytes(lower), b"readme");
}

#[test]
fn identical_raw_and_folded_bytes_are_stored_once() {
    let mut store = NameStore::new();
    let id = store.intern(b"plain");

    assert!(store.pair(id).raw().in_folded());
    assert!(store.pair(id).folded().in_folded());
    assert!(store.raw_arena().is_empty());
    assert_eq!(store.folded(), b"plain\0");

    let id = store.intern(b"MixedCase");
    assert!(!store.pair(id).raw().in_folded());
    assert_eq!(store.raw_arena(), b"MixedCase\0");
}

#[test]
fn arenas_are_nul_separated_and_hold_only_unique_names() {
    let mut store = NameStore::new();
    store.intern(b"Alpha");
    store.intern(b"beta");
    store.intern(b"Alpha");

    assert_eq!(store.slot_count(), 2);
    assert_eq!(store.folded(), b"alpha\0beta\0");
    assert_eq!(store.raw_arena(), b"Alpha\0");
}

#[test]
fn releasing_one_reference_keeps_the_name_alive() {
    let mut store = NameStore::new();
    let id = store.intern(b"kept");
    store.intern(b"kept");

    assert!(!store.release(id));
    assert_eq!(store.refcount(id), 1);
    assert!(store.is_live(id));
    assert_eq!(store.folded(), b"kept\0");

    assert!(store.release(id));
    assert_eq!(store.refcount(id), 0);
    assert!(!store.is_live(id));
    assert_eq!(store.live_names(), 0);
}

#[test]
fn release_zeroes_the_name_and_hides_it_from_the_folded_haystack() {
    let mut store = NameStore::new();
    let id = store.intern(b"secret");
    assert!(store.release(id));

    assert_eq!(store.garbage_bytes(), 7);
    assert_eq!(store.folded(), &[0; 7]);
    assert!(!store.folded().windows(6).any(|window| window == b"secret"));
    assert_eq!(store.slot_count(), 1);
}

#[test]
fn intern_after_release_returns_a_new_id() {
    let mut store = NameStore::new();
    let dead = store.intern(b"recycled");
    assert!(store.release(dead));

    let live = store.intern(b"recycled");
    assert_ne!(live, dead);
    assert_eq!(live, NameId::new(1));
    assert_eq!(store.live_names(), 1);
    assert_eq!(store.raw_bytes(live), b"recycled");
}

#[test]
fn same_name_chain_links_front_and_unlinks_exactly() {
    let mut store = NameStore::new();
    let mut table = EntryTable::new();
    let name = store.intern(b"x");
    let first = entry(&mut table, name, 1);
    let second = entry(&mut table, name, 2);
    let third = entry(&mut table, name, 3);

    store.link_same(name, first, &mut table);
    store.link_same(name, second, &mut table);
    store.link_same(name, third, &mut table);

    assert_eq!(store.same_head(name), third);
    assert_eq!(table.next_same(third), second);
    assert_eq!(table.prev_same(second), third);
    assert_eq!(table.next_same(second), first);
    assert_eq!(table.prev_same(first), second);
    assert_eq!(table.next_same(first), EntryId::NIL);
    assert_eq!(table.prev_same(third), EntryId::NIL);

    store.unlink_same(name, second, &mut table);
    assert_eq!(store.same_head(name), third);
    assert_eq!(table.next_same(third), first);
    assert_eq!(table.prev_same(first), third);
    assert_eq!(table.next_same(second), EntryId::NIL);
    assert_eq!(table.prev_same(second), EntryId::NIL);

    store.unlink_same(name, third, &mut table);
    assert_eq!(store.same_head(name), first);
    assert_eq!(table.next_same(first), EntryId::NIL);

    store.unlink_same(name, first, &mut table);
    assert_eq!(store.same_head(name), EntryId::NIL);
    assert!(store.release(name));
}

#[test]
#[should_panic(expected = "same-name chain")]
fn releasing_a_name_with_a_live_chain_panics() {
    let mut store = NameStore::new();
    let mut table = EntryTable::new();
    let name = store.intern(b"still-linked");
    let linked = entry(&mut table, name, 1);
    store.link_same(name, linked, &mut table);

    store.release(name);
}

#[test]
#[should_panic(expected = "not live")]
fn releasing_a_dead_name_panics() {
    let mut store = NameStore::new();
    let name = store.intern(b"once");
    assert!(store.release(name));

    store.release(name);
}

#[test]
fn should_compact_needs_enough_garbage() {
    let mut store = NameStore::new();
    assert!(!store.should_compact());

    let kept = store.intern(b"kept");
    for index in 0..300u32 {
        let name = format!("dead-{index:05}-padding-padding-padding-padding");
        let dead = store.intern(name.as_bytes());
        assert!(store.release(dead));
    }
    assert!(store.garbage_bytes() > COMPACT_MIN_BYTES as u64);
    assert!(store.should_compact());

    let plan = store.plan_compact();
    store.install_compacted(plan, &mut EntryTable::new());
    assert_eq!(store.garbage_bytes(), 0);
    assert!(!store.should_compact());
    assert_eq!(store.live_names(), 1);
    assert!(store.is_live(kept));
}

#[test]
fn compaction_drops_dead_names_and_renumbers_live_ones() {
    let mut store = NameStore::new();
    let alpha = store.intern(b"alpha");
    let dead = store.intern(b"dead");
    let gamma = store.intern(b"gamma");
    assert!(store.release(dead));

    let plan = store.plan_compact();
    assert_eq!(plan.compacted_names(), 2);
    assert_eq!(plan.remap(alpha), Some(NameId::new(0)));
    assert_eq!(plan.remap(dead), None);
    assert_eq!(plan.remap(gamma), Some(NameId::new(1)));
    assert_eq!(plan.folded_arena(), b"alpha\0gamma\0");
    assert!(plan.raw_arena().is_empty());

    store.install_compacted(plan, &mut EntryTable::new());
    assert_eq!(store.slot_count(), 2);
    assert_eq!(store.live_names(), 2);
    assert_eq!(store.intern(b"alpha"), NameId::new(0));
    assert_eq!(store.intern(b"gamma"), NameId::new(1));
    assert_eq!(store.intern(b"delta"), NameId::new(2));
}

#[test]
fn compaction_remaps_the_entry_name_column_and_clears_tombstones() {
    let mut store = NameStore::new();
    let mut table = EntryTable::new();
    let a = store.intern(b"a");
    let b = store.intern(b"b");
    let c = store.intern(b"c");
    let entry_a = entry(&mut table, a, 1);
    let entry_b = entry(&mut table, b, 2);
    let entry_c = entry(&mut table, c, 3);
    table.tombstone(entry_b);
    assert!(store.release(b));

    let plan = store.plan_compact();
    store.install_compacted(plan, &mut table);

    assert_eq!(table.name_id(entry_a), NameId::new(0));
    assert_eq!(table.name_id(entry_c), NameId::new(1));
    assert_eq!(table.name_id(entry_b), NO_NAME);
    assert_eq!(store.raw_bytes(table.name_id(entry_a)), b"a");
    assert_eq!(store.folded_bytes(table.name_id(entry_c)), b"c");
}

#[test]
fn folded_spans_ascend_and_map_hits_back_to_names() {
    let mut store = NameStore::new();
    let alpha = store.intern(b"Alpha");
    let beta = store.intern(b"beta");

    let alpha_folded = store.folded_span(alpha);
    let beta_folded = store.folded_span(beta);
    assert!(alpha_folded.offset() < beta_folded.offset());
    assert_eq!(store.span_bytes(alpha_folded), b"alpha");
    assert_eq!(store.span_bytes(beta_folded), b"beta");

    assert_eq!(store.folded_name_at(alpha_folded.offset()), Some(alpha));
    assert_eq!(
        store.folded_name_at(beta_folded.offset() + 2),
        Some(beta)
    );
    assert_eq!(
        store.folded_name_at(beta_folded.offset() + beta_folded.len()),
        None
    );
    assert_eq!(store.folded_name_at(store.folded().len() - 1), None);
    assert_eq!(store.folded_name_at(usize::MAX), None);

    let alpha_raw = store.raw_span(alpha);
    assert!(!alpha_raw.in_folded());
    assert_eq!(store.span_bytes(alpha_raw), b"Alpha");
    let beta_raw = store.raw_span(beta);
    assert!(beta_raw.in_folded());
    assert_eq!(store.span_bytes(beta_raw), b"beta");
}

#[test]
fn folded_name_at_skips_released_names() {
    let mut store = NameStore::new();
    let dead = store.intern(b"dead");
    let live = store.intern(b"live");
    let dead_offset = store.folded_span(dead).offset();
    assert!(store.release(dead));

    assert_eq!(store.folded_name_at(dead_offset), None);
    assert_eq!(
        store.folded_name_at(store.folded_span(live).offset()),
        Some(live)
    );
}

#[test]
fn name_ids_walk_every_slot_in_order() {
    let mut store = NameStore::new();
    store.intern(b"one");
    store.intern(b"two");
    store.intern(b"three");
    let ids: Vec<NameId> = store.name_ids().collect();
    assert_eq!(
        ids,
        vec![NameId::new(0), NameId::new(1), NameId::new(2)]
    );
}

#[test]
fn name_chain_iterates_linked_entries_in_head_order() {
    let mut store = NameStore::new();
    let mut table = EntryTable::new();
    let name = store.intern(b"same");
    let first = entry(&mut table, name, 1);
    let second = entry(&mut table, name, 2);
    store.link_same(name, first, &mut table);
    store.link_same(name, second, &mut table);

    let chain: Vec<EntryId> = store.name_chain(name, &table).collect();
    assert_eq!(chain, vec![second, first]);
}

#[test]
fn dedup_table_probes_colliding_buckets() {
    let mut seen = std::collections::HashMap::new();
    let mut collision = None;
    for index in 0..100u32 {
        let name = format!("collision-candidate-{index}");
        let bucket = NameTable::hash(name.as_bytes()) as usize % 16;
        if let Some(previous) = seen.insert(bucket, name.clone()) {
            collision = Some((previous, name));
            break;
        }
    }
    let (first_name, second_name) =
        collision.expect("16 buckets must collide within 100 candidate names");

    let mut store = NameStore::new();
    let first = store.intern(first_name.as_bytes());
    let second = store.intern(second_name.as_bytes());
    assert_ne!(first, second);
    assert_eq!(store.intern(first_name.as_bytes()), first);
    assert_eq!(store.intern(second_name.as_bytes()), second);
    assert_eq!(store.raw_bytes(first), first_name.as_bytes());
    assert_eq!(store.raw_bytes(second), second_name.as_bytes());
    assert_eq!(store.slot_count(), 2);
}

#[test]
fn dedup_table_survives_resize() {
    let mut store = NameStore::new();
    let initial_slots = store.table.control.len();
    for index in 0..256u32 {
        store.intern(format!("resize-name-{index:03}").as_bytes());
    }
    assert!(store.table.control.len() > initial_slots);
    assert_eq!(store.slot_count(), 256);

    for index in 0..256u32 {
        let name = format!("resize-name-{index:03}");
        let id = NameId::new(index);
        assert_eq!(store.raw_bytes(id), name.as_bytes());
        assert_eq!(store.intern(name.as_bytes()), id);
        assert_eq!(store.refcount(id), 2);
    }
}

#[test]
fn dedup_table_reuses_tombstones_without_losing_live_names() {
    let mut store = NameStore::new();
    for index in 0..300u32 {
        let id = store.intern(format!("transient-{index:03}").as_bytes());
        assert!(store.release(id));
    }
    assert_eq!(store.live_names(), 0);
    assert_eq!(store.table.len, 0);
    let grown_slots = store.table.control.len();

    for index in 0..300u32 {
        store.intern(format!("permanent-{index:03}").as_bytes());
    }
    assert_eq!(store.table.control.len(), grown_slots);
    assert_eq!(store.slot_count(), 600);

    for index in 0..300u32 {
        let name = format!("permanent-{index:03}");
        let id = store.intern(name.as_bytes());
        assert_eq!(store.raw_bytes(id), name.as_bytes());
        assert_eq!(store.refcount(id), 2);
    }
    assert_eq!(store.live_names(), 300);
}
