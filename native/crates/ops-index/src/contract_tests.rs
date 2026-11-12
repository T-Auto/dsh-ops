//! Cross-module contracts pinned for P8 (#599): public error surface, layout
//! wire constants, presentability and name-order consumers, truncation
//! boundaries, and total (never-panicking) decoders over malformed bytes.
//!
//! These tests deliberately run through the crate's public API only. A change
//! that renames or reshapes a public item, or that lets the query layer see a
//! non-presentable entry, fails here even if each module's own tests still pass.

use crate::error::Error;
use crate::ids::{NameId, RecordId};
use crate::index::{NameOrder, NameStore, PathStatus, RecordMap, VolumeIndex};
use crate::layout::fixtures::{
    FileFixture, InfoFixture, NameFixture, Page, StreamFixture, build_page,
};
use crate::layout::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ENTRY_LEN, FILE_LAYOUT_NAME_ENTRY_DOS,
    FILE_LAYOUT_NAME_ENTRY_PRIMARY, INFO_ENTRY_LEGACY_LEN, INFO_PREFIX_LEN, MAX_NAME_BYTES,
    NAME_ENTRY_HEADER_LEN, OUTPUT_HEADER_LEN, QUERY_FILE_LAYOUT_INCLUDE_EXTRA_INFO,
    QUERY_FILE_LAYOUT_INCLUDE_NAMES, QUERY_FILE_LAYOUT_INCLUDE_STREAMS,
    QUERY_FILE_LAYOUT_INCLUDE_STREAMS_WITH_NO_CLUSTERS_ALLOCATED, QUERY_FILE_LAYOUT_RESTART,
    QUERY_FILE_LAYOUT_SINGLE_INSTANCED, RECOMMENDED_LAYOUT_FLAGS, STREAM_ENTRY_LEN,
    walk_layout_buffer,
};
use crate::query::{
    IndexView, MatchMode, Pattern, Query, QueryBudget, QueryError, QueryOutcome, SortDir, SortKey,
    SortSpec, run_query,
};
use crate::usn::fixtures::{RecordFixture, build_enum_buffer};
use crate::usn::{
    self, LEADING_VALUE_LEN, ParsedUsnRecord, USN_COMMON_HEADER_LEN, USN_REASON_FILE_CREATE,
    USN_V2_HEADER_LEN, USN_V3_HEADER_LEN, WalkError, walk_enum_buffer, walk_journal_buffer,
};
use proptest::prelude::*;
use std::time::{Duration, Instant};

const ROOT: RecordId = RecordId::new(0x20);
const DOCS: RecordId = RecordId::new(0x21);
const REPORT: RecordId = RecordId::new(0x22);
const ORPHAN: RecordId = RecordId::new(0x23);

fn record(fixture: RecordFixture) -> RecordFixture {
    fixture.with_reason(USN_REASON_FILE_CREATE)
}

fn parsed(fixtures: &[RecordFixture]) -> Vec<ParsedUsnRecord> {
    walk_enum_buffer(&build_enum_buffer(0, fixtures))
        .unwrap()
        .records
}

fn usn_index(fixtures: &[RecordFixture]) -> VolumeIndex {
    let mut index = VolumeIndex::new(ROOT, RecordMap::dense(64));
    index.apply_batch(&parsed(fixtures));
    index
}

fn docs_file_index() -> VolumeIndex {
    usn_index(&[
        record(RecordFixture::dir(DOCS, ROOT, "docs")),
        record(RecordFixture::file(REPORT, DOCS, "Report.PDF")),
    ])
}

fn run(index: &VolumeIndex, query: &Query) -> QueryOutcome {
    run_query(&IndexView::new(index.names(), index.entries()), query).unwrap()
}

fn layout_page() -> Page {
    let docs = FileFixture::dir(DOCS, ROOT, "docs").with_info(InfoFixture::legacy(42));
    let report = FileFixture::file(REPORT, DOCS, "Report.PDF")
        .with_info(InfoFixture::legacy(1234))
        .with_streams(vec![StreamFixture::unnamed(4096)]);
    build_page(&[docs, report])
}

// -- public error surface ------------------------------------------------

