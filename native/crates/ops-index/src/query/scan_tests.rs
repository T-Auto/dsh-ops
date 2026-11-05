use std::time::{Duration, Instant};

use proptest::prelude::*;

use crate::fold;
use crate::ids::{EntryId, RecordId};
use crate::index::{EntryFlags, EntryTable, NameStore};
use crate::query::fixture::{EntryOptions, TestSource};
use crate::query::scan::IndexView;
use crate::query::{MatchMode, Pattern, Query, QueryError, run_query};

fn many_names(count: usize) -> TestSource {
    let mut source = TestSource::new();
    for index in 0..count {
        source.add(format!("entry-{index:05}.bin").as_bytes());
    }
    source
}

fn query_with(pattern: Pattern, case_sensitive: bool) -> Query {
    let mut query = Query::default();
    query.patterns.push(pattern);
    query.case_sensitive = case_sensitive;
    query
}

#[test]
fn match_all_reports_every_presentable_entry() {
    let mut source = TestSource::new();
    source.add(b"a");
    source.add(b"b");
    source.add(b"c");
    let outcome = run_query(&source, &Query::default()).expect("match-all query");
    assert_eq!(outcome.total, 3);
    assert_eq!(outcome.skipped, 0);
    assert_eq!(outcome.hits.len(), 3);
}

#[test]
fn every_entry_of_a_hard_link_shaped_name_is_counted_once() {
    let mut source = TestSource::new();
    let first = source.add(b"shared.txt");
    source.add(b"shared.txt");
    source.add(b"shared.txt");
    source.add(b"other.txt");
    let outcome = run_query(
        &source,
        &query_with(Pattern::substring("shared").expect("valid"), false),
    )
    .expect("query");
    assert_eq!(outcome.total, 3);
    assert_eq!(outcome.hits.len(), 3);
    assert!(outcome.hits.iter().any(|hit| hit.entry == first));
}

#[test]
fn unpresentable_entries_are_skipped_not_paged() {
    let mut source = TestSource::new();
    for index in 0..5 {
        source.add(format!("file{index}.txt").as_bytes());
    }
    source.set_presentable(crate::ids::EntryId::new(1), false);
    source.set_presentable(crate::ids::EntryId::new(3), false);
    let mut query = query_with(Pattern::substring(".txt").expect("valid"), false);
    query.limit = Some(2);
    let outcome = run_query(&source, &query).expect("query");
    assert_eq!(
        outcome.total, 3,
        "unpresentable entries do not inflate total"
    );
    assert_eq!(outcome.skipped, 2);
    assert_eq!(outcome.hits.len(), 2);
    for hit in &outcome.hits {
        assert!(
            hit.entry != crate::ids::EntryId::new(1) && hit.entry != crate::ids::EntryId::new(3),
            "an unpresentable entry must never occupy a page slot"
        );
    }
}

#[test]
fn prefilter_finds_needles_at_the_edges_and_middle_of_names() {
    let mut source = TestSource::new();
    source.add(b"report");
    source.add(b"myreport");
    source.add(b"report.txt");
    source.add(b"other");
    let outcome = run_query(
        &source,
        &query_with(Pattern::substring("report").expect("valid"), false),
    )
    .expect("query");
    assert_eq!(outcome.total, 3);
}

#[test]
fn prefix_scan_is_anchored() {
    let mut source = TestSource::new();
    source.add(b"doc");
    source.add(b"docs");
    source.add(b"adoc");
    let outcome = run_query(
        &source,
        &query_with(Pattern::prefix("doc").expect("valid"), false),
    )
    .expect("query");
    assert_eq!(outcome.total, 2);
}

#[test]
fn case_sensitive_scan_ignores_the_folded_match() {
    let mut source = TestSource::new();
    source.add(b"Report");
    let folded = run_query(
        &source,
        &query_with(Pattern::substring("report").expect("valid"), false),
    )
    .expect("query");
    assert_eq!(folded.total, 1);
    let raw = run_query(
        &source,
        &query_with(Pattern::substring("report").expect("valid"), true),
    )
    .expect("query");
    assert_eq!(raw.total, 0);
    let exact = run_query(
        &source,
        &query_with(Pattern::substring("Report").expect("valid"), true),
    )
    .expect("query");
    assert_eq!(exact.total, 1);
}

