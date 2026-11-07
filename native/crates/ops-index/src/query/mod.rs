// Design informed by mustafaahci/goz (MIT).
//! Deterministic name queries over an interned file-name index.
//!
//! The query layer is the last pure step of the crate: a caller hands in a
//! read-only view of interned names and entries ([NameSource]) plus a
//! structured [Query], and receives the exact number of matching entries and
//! one page of rows. Nothing here walks a file system, opens a file, or parses
//! user query syntax; the goz es.exe parser is deliberately not part of this
//! crate.
//!
//! Contract highlights:
//!
//! - Patterns are ANDed; a query with no patterns matches every entry.
//! - Matching is folded (NFC(simple_lowercase(NFD(name)))) unless the query
//!   asks for case sensitivity, in which case raw name bytes are compared.
//! - total is the full number of matching, presentable entries before offset
//!   and limit; hits is the page only. An entry the index cannot present is
//!   excluded from total and counted in skipped, never placed in a page.
//! - The result order is a total order over (sort key, folded name, entry id),
//!   so it is identical for serial and parallel scans and across runs.
//! - A budget deadline or match cap that stops a scan returns an error; a
//!   partial result is never reported as complete.
//!
//! SortKey::Path is intentionally absent: ordering by path needs the volume
//! layer's path reconstruction, which this slice does not depend on. Name,
//! Size and Modified are enough for a name index page.

pub mod order;
pub mod pattern;
mod plan;
pub mod scan;

use std::fmt;
use std::time::Instant;

use crate::ids::{EntryId, NameId, RecordId};

pub use order::{SortDir, SortKey, SortSpec};
pub use pattern::{MAX_PATTERN_BYTES, MatchMode, Pattern};
pub use scan::{EntryView, IndexView, NameSource};

#[cfg(test)]
#[path = "fixture_tests.rs"]
pub(crate) mod fixture;

/// Errors raised while building or running a query.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryError {
    /// A pattern needle was empty.
    EmptyPattern,
    /// A pattern needle exceeded [MAX_PATTERN_BYTES].
    PatternTooLong {
        /// Actual needle length in bytes.
        len: usize,
        /// Maximum accepted length.
        max: usize,
    },
    /// A pattern needle contained a NUL byte.
    PatternContainsNul,
    /// The match cap in [QueryBudget] stopped the scan.
    TooBroad {
        /// The cap that was exceeded.
        max: u64,
    },
    /// The deadline in [QueryBudget] stopped the scan.
    DeadlineExceeded,
    /// A scan worker panicked; no partial result is returned.
    WorkerPanicked,
    /// The name source could not read back an entry it had just yielded.
    InvalidSource,
}

impl fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPattern => {
                formatter.write_str("pattern needle is empty; omit patterns to match every name")
            }
            Self::PatternTooLong { len, max } => {
                write!(
                    formatter,
                    "pattern needle is {len} bytes, above the {max}-byte limit"
                )
            }
            Self::PatternContainsNul => formatter.write_str(
                "pattern needle contains a NUL byte, which name interning uses as a separator",
            ),
            Self::TooBroad { max } => write!(
                formatter,
                "match count exceeded the {max}-entry cap; narrow the query"
            ),
            Self::DeadlineExceeded => {
                formatter.write_str("query deadline elapsed before the scan finished")
            }
            Self::WorkerPanicked => {
                formatter.write_str("a query scan worker panicked; no partial result is returned")
            }
            Self::InvalidSource => formatter
                .write_str("the name source could not read back an entry it had just yielded"),
        }
    }
}

impl std::error::Error for QueryError {}

/// Limits that keep one query bounded.
///
/// Both limits are checked at chunk boundaries during the scan. No limit is
/// the default; a caller that wants a 20-second query path passes
/// deadline: Some(Instant::now() + Duration::from_secs(20)).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QueryBudget {
    /// Wall-clock instant after which the scan aborts with
    /// [QueryError::DeadlineExceeded].
    pub deadline: Option<Instant>,
    /// Maximum number of matched entries (presentable or not) before the scan
    /// aborts with [QueryError::TooBroad].
    pub max_matches: Option<u64>,
}

/// One structured query over an interned name index.
#[derive(Clone, Debug, Default)]
pub struct Query {
    /// Patterns that must all match one name (AND). Empty means match all.
    pub patterns: Vec<Pattern>,
    /// Compare raw name bytes instead of folded bytes.
    pub case_sensitive: bool,
    /// Ordering of the reported page.
    pub sort: SortSpec,
    /// Number of matching rows to skip before the page.
    pub offset: u32,
    /// Maximum page size; None returns every matching row.
    pub limit: Option<u32>,
    /// Requested scan threads: 0 picks a machine-sized count, 1 stays serial.
    pub threads: usize,
    /// Scan limits.
    pub budget: QueryBudget,
}

/// One row of the returned page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryHit {
    /// Table slot of the entry.
    pub entry: EntryId,
    /// Interned name that matched.
    pub name_id: NameId,
    /// Parent entry slot; EntryId::NIL for the index root.
    pub parent: EntryId,
    /// Stable record identity used to detect slot reuse.
    pub record: RecordId,
    /// Size in bytes when the index knows it.
    pub size: Option<u64>,
    /// Modification time in nanoseconds since the Unix epoch when known.
    pub modified_ns: Option<i64>,
    /// Raw WTF-8 name bytes of this entry, copied for the page only.
    pub name: Vec<u8>,
}

/// Result of one query: an exact total plus one page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryOutcome {
    /// Number of matching, presentable entries before offset and limit.
    pub total: u64,
    /// Number of matching entries the index could not present as a path.
    pub skipped: u64,
    /// The requested page, already ordered and sliced.
    pub hits: Vec<QueryHit>,
}

/// Runs one query against a read-only name source.
pub fn run_query<S: NameSource + Sync + ?Sized>(
    source: &S,
    query: &Query,
) -> Result<QueryOutcome, QueryError> {
    let plan = plan::Plan::new(query);
    let scan::ScanOutcome {
        mut candidates,
        skipped,
    } = scan::run(source, &plan, query)?;
    let total = candidates.len() as u64;
    let (start, end) = order::page_bounds(candidates.len(), query.offset, query.limit);
    if start < end {
        order::sort_prefix(source, query.sort, &mut candidates, end);
    }
    let hits = build_hits(source, &candidates[start..end])?;
    Ok(QueryOutcome {
        total,
        skipped,
        hits,
    })
}

fn build_hits<S: NameSource + ?Sized>(
    source: &S,
    page: &[scan::Candidate],
) -> Result<Vec<QueryHit>, QueryError> {
    page.iter()
        .map(|candidate| {
            let entry = source
                .entry(candidate.entry)
                .ok_or(QueryError::InvalidSource)?;
            Ok(QueryHit {
                entry: candidate.entry,
                name_id: candidate.name,
                parent: entry.parent,
                record: entry.record,
                size: entry.size,
                modified_ns: entry.modified_ns,
                name: source.name_raw(candidate.name).to_vec(),
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod mod_tests;