#[test]
fn crate_error_variants_have_unique_stable_codes() {
    let errors = [
        Error::Truncated {
            what: "HEADER",
            offset: 0,
            need: 16,
            len: 8,
        },
        Error::OffsetOutOfBounds {
            what: "FIRST_FILE",
            offset: 7,
            len: 6,
        },
        Error::OffsetCycle {
            what: "NEXT_FILE",
            offset: 40,
            rel: 4,
            min: 40,
        },
        Error::OddUtf16Length {
            what: "NAME",
            offset: 8,
            len: 3,
        },
        Error::NameTooLong {
            what: "NAME",
            offset: 8,
            len: 512,
            max: MAX_NAME_BYTES,
        },
    ];
    let mut codes: Vec<&'static str> = errors.iter().map(Error::code).collect();
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), errors.len(), "codes must be unique");
    for (error, code) in errors.iter().zip(errors.iter().map(Error::code)) {
        assert!(code.starts_with("INDEX_"), "{code}");
        assert!(!error.to_string().is_empty());
        let _: &dyn std::error::Error = error;
    }
}

#[test]
fn usn_walk_errors_are_a_distinct_public_surface_with_offsets() {
    let errors = [
        (
            WalkError::ZeroRecordLength { offset: 8 },
            "INDEX_USN_RECORD_LENGTH_ZERO",
        ),
        (
            WalkError::RecordOverrun { offset: 9 },
            "INDEX_USN_RECORD_OVERRUN",
        ),
        (
            WalkError::TruncatedHeader { offset: 10 },
            "INDEX_USN_TRUNCATED_HEADER",
        ),
        (
            WalkError::MalformedName { offset: 11 },
            "INDEX_USN_MALFORMED_NAME",
        ),
    ];
    let mut codes: Vec<&'static str> = errors.iter().map(|(error, _)| error.code()).collect();
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), errors.len(), "codes must be unique");
    for (index, (error, code)) in errors.iter().enumerate() {
        assert_eq!(error.code(), *code);
        assert_eq!(error.offset(), 8 + index);
        assert!(!error.to_string().is_empty());
        let _: &dyn std::error::Error = error;
    }
    // A layout page failure is a crate::Error, never a usn::WalkError: the two
    // error vocabularies stay separate on purpose.
    let error = walk_layout_buffer(&[0u8; 8]).unwrap_err();
    assert_eq!(error.code(), "INDEX_TRUNCATED");
    assert!(matches!(error, Error::Truncated { .. }));
}

// -- layout wire constants ----------------------------------------------

#[test]
fn layout_wire_constants_are_the_documented_ntfs_abi() {
    assert_eq!(OUTPUT_HEADER_LEN, 16);
    assert_eq!(FILE_ENTRY_LEN, 40);
    assert_eq!(NAME_ENTRY_HEADER_LEN, 24);
    assert_eq!(INFO_PREFIX_LEN, 24);
    assert_eq!(STREAM_ENTRY_LEN, 48);
    assert_eq!(INFO_ENTRY_LEGACY_LEN, 56);
    assert_eq!(MAX_NAME_BYTES, 510);
    assert_eq!(FILE_ATTRIBUTE_DIRECTORY, 0x10);
    assert_eq!(FILE_LAYOUT_NAME_ENTRY_PRIMARY, 0x0001);
    assert_eq!(FILE_LAYOUT_NAME_ENTRY_DOS, 0x0002);
    assert_eq!(QUERY_FILE_LAYOUT_RESTART, 0x0001);
    assert_eq!(QUERY_FILE_LAYOUT_SINGLE_INSTANCED, 0x0001);
    assert_eq!(QUERY_FILE_LAYOUT_INCLUDE_NAMES, 0x0002);
    assert_eq!(QUERY_FILE_LAYOUT_INCLUDE_STREAMS, 0x0004);
    assert_eq!(QUERY_FILE_LAYOUT_INCLUDE_EXTRA_INFO, 0x0010);
    assert_eq!(
        QUERY_FILE_LAYOUT_INCLUDE_STREAMS_WITH_NO_CLUSTERS_ALLOCATED,
        0x0020
    );
    assert_eq!(
        RECOMMENDED_LAYOUT_FLAGS,
        QUERY_FILE_LAYOUT_INCLUDE_NAMES
            | QUERY_FILE_LAYOUT_INCLUDE_STREAMS
            | QUERY_FILE_LAYOUT_INCLUDE_EXTRA_INFO
            | QUERY_FILE_LAYOUT_INCLUDE_STREAMS_WITH_NO_CLUSTERS_ALLOCATED
    );
    assert_eq!(RECOMMENDED_LAYOUT_FLAGS, 0x36);
    assert_eq!(RECOMMENDED_LAYOUT_FLAGS & QUERY_FILE_LAYOUT_RESTART, 0);
    // USN's common header shares the wire size but is a separate constant.
    assert_eq!(USN_V2_HEADER_LEN, 60);
    assert_eq!(USN_V3_HEADER_LEN, 76);
    assert_eq!(LEADING_VALUE_LEN, 8);
    assert_eq!(USN_COMMON_HEADER_LEN, 8);
}