#[test]
fn parallel_prefilter_scan_agrees_with_serial_scan() {
    let source = many_names(3000);
    let mut query = query_with(Pattern::substring("entry-").expect("valid"), false);
    query.limit = Some(50);
    query.offset = 7;
    query.sort = crate::query::SortSpec {
        key: crate::query::SortKey::Size,
        dir: crate::query::SortDir::Desc,
    };
    let serial = {
        let mut serial = query.clone();
        serial.threads = 1;
        run_query(&source, &serial).expect("serial query")
    };
    let parallel = {
        let mut parallel = query.clone();
        parallel.threads = 4;
        run_query(&source, &parallel).expect("parallel query")
    };
    let automatic = run_query(&source, &query).expect("automatic query");
    assert_eq!(
        serial, parallel,
        "chunk order, not completion order, decides"
    );
    assert_eq!(serial, automatic);
}

#[test]
fn parallel_full_scan_agrees_with_serial_scan() {
    let source = many_names(3000);
    let mut query = query_with(Pattern::substring("entry-").expect("valid"), true);
    query.limit = None;
    let serial = {
        let mut serial = query.clone();
        serial.threads = 1;
        run_query(&source, &serial).expect("serial query")
    };
    let parallel = {
        let mut parallel = query.clone();
        parallel.threads = 4;
        run_query(&source, &parallel).expect("parallel query")
    };
    assert_eq!(serial, parallel);
}

#[test]
fn expired_deadline_aborts_instead_of_returning_a_truncated_scan() {
    let source = many_names(100);
    let mut query = Query::default();
    query.budget.deadline = Some(Instant::now() - Duration::from_millis(1));
    assert_eq!(
        run_query(&source, &query),
        Err(QueryError::DeadlineExceeded)
    );
}

#[test]
fn match_cap_aborts_with_too_broad() {
    let source = many_names(10);
    let mut query = Query::default();
    query.budget.max_matches = Some(3);
    assert_eq!(
        run_query(&source, &query),
        Err(QueryError::TooBroad { max: 3 })
    );
}

#[test]
fn match_cap_under_the_limit_is_not_an_error() {
    let source = many_names(10);
    let mut query = Query::default();
    query.budget.max_matches = Some(100);
    let outcome = run_query(&source, &query).expect("query under the cap");
    assert_eq!(outcome.total, 10);
}

#[test]
fn entry_metadata_survives_the_scan() {
    let mut source = TestSource::new();
    source.add_with(
        b"data.bin",
        EntryOptions {
            size: Some(42),
            modified_ns: Some(1234),
            ..EntryOptions::default()
        },
    );
    let outcome = run_query(&source, &Query::default()).expect("query");
    let hit = &outcome.hits[0];
    assert_eq!(hit.size, Some(42));
    assert_eq!(hit.modified_ns, Some(1234));
}

#[test]
fn empty_name_is_the_structural_root_not_a_row() {
    let mut source = TestSource::new();
    source.add(b"");
    source.add(b"visible.txt");
    let outcome = run_query(&source, &Query::default()).expect("match-all query");
    assert_eq!(outcome.total, 1, "the root's empty name is not a query row");
    assert_eq!(
        outcome.skipped, 0,
        "structural entries are not skipped matches"
    );
    assert_eq!(outcome.hits.len(), 1);
}

