use crate::ids::{EntryId, RecordId};
use crate::query::fixture::{EntryOptions, TestSource};
use crate::query::{
    Pattern, Query, QueryError, QueryOutcome, SortDir, SortKey, SortSpec, run_query,
};

fn source(names: &[&[u8]]) -> TestSource {
    let mut source = TestSource::new();
    for name in names {
        source.add(name);
    }
    source
}

fn matched_names(outcome: &QueryOutcome) -> Vec<Vec<u8>> {
    outcome.hits.iter().map(|hit| hit.name.clone()).collect()
}

#[test]
fn total_is_independent_of_offset_and_limit() {
    let source = source(&[b"a", b"b", b"c", b"d", b"e"]);
    let query = Query {
        offset: 1,
        limit: Some(2),
        ..Query::default()
    };
    let outcome = run_query(&source, &query).expect("query");
    assert_eq!(outcome.total, 5);
    assert_eq!(matched_names(&outcome), vec![b"b".to_vec(), b"c".to_vec()]);
}

#[test]
fn unlimited_page_returns_every_row() {
    let source = source(&[b"a", b"b", b"c"]);
    let outcome = run_query(&source, &Query::default()).expect("query");
    assert_eq!(outcome.total, 3);
    assert_eq!(outcome.hits.len(), 3);
}

#[test]
fn zero_limit_returns_no_rows_but_the_full_total() {
    let source = source(&[b"a", b"b", b"c"]);
    let query = Query {
        limit: Some(0),
        ..Query::default()
    };
    let outcome = run_query(&source, &query).expect("query");
    assert_eq!(outcome.total, 3);
    assert!(outcome.hits.is_empty());
}

#[test]
fn offset_past_the_end_returns_an_empty_page() {
    let source = source(&[b"a", b"b"]);
    let query = Query {
        offset: 99,
        ..Query::default()
    };
    let outcome = run_query(&source, &query).expect("query");
    assert_eq!(outcome.total, 2);
    assert!(outcome.hits.is_empty());
}

#[test]
fn hit_copies_every_reported_field() {
    let mut source = TestSource::new();
    let entry = source.add_with(
        b"data.bin",
        EntryOptions {
            size: Some(42),
            modified_ns: Some(1234),
            presentable: true,
            parent: EntryId::new(7),
        },
    );
    let outcome = run_query(&source, &Query::default()).expect("query");
    let hit = &outcome.hits[0];
    assert_eq!(hit.entry, entry);
    assert_eq!(hit.name_id, source.name_of(b"data.bin"));
    assert_eq!(hit.parent, EntryId::new(7));
    assert_eq!(hit.record, RecordId::new(0x1000));
    assert_eq!(hit.size, Some(42));
    assert_eq!(hit.modified_ns, Some(1234));
    assert_eq!(hit.name, b"data.bin".to_vec());
}

#[test]
fn anded_patterns_select_intersection_names() {
    let source = source(&[b"report.txt", b"report.pdf", b"notes.txt"]);
    let query = Query {
        patterns: vec![
            Pattern::substring("report").expect("valid"),
            Pattern::substring("txt").expect("valid"),
        ],
        ..Query::default()
    };
    let outcome = run_query(&source, &query).expect("query");
    assert_eq!(outcome.total, 1);
    assert_eq!(matched_names(&outcome), vec![b"report.txt".to_vec()]);
}

#[test]
fn case_sensitive_query_matches_only_raw_spellings() {
    let source = source(&[b"Report", b"report"]);
    let query = Query {
        case_sensitive: true,
        patterns: vec![Pattern::substring("Report").expect("valid")],
        ..Query::default()
    };
    let outcome = run_query(&source, &query).expect("query");
    assert_eq!(outcome.total, 1);
    assert_eq!(matched_names(&outcome), vec![b"Report".to_vec()]);
}

#[test]
fn prefix_and_substring_differ_at_the_boundary() {
    let source = source(&[b"docs", b"adocs"]);
    let prefix = Query {
        patterns: vec![Pattern::prefix("docs").expect("valid")],
        ..Query::default()
    };
    let outcome = run_query(&source, &prefix).expect("query");
    assert_eq!(outcome.total, 1);
    assert_eq!(matched_names(&outcome), vec![b"docs".to_vec()]);

    let substring = Query {
        patterns: vec![Pattern::substring("docs").expect("valid")],
        ..Query::default()
    };
    let outcome = run_query(&source, &substring).expect("query");
    assert_eq!(outcome.total, 2);
}

#[test]
fn size_sort_orders_the_page_and_keeps_the_total() {
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
    let query = Query {
        sort: SortSpec {
            key: SortKey::Size,
            dir: SortDir::Asc,
        },
        offset: 1,
        limit: Some(2),
        ..Query::default()
    };
    let outcome = run_query(&source, &query).expect("query");
    assert_eq!(outcome.total, 3);
    assert_eq!(
        matched_names(&outcome),
        vec![b"ten".to_vec(), b"unknown".to_vec()]
    );
}

#[test]
fn name_sort_descending_slices_the_mirrored_order() {
    let source = source(&[b"a", b"b", b"c"]);
    let query = Query {
        sort: SortSpec {
            key: SortKey::Name,
            dir: SortDir::Desc,
        },
        limit: Some(2),
        ..Query::default()
    };
    let outcome = run_query(&source, &query).expect("query");
    assert_eq!(matched_names(&outcome), vec![b"c".to_vec(), b"b".to_vec()]);
}

#[test]
fn runs_are_deterministic_across_repetitions() {
    let mut source = TestSource::new();
    for index in 0..100 {
        source.add(format!("name-{index:03}.dat").as_bytes());
    }
    let query = Query {
        sort: SortSpec {
            key: SortKey::Modified,
            dir: SortDir::Desc,
        },
        offset: 10,
        limit: Some(20),
        ..Query::default()
    };
    let first = run_query(&source, &query).expect("first query");
    let second = run_query(&source, &query).expect("second query");
    assert_eq!(first, second);
}

#[test]
fn skipped_entries_are_absent_from_the_page_and_counted() {
    let mut source = TestSource::new();
    source.add(b"keep-one");
    source.add(b"drop");
    source.add(b"keep-two");
    source.set_presentable(EntryId::new(1), false);
    let outcome = run_query(&source, &Query::default()).expect("query");
    assert_eq!(outcome.total, 2);
    assert_eq!(outcome.skipped, 1);
    assert_eq!(
        matched_names(&outcome),
        vec![b"keep-one".to_vec(), b"keep-two".to_vec()]
    );
}

#[test]
fn query_errors_render_a_stable_message() {
    assert_eq!(
        QueryError::EmptyPattern.to_string(),
        "pattern needle is empty; omit patterns to match every name"
    );
    assert_eq!(
        QueryError::TooBroad { max: 5 }.to_string(),
        "match count exceeded the 5-entry cap; narrow the query"
    );
    assert!(
        QueryError::DeadlineExceeded
            .to_string()
            .contains("deadline")
    );
}