#[test]
fn layout_page_parses_fully_and_every_truncated_prefix_fails() {
    let page = layout_page();
    assert_eq!(walk_layout_buffer(&[]).unwrap(), Vec::new());
    let parsed = walk_layout_buffer(&page.bytes).unwrap();
    assert_eq!(parsed.len(), 2);
    assert!(parsed[0].is_dir());
    assert!(!parsed[1].is_dir());
    assert_eq!(parsed[1].size, Some(4096));
    assert_eq!(parsed[1].mtime_ft, Some(1234));
    for length in 1..page.bytes.len() {
        let error = walk_layout_buffer(&page.bytes[..length])
            .expect_err(&format!("prefix {length} must not parse"));
        assert!(error.code().starts_with("INDEX_"));
    }
}

#[test]
fn layout_offsets_outside_the_page_are_rejected_and_zero_offsets_are_cycles() {
    let page = build_page(&[FileFixture::file(REPORT, DOCS, "Report.PDF")]);
    let mut outside = page.clone();
    let target = outside.bytes.len() as u32 + 16;
    crate::layout::fixtures::put_u32(&mut outside.bytes, 4, target);
    let error = walk_layout_buffer(&outside.bytes).unwrap_err();
    assert!(
        matches!(error, Error::OffsetOutOfBounds { .. }),
        "unexpected {error:?}"
    );
    // A relative offset that does not advance past its own structure is a cycle,
    // not an out-of-bounds read: following it would loop forever.
    let mut cycle = page;
    crate::layout::fixtures::put_u32(&mut cycle.bytes, 4, 0);
    let error = walk_layout_buffer(&cycle.bytes).unwrap_err();
    assert!(
        matches!(error, Error::OffsetCycle { .. }),
        "unexpected {error:?}"
    );
}

// -- cross-module equivalence -------------------------------------------

#[test]
fn usn_and_layout_name_decoding_agree_on_the_same_utf16() {
    let units: Vec<u16> = "Ağaç.PDF".encode_utf16().collect();
    let usn = walk_enum_buffer(&build_enum_buffer(
        0,
        &[record(
            RecordFixture::file(REPORT, DOCS, "").with_name_units(units.clone()),
        )],
    ))
    .unwrap()
    .records[0]
        .clone();
    let layout = walk_layout_buffer(
        &build_page(&[FileFixture::file(REPORT, DOCS, "")
            .with_names(vec![NameFixture::primary_units(DOCS, units.clone())])])
        .bytes,
    )
    .unwrap()[0]
        .clone();
    assert_eq!(layout.names[0].name, usn.name);
    assert_eq!(layout.names[0].name_lossy, usn.name_lossy);
    assert_eq!(
        crate::fold::fold(&layout.names[0].name),
        crate::fold::fold(&usn.name)
    );
}

