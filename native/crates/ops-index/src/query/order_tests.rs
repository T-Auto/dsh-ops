use crate::query::NameSource;
use crate::query::fixture::{EntryOptions, TestSource};
use crate::query::scan::Candidate;

use super::{SortDir, SortKey, SortSpec, page_bounds, sort_prefix};

const NAME_ASC: SortSpec = SortSpec {
    key: SortKey::Name,
    dir: SortDir::Asc,
};

fn entries_in_order(candidates: &[Candidate]) -> Vec<u32> {
    candidates
        .iter()
        .map(|candidate| candidate.entry.get())
        .collect()
}

fn names_in_order(source: &TestSource, candidates: &[Candidate]) -> Vec<Vec<u8>> {
    candidates
        .iter()
        .map(|candidate| source.name_raw(candidate.name).to_vec())
        .collect()
}

#[test]
fn page_bounds_clamp_at_the_end_of_the_candidates() {
    assert_eq!(page_bounds(10, 0, None), (0, 10));
    assert_eq!(page_bounds(10, 3, Some(2)), (3, 5));
    assert_eq!(page_bounds(10, 9, Some(5)), (9, 10));
    assert_eq!(page_bounds(10, 10, Some(5)), (10, 10));
    assert_eq!(page_bounds(10, 42, None), (10, 10));
    assert_eq!(page_bounds(10, 0, Some(0)), (0, 0));
    assert_eq!(page_bounds(0, 0, Some(5)), (0, 0));
}

#[test]
fn name_order_ties_break_on_entry_id() {
    let mut source = TestSource::new();
    source.add(b"b");
    source.add(b"A");
    source.add(b"a");
    let mut candidates = source.candidates_in_entry_order();
    let end = candidates.len();
    sort_prefix(&source, NAME_ASC, &mut candidates, end);
    assert_eq!(
        entries_in_order(&candidates),
        vec![1, 2, 0],
        "folded a (entry 1), folded a (entry 2), folded b (entry 0)"
    );
}

#[test]
fn descending_reverses_the_entry_id_tiebreak_too() {
    let mut source = TestSource::new();
    source.add(b"b");
    source.add(b"A");
    source.add(b"a");
    let mut candidates = source.candidates_in_entry_order();
    let end = candidates.len();
    sort_prefix(
        &source,
        SortSpec {
            key: SortKey::Name,
            dir: SortDir::Desc,
        },
        &mut candidates,
        end,
    );
    assert_eq!(entries_in_order(&candidates), vec![0, 2, 1]);
}

#[test]
fn size_order_is_ascending_with_unknown_last() {
    let mut source = TestSource::new();
    source.add_with(
        b"ten",
        EntryOptions {
            size: Some(10),
            ..EntryOptions::default()
        },
    );
    source.add_with(b"unknown", EntryOptions::default());
    source.add_with(
        b"five",
        EntryOptions {
            size: Some(5),
            ..EntryOptions::default()
        },
    );
    let mut candidates = source.candidates_in_entry_order();
    let end = candidates.len();
    sort_prefix(
        &source,
        SortSpec {
            key: SortKey::Size,
            dir: SortDir::Asc,
        },
        &mut candidates,
        end,
    );
    assert_eq!(
        names_in_order(&source, &candidates),
        vec![b"five".to_vec(), b"ten".to_vec(), b"unknown".to_vec()]
    );
}

#[test]
fn size_order_is_descending_with_unknown_first() {
    let mut source = TestSource::new();
    source.add_with(
        b"ten",
        EntryOptions {
            size: Some(10),
            ..EntryOptions::default()
        },
    );
    source.add_with(b"unknown", EntryOptions::default());
    source.add_with(
        b"five",
        EntryOptions {
            size: Some(5),
            ..EntryOptions::default()
        },
    );
    let mut candidates = source.candidates_in_entry_order();
    let end = candidates.len();
    sort_prefix(
        &source,
        SortSpec {
            key: SortKey::Size,
            dir: SortDir::Desc,
        },
        &mut candidates,
        end,
    );
    assert_eq!(
        names_in_order(&source, &candidates),
        vec![b"unknown".to_vec(), b"ten".to_vec(), b"five".to_vec()]
    );
}

#[test]
fn modified_order_puts_unknown_first_ascending() {
    let mut source = TestSource::new();
    source.add_with(
        b"now",
        EntryOptions {
            modified_ns: Some(100),
            ..EntryOptions::default()
        },
    );
    source.add_with(b"unknown", EntryOptions::default());
    source.add_with(
        b"old",
        EntryOptions {
            modified_ns: Some(-5),
            ..EntryOptions::default()
        },
    );
    let mut candidates = source.candidates_in_entry_order();
    let end = candidates.len();
    sort_prefix(
        &source,
        SortSpec {
            key: SortKey::Modified,
            dir: SortDir::Asc,
        },
        &mut candidates,
        end,
    );
    assert_eq!(
        names_in_order(&source, &candidates),
        vec![b"unknown".to_vec(), b"old".to_vec(), b"now".to_vec()]
    );
}

#[test]
fn a_small_page_sorts_only_the_prefix_it_needs() {
    let mut source = TestSource::new();
    for name in [b"d".as_slice(), b"c", b"b", b"a"] {
        source.add(name);
    }
    let mut candidates = source.candidates_in_entry_order();
    sort_prefix(&source, NAME_ASC, &mut candidates, 2);
    assert_eq!(
        names_in_order(&source, &candidates[..2]),
        vec![b"a".to_vec(), b"b".to_vec()],
        "the page prefix holds the two smallest names in order"
    );
    assert_eq!(candidates.len(), 4, "selection never drops candidates");
}

#[test]
fn prefix_selection_agrees_with_a_full_sort() {
    let mut source = TestSource::new();
    for name in [b"d".as_slice(), b"c", b"b", b"a"] {
        source.add(name);
    }
    let mut prefixed = source.candidates_in_entry_order();
    sort_prefix(&source, NAME_ASC, &mut prefixed, 3);
    let mut full = source.candidates_in_entry_order();
    full.sort_unstable_by_key(|candidate| candidate.entry);
    let end = full.len();
    sort_prefix(&source, NAME_ASC, &mut full, end);
    assert_eq!(prefixed[..3], full[..3]);
}