#[test]
fn index_view_queries_the_real_index_tables() {
    let mut names = NameStore::new();
    let mut entries = EntryTable::new();
    let root_name = names.intern(b"");
    let root = entries.alloc(RecordId::new(1), EntryId::NIL, root_name, EntryFlags::DIR);
    let report_name = names.intern(b"Report.TXT");
    let report = entries.alloc(RecordId::new(2), root, report_name, EntryFlags::EMPTY);
    names.link_same(report_name, report, &mut entries);
    entries.set_size(report, Some(9));
    entries.set_mtime(report, Some(77));
    let notes_name = names.intern(b"notes.md");
    let notes = entries.alloc(RecordId::new(3), root, notes_name, EntryFlags::EMPTY);
    names.link_same(notes_name, notes, &mut entries);

    let view = IndexView::new(&names, &entries);
    let query = Query {
        patterns: vec![Pattern::substring("report").expect("valid")],
        ..Query::default()
    };
    let outcome = run_query(&view, &query).expect("index view query");
    assert_eq!(outcome.total, 1);
    let hit = &outcome.hits[0];
    assert_eq!(hit.entry, report);
    assert_eq!(hit.name, b"Report.TXT".to_vec());
    assert_eq!(hit.size, Some(9));
    assert_eq!(hit.modified_ns, Some(77));
    assert_eq!(hit.parent, root);

    let all = run_query(&view, &Query::default()).expect("match-all query");
    assert_eq!(
        all.total, 2,
        "the root's empty name is structural, not a row"
    );
}

#[test]
fn index_view_marks_a_detached_entry_unpresentable() {
    let mut names = NameStore::new();
    let mut entries = EntryTable::new();
    let root_name = names.intern(b"");
    let root = entries.alloc(RecordId::new(1), EntryId::NIL, root_name, EntryFlags::DIR);
    let loose_name = names.intern(b"loose.txt");
    let loose = entries.alloc(
        RecordId::new(2),
        root,
        loose_name,
        EntryFlags::CHAIN_DETACHED,
    );
    names.link_same(loose_name, loose, &mut entries);
    let view = IndexView::new(&names, &entries);
    let outcome = run_query(&view, &Query::default()).expect("query");
    assert_eq!(outcome.total, 0, "a detached entry is not presentable");
    assert_eq!(outcome.skipped, 1);
}

fn name_strategy() -> impl Strategy<Value = String> {
    proptest::string::string_regex("[a-zA-Zçğ0-9._]{1,12}").expect("valid name regex")
}

fn needle_strategy() -> impl Strategy<Value = String> {
    proptest::string::string_regex("[a-zA-Zçğ]{1,4}").expect("valid needle regex")
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    #[test]
    fn substring_scan_matches_a_naive_oracle(
        names in prop::collection::vec(name_strategy(), 1..20),
        needles in prop::collection::vec(needle_strategy(), 1..3),
    ) {
        let mut source = TestSource::new();
        let mut expected: Vec<u32> = Vec::new();
        for name in &names {
            let entry = source.add(name.as_bytes());
            let folded = fold::fold(name.as_bytes());
            let matched = needles.iter().all(|needle| {
                let needle = fold::fold(needle.as_bytes());
                folded
                    .windows(needle.len())
                    .any(|window| window == needle.as_slice())
            });
            if matched {
                expected.push(entry.get());
            }
        }
        let query = Query {
            patterns: needles
                .iter()
                .map(|needle| Pattern::substring(needle).expect("non-empty needle"))
                .collect(),
            ..Query::default()
        };
        let outcome = run_query(&source, &query).expect("fixture query cannot fail");
        let mut got: Vec<u32> = outcome.hits.iter().map(|hit| hit.entry.get()).collect();
        expected.sort_unstable();
        got.sort_unstable();
        prop_assert_eq!(outcome.total as usize, expected.len());
        prop_assert_eq!(got, expected);
    }

    #[test]
    fn prefix_scan_matches_a_naive_oracle(
        names in prop::collection::vec(name_strategy(), 1..20),
        needles in prop::collection::vec(needle_strategy(), 1..3),
    ) {
        let mut source = TestSource::new();
        let mut expected: Vec<u32> = Vec::new();
        for name in &names {
            let entry = source.add(name.as_bytes());
            let folded = fold::fold(name.as_bytes());
            let matched = needles.iter().all(|needle| {
                let needle = fold::fold(needle.as_bytes());
                folded.starts_with(&needle)
            });
            if matched {
                expected.push(entry.get());
            }
        }
        let query = Query {
            patterns: needles
                .iter()
                .map(|needle| Pattern::prefix(needle).expect("non-empty needle"))
                .collect(),
            ..Query::default()
        };
        let outcome = run_query(&source, &query).expect("fixture query cannot fail");
        let mut got: Vec<u32> = outcome.hits.iter().map(|hit| hit.entry.get()).collect();
        expected.sort_unstable();
        got.sort_unstable();
        prop_assert_eq!(outcome.total as usize, expected.len());
        prop_assert_eq!(got, expected);
    }
}