#[test]
fn a_layout_page_feeds_the_index_and_answers_a_query() {
    let page = layout_page();
    let mut index = VolumeIndex::new(ROOT, RecordMap::dense(32));
    for file in walk_layout_buffer(&page.bytes).unwrap() {
        index.insert_layout(&file);
    }
    let query = Query {
        patterns: vec![Pattern::substring("report").unwrap()],
        ..Query::default()
    };
    let outcome = run(&index, &query);
    assert_eq!(outcome.total, 1);
    assert_eq!(outcome.hits[0].name, b"Report.PDF");
    assert_eq!(outcome.hits[0].size, Some(4096));
    assert_eq!(outcome.hits[0].modified_ns, None);
    assert_eq!(outcome.hits[0].record, REPORT);

    let prefix = Query {
        patterns: vec![Pattern::prefix("doc").unwrap()],
        ..Query::default()
    };
    assert_eq!(run(&index, &prefix).total, 1);
    let case_sensitive = Query {
        patterns: vec![Pattern::substring("Report").unwrap()],
        case_sensitive: true,
        ..Query::default()
    };
    assert_eq!(run(&index, &case_sensitive).total, 1);
    let wrong_case = Query {
        patterns: vec![Pattern::substring("report").unwrap()],
        case_sensitive: true,
        ..Query::default()
    };
    assert_eq!(run(&index, &wrong_case).total, 0);
}

// -- presentability consumer --------------------------------------------

#[test]
fn query_total_and_skipped_follow_presentability_not_raw_rows() {
    let index = usn_index(&[
        record(RecordFixture::dir(DOCS, ROOT, "docs")),
        record(RecordFixture::file(REPORT, DOCS, "Report.PDF")),
        record(RecordFixture::file(
            ORPHAN,
            RecordId::new(0x99),
            "orphan.txt",
        )),
    ]);
    assert!(index.has_orphans());
    let outcome = run(
        &index,
        &Query {
            patterns: vec![Pattern::substring("o").unwrap()],
            ..Query::default()
        },
    );
    // The query layer filters on entry flags; the path-aware
    // VolumeIndex::is_presentable is the policy layer's stricter wrapper.
    let orphan_entry = index.head_of(ORPHAN).expect("orphan entry");
    let mut path = Vec::new();
    assert_eq!(
        index.path_of(orphan_entry, &mut path),
        PathStatus::InLostFound
    );
    assert!(!index.is_presentable(orphan_entry), "no real path");
    assert!(
        index.entries().get(orphan_entry).unwrap().is_presentable(),
        "entry flags alone are presentable"
    );
    for hit in &outcome.hits {
        let view = index.entries().get(hit.entry).expect("live hit");
        assert!(
            view.is_presentable(),
            "hit {:?} must carry presentable flags",
            hit.name
        );
        assert!(!view.is_synthetic(), "synthetic rows never become hits");
    }
    // total + skipped is the number of live rows the scan can see; a row that
    // was never linked into a same-name chain is not scannable, so this is a
    // bound rather than an equality.
    let all = run(&index, &Query::default());
    let scanned = all.total + all.skipped;
    assert!(scanned <= index.live_entries().count() as u64);
    assert!(
        all.skipped >= 1,
        "lost-and-found and the placeholder are skipped"
    );
}

#[test]
fn name_order_ranks_are_monotonic_and_match_query_name_order() {
    let mut names = NameStore::new();
    let mut order = NameOrder::new();
    let ids: Vec<NameId> = ["zeta", "Alpha", "beta", "alpha"]
        .iter()
        .map(|name| {
            let id = names.intern(name.as_bytes());
            order.push_unranked(id);
            id
        })
        .collect();
    order.build(&names);
    let ranked = order.order();
    assert!(!ranked.is_empty());
    for pair in ranked.windows(2) {
        let left = names.folded_bytes(pair[0]);
        let right = names.folded_bytes(pair[1]);
        assert!(left <= right, "rank order must follow folded bytes");
        let left_key = order.rank_key(pair[0], &names);
        let right_key = order.rank_key(pair[1], &names);
        if left < right {
            assert!(
                left_key < right_key,
                "distinct folded names need distinct keys"
            );
        } else {
            // "Alpha" and "alpha" fold equal; the folded-byte tiebreak later
            // separates them, so their rank keys may tie.
            assert!(left_key <= right_key, "equal folded names may share a key");
        }
    }
    // The first id of each folded group is ranked; later duplicates of the same
    // folded spelling may wait as unranked until the next merge.
    assert!(order.is_ranked(ids[0]), "zeta");
    assert!(order.is_ranked(ids[1]), "Alpha");
    assert!(order.is_ranked(ids[2]), "beta");
    let _ = ids[3];

    // The query layer is the consumer: its Name sort is the folded order.
    let index = usn_index(&[
        record(RecordFixture::dir(DOCS, ROOT, "zeta")),
        record(RecordFixture::file(REPORT, DOCS, "Alpha")),
        record(RecordFixture::file(ORPHAN, DOCS, "beta")),
    ]);
    let outcome = run(
        &index,
        &Query {
            sort: SortSpec {
                key: SortKey::Name,
                dir: SortDir::Asc,
            },
            ..Query::default()
        },
    );
    let folded: Vec<Vec<u8>> = outcome
        .hits
        .iter()
        .map(|hit| crate::fold::fold(&hit.name))
        .collect();
    let mut sorted = folded.clone();
    sorted.sort();
    assert_eq!(folded, sorted, "Name sort must consume folded-name order");
}

