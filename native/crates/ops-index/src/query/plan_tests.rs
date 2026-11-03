use crate::fold;
use crate::query::fixture::TestSource;
use crate::query::{MatchMode, Pattern, Query};

use super::Plan;

fn source(names: &[&[u8]]) -> TestSource {
    let mut source = TestSource::new();
    for name in names {
        source.add(name);
    }
    source
}

fn plan(patterns: Vec<Pattern>, case_sensitive: bool) -> Plan {
    Plan::new(&Query {
        patterns,
        case_sensitive,
        ..Query::default()
    })
}

#[test]
fn case_insensitive_matches_folded_bytes() {
    let source = source(&[b"Report"]);
    let plan = plan(vec![Pattern::substring("report").expect("valid")], false);
    assert!(plan.matches(&source, source.name_of(b"Report")));
    assert_eq!(
        plan.prefilter(),
        Some(b"report".as_slice()),
        "the folded needle drives the arena prefilter"
    );
}

#[test]
fn uppercase_needle_is_folded_for_an_insensitive_query() {
    let source = source(&[b"Report"]);
    let plan = plan(vec![Pattern::substring("REPORT").expect("valid")], false);
    assert!(plan.matches(&source, source.name_of(b"Report")));
    assert_eq!(plan.prefilter(), Some(b"report".as_slice()));
}

#[test]
fn case_sensitive_query_compares_raw_bytes() {
    let source = source(&[b"Report"]);
    let lower = plan(vec![Pattern::substring("report").expect("valid")], true);
    assert!(!lower.matches(&source, source.name_of(b"Report")));
    assert!(lower.prefilter().is_none());

    let exact = plan(vec![Pattern::substring("Report").expect("valid")], true);
    assert!(exact.matches(&source, source.name_of(b"Report")));
}

#[test]
fn prefix_is_anchored_at_the_start_of_the_name() {
    let source = source(&[b"doc", b"docs", b"adoc"]);
    let plan = plan(vec![Pattern::prefix("doc").expect("valid")], false);
    assert!(plan.matches(&source, source.name_of(b"doc")));
    assert!(plan.matches(&source, source.name_of(b"docs")));
    assert!(!plan.matches(&source, source.name_of(b"adoc")));
}

#[test]
fn prefix_is_not_a_substring_alias() {
    let source = source(&[b"xreport"]);
    let plan = plan(vec![Pattern::prefix("report").expect("valid")], false);
    assert!(!plan.matches(&source, source.name_of(b"xreport")));
}

#[test]
fn every_pattern_must_match() {
    let source = source(&[b"report.txt", b"report.pdf", b"notes.txt"]);
    let plan = plan(
        vec![
            Pattern::substring("report").expect("valid"),
            Pattern::substring("txt").expect("valid"),
        ],
        false,
    );
    assert!(plan.matches(&source, source.name_of(b"report.txt")));
    assert!(!plan.matches(&source, source.name_of(b"report.pdf")));
    assert!(!plan.matches(&source, source.name_of(b"notes.txt")));
}

#[test]
fn prefilter_uses_the_longest_folded_needle() {
    let plan = plan(
        vec![
            Pattern::substring("ab").expect("valid"),
            Pattern::substring("LONGER").expect("valid"),
        ],
        false,
    );
    assert_eq!(plan.prefilter(), Some(b"longer".as_slice()));
}

#[test]
fn match_all_and_case_sensitive_queries_have_no_prefilter() {
    assert!(plan(Vec::new(), false).prefilter().is_none());
    assert!(
        plan(vec![Pattern::substring("x").expect("valid")], true)
            .prefilter()
            .is_none()
    );
}

#[test]
fn folded_prefix_matches_a_canonically_equivalent_name() {
    let nfd = "cafe\u{301}".as_bytes();
    let source = source(&[nfd]);
    let plan = plan(vec![Pattern::prefix("café").expect("valid")], false);
    assert!(
        plan.matches(&source, source.name_of(nfd)),
        "fold is applied to the whole name, so NFC and NFD prefixes agree"
    );
}

#[test]
fn folding_is_not_accent_insensitive() {
    let nfc = "café".as_bytes();
    let source = source(&[nfc]);
    let plan = plan(vec![Pattern::substring("cafe").expect("valid")], false);
    assert!(!plan.matches(&source, source.name_of(nfc)));
}

#[test]
fn unpaired_surrogates_pass_through_both_sides() {
    let raw = b"a\xED\xA0\x80b";
    let source = source(&[raw]);
    let needle = Pattern::from_bytes(b"\xED\xA0\x80", MatchMode::Substring).expect("valid");
    let plan = plan(vec![needle], false);
    assert!(plan.matches(&source, source.name_of(raw)));
}

#[test]
fn substring_pattern_folds_to_the_expected_needle() {
    let plan = plan(vec![Pattern::substring("Straße").expect("valid")], false);
    assert_eq!(
        plan.prefilter(),
        Some(fold::fold("Straße".as_bytes()).as_slice())
    );
}