#[test]
fn substring_patterns_keep_their_mode() {
    let pattern = Pattern::from_bytes(b"abc", MatchMode::Substring).expect("valid");
    assert_eq!(pattern.mode(), MatchMode::Substring);
}

#[test]
fn expired_deadline_rejects_empty_and_no_match_queries() {
    for count in [0, 1] {
        let source = many_names(count);
        for patterns in [vec![], vec![Pattern::substring("absent").unwrap()]] {
            let mut query = Query {
                patterns,
                ..Query::default()
            };
            query.budget.deadline = Some(Instant::now() - Duration::from_secs(1));
            assert_eq!(
                run_query(&source, &query),
                Err(QueryError::DeadlineExceeded)
            );
        }
    }
}

// Hold the arena accessor until the budget expires, without depending on scan
// speed or a race between the test and the scanner.
struct ExpiringArena {
    source: TestSource,
    deadline: Instant,
}

impl super::NameSource for ExpiringArena {
    fn folded_arena(&self) -> &[u8] {
        while Instant::now() < self.deadline {
            std::thread::sleep(self.deadline.saturating_duration_since(Instant::now()));
        }
        self.source.folded_arena()
    }
    fn name_count(&self) -> u32 {
        self.source.name_count()
    }
    fn name_at(&self, ordinal: u32) -> crate::ids::NameId {
        self.source.name_at(ordinal)
    }
    fn name_raw(&self, name: crate::ids::NameId) -> &[u8] {
        self.source.name_raw(name)
    }
    fn name_folded(&self, name: crate::ids::NameId) -> &[u8] {
        self.source.name_folded(name)
    }
    fn folded_name_at(&self, _: usize) -> Option<crate::ids::NameId> {
        panic!("expired prefilter must stop before resolving a hit")
    }
    fn for_each_name_entry(
        &self,
        name: crate::ids::NameId,
        visit: &mut dyn FnMut(super::EntryView),
    ) {
        self.source.for_each_name_entry(name, visit);
    }
    fn entry(&self, entry: EntryId) -> Option<super::EntryView> {
        self.source.entry(entry)
    }
}

#[test]
fn deadline_expiring_in_prefilter_is_not_a_complete_empty_result() {
    let source = ExpiringArena {
        source: many_names(1),
        deadline: Instant::now() + Duration::from_millis(20),
    };
    let mut query = query_with(Pattern::substring("absent").unwrap(), false);
    query.budget.deadline = Some(source.deadline);
    assert_eq!(
        run_query(&source, &query),
        Err(QueryError::DeadlineExceeded)
    );
}

#[test]
fn deadline_expiring_in_prefilter_stops_before_resolving_matches() {
    let source = ExpiringArena {
        source: many_names(1),
        deadline: Instant::now() + Duration::from_millis(20),
    };
    let mut query = query_with(Pattern::substring("entry").unwrap(), false);
    query.budget.deadline = Some(source.deadline);
    assert_eq!(
        run_query(&source, &query),
        Err(QueryError::DeadlineExceeded)
    );
}

#[test]
fn prefilter_preserves_needles_spanning_byte_chunks() {
    let mut source = TestSource::new();
    // The separator puts the next name two bytes before a chunk boundary.
    source.add(&vec![b'x'; super::PREFILTER_BYTES - 3]);
    source.add(b"abcdef");
    let query = query_with(Pattern::substring("abcdef").unwrap(), false);
    assert_eq!(run_query(&source, &query).unwrap().total, 1);
    let long = vec![b'y'; 1024];
    source.add(&long);
    let query = query_with(
        Pattern::from_bytes(&long, MatchMode::Substring).unwrap(),
        false,
    );
    assert_eq!(run_query(&source, &query).unwrap().total, 1);
}