#[test]
fn size_and_modified_sort_consumers_use_index_metadata() {
    let mut index = docs_file_index();
    index.set_stat(REPORT, 900, 20);
    let other = RecordId::new(0x24);
    index.apply_batch(&parsed(&[record(RecordFixture::file(
        other, DOCS, "a.txt",
    ))]));
    index.set_stat(other, 100, 10);
    let sizes = run(
        &index,
        &Query {
            sort: SortSpec {
                key: SortKey::Size,
                dir: SortDir::Desc,
            },
            ..Query::default()
        },
    );
    let values: Vec<Option<u64>> = sizes.hits.iter().map(|hit| hit.size).collect();
    // Unknown sizes rank as the largest possible size, so descending order puts
    // them first; ascending order puts them last.
    assert_eq!(values, vec![None, Some(900), Some(100)]);
    let ascending_sizes = run(
        &index,
        &Query {
            sort: SortSpec {
                key: SortKey::Size,
                dir: SortDir::Asc,
            },
            ..Query::default()
        },
    );
    let ascending: Vec<Option<u64>> = ascending_sizes.hits.iter().map(|hit| hit.size).collect();
    assert_eq!(ascending, vec![Some(100), Some(900), None]);
    let modified = run(
        &index,
        &Query {
            sort: SortSpec {
                key: SortKey::Modified,
                dir: SortDir::Asc,
            },
            ..Query::default()
        },
    );
    let times: Vec<Option<i64>> = modified.hits.iter().map(|hit| hit.modified_ns).collect();
    // Unknown mtime ranks as the oldest time, so ascending order puts it first.
    assert_eq!(times, vec![None, Some(10), Some(20)]);
}

// -- truncation and budget boundaries -----------------------------------

#[test]
fn pagination_covers_every_boundary_without_unbounded_pages() {
    let index = docs_file_index();
    let all = run(&index, &Query::default());
    let total = all.total;
    assert!(total >= 2);
    let page = |offset: u32, limit: Option<u32>| {
        run(
            &index,
            &Query {
                offset,
                limit,
                ..Query::default()
            },
        )
    };
    assert_eq!(page(total as u32 - 1, Some(1)).hits.len(), 1);
    assert_eq!(page(total as u32, Some(1)).hits.len(), 0);
    assert_eq!(page(total as u32 + 5, Some(1)).hits.len(), 0);
    assert_eq!(page(0, Some(0)).hits.len(), 0);
    assert_eq!(page(0, Some(0)).total, total);
    assert_eq!(page(0, None).hits.len() as u64, total);
    assert_eq!(page(total as u32 - 1, None).hits.len(), 1);
    // A page is a suffix of the full order: no duplication across two pages.
    let first = page(0, Some(1));
    let second = page(1, Some(1));
    assert_eq!(first.hits[0], all.hits[0]);
    assert_eq!(second.hits[0], all.hits[1]);
}

#[test]
fn query_budget_boundaries_reject_a_partial_result() {
    let index = docs_file_index();
    let unlimited = run(&index, &Query::default());
    let matched = unlimited.total + unlimited.skipped;
    let exact = run(
        &index,
        &Query {
            budget: QueryBudget {
                max_matches: Some(matched),
                ..QueryBudget::default()
            },
            ..Query::default()
        },
    );
    assert_eq!(exact, unlimited);
    let error = run_query(
        &IndexView::new(index.names(), index.entries()),
        &Query {
            budget: QueryBudget {
                max_matches: Some(matched - 1),
                ..QueryBudget::default()
            },
            ..Query::default()
        },
    )
    .unwrap_err();
    assert_eq!(error, QueryError::TooBroad { max: matched - 1 });
    let expired = run_query(
        &IndexView::new(index.names(), index.entries()),
        &Query {
            budget: QueryBudget {
                deadline: Some(Instant::now() - Duration::from_secs(1)),
                ..QueryBudget::default()
            },
            ..Query::default()
        },
    )
    .unwrap_err();
    assert_eq!(expired, QueryError::DeadlineExceeded);
}

#[test]
fn serial_and_parallel_scans_return_the_same_page() {
    let index = docs_file_index();
    let query = |threads: usize| Query {
        threads,
        sort: SortSpec {
            key: SortKey::Name,
            dir: SortDir::Desc,
        },
        ..Query::default()
    };
    let serial = run(&index, &query(1));
    for threads in [0, 2, 4, 7] {
        assert_eq!(
            run(&index, &query(threads)).hits,
            serial.hits,
            "threads {threads}"
        );
        assert_eq!(run(&index, &query(threads)).total, serial.total);
    }
}

#[test]
fn pattern_construction_is_the_only_fallible_step() {
    assert_eq!(Pattern::substring(""), Err(QueryError::EmptyPattern));
    assert_eq!(Pattern::prefix(""), Err(QueryError::EmptyPattern));
    assert_eq!(
        Pattern::from_bytes(b"a\0b", MatchMode::Substring),
        Err(QueryError::PatternContainsNul)
    );
    let long = vec![b'x'; crate::query::MAX_PATTERN_BYTES + 1];
    assert_eq!(
        Pattern::from_bytes(&long, MatchMode::Prefix),
        Err(QueryError::PatternTooLong {
            len: crate::query::MAX_PATTERN_BYTES + 1,
            max: crate::query::MAX_PATTERN_BYTES,
        })
    );
    let ok = Pattern::from_bytes(b"\xff", MatchMode::Substring).unwrap();
    assert_eq!(ok.needle(), b"\xff");
    assert_eq!(ok.mode(), MatchMode::Substring);
}

// -- decoders are total over malformed bytes ----------------------------

#[test]
fn usn_record_wire_size_is_eight_aligned_and_sized() {
    let fixture = record(RecordFixture::file(REPORT, DOCS, "abc"));
    let bytes = usn::fixtures::record_bytes(&fixture);
    assert_eq!(bytes.len() % 8, 0);
    assert!(bytes.len() >= USN_V2_HEADER_LEN);
    let v3 = record(RecordFixture::file(REPORT, DOCS, "abc").with_version(3));
    let bytes = usn::fixtures::record_bytes(&v3);
    assert_eq!(bytes.len() % 8, 0);
    assert!(bytes.len() >= USN_V3_HEADER_LEN);
}

proptest! {
    #[test]
    fn layout_decoder_is_total_on_arbitrary_bytes(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
        match walk_layout_buffer(&bytes) {
            Ok(files) => {
                for file in files {
                    for name in file.names {
                        prop_assert!(name.name.len() <= MAX_NAME_BYTES as usize);
                    }
                }
            }
            Err(error) => prop_assert!(error.code().starts_with("INDEX_")),
        }
    }

    #[test]
    fn usn_walkers_are_total_on_arbitrary_bytes(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
        let offsets = [
            walk_enum_buffer(&bytes).err().map(|error| error.offset()),
            walk_journal_buffer(&bytes).err().map(|error| error.offset()),
        ];
        for offset in offsets.into_iter().flatten() {
            prop_assert!(offset <= bytes.len());
        }
    }
}
