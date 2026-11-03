// Design informed by mustafaahci/goz (MIT).
//! Deterministic total order, the total/page split, and page selection.
//!
//! The comparator is a total order over (sort rank, folded name, entry id):
//! entry ids are unique, so no two candidates compare equal and an unstable
//! sort is still deterministic. Descending reverses the whole tuple, including
//! the entry-id tiebreak, exactly as the reference design does; the result is
//! still a total order, only mirrored.
//!
//! Sort keys are integer ranks computed at scan time:
//!
//! - Name compares the folded name bytes, then the entry id. Two raw spellings
//!   that fold to the same bytes tie and are separated by entry id.
//! - Size compares the size rank: an unknown size is treated as u64::MAX so it
//!   never masquerades as an empty file; the direction applies afterwards.
//! - Modified compares (mtime as u64) xor (1 << 63), with unknown mapped to
//!   zero: ascending puts unknown first, descending puts it last.
//!
//! total is computed before offset and limit; the page is a slice of the
//! globally ordered candidates. When the page ends well before the end of the
//! candidate list the selector only orders the smallest page_end candidates,
//! so a small page does not pay for a full sort.

use std::cmp::Ordering;

use super::scan::{Candidate, NameSource};

/// Primary ordering key of a query page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SortKey {
    /// Folded name bytes, then entry id.
    #[default]
    Name,
    /// Size rank, then folded name, then entry id.
    Size,
    /// Modification-time rank, then folded name, then entry id.
    Modified,
}

/// Direction applied to the whole sort tuple.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SortDir {
    /// Smallest key first.
    #[default]
    Asc,
    /// Largest key first (the whole tuple is reversed, including the tiebreak).
    Desc,
}

/// One complete ordering request.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct SortSpec {
    /// Primary key.
    pub key: SortKey,
    /// Direction.
    pub dir: SortDir,
}

/// Splits a candidate count into the [start, end) page range.
pub(crate) fn page_bounds(total: usize, offset: u32, limit: Option<u32>) -> (usize, usize) {
    let start = (offset as usize).min(total);
    let end = match limit {
        None => total,
        Some(limit) => start.saturating_add(limit as usize).min(total),
    };
    (start, end)
}

/// Orders the prefix of candidates needed to serve a page ending at page_end.
pub(crate) fn sort_prefix<S: NameSource + ?Sized>(
    source: &S,
    spec: SortSpec,
    candidates: &mut [Candidate],
    page_end: usize,
) {
    let end = page_end.min(candidates.len());
    if end == 0 {
        return;
    }
    let key = spec.key;
    let descending = spec.dir == SortDir::Desc;
    let mut compare_candidates = |left: &Candidate, right: &Candidate| {
        let ordering = compare(source, key, left, right);
        if descending {
            ordering.reverse()
        } else {
            ordering
        }
    };
    if end < candidates.len() {
        candidates.select_nth_unstable_by(end, &mut compare_candidates);
        candidates[..end].sort_unstable_by(&mut compare_candidates);
    } else {
        candidates.sort_unstable_by(&mut compare_candidates);
    }
}

fn compare<S: NameSource + ?Sized>(
    source: &S,
    key: SortKey,
    left: &Candidate,
    right: &Candidate,
) -> Ordering {
    let primary = match key {
        SortKey::Name => Ordering::Equal,
        SortKey::Size => left.size_rank.cmp(&right.size_rank),
        SortKey::Modified => left.modified_rank.cmp(&right.modified_rank),
    };
    primary
        .then_with(|| {
            source
                .name_folded(left.name)
                .cmp(source.name_folded(right.name))
        })
        .then_with(|| left.entry.cmp(&right.entry))
}

#[cfg(test)]
#[path = "order_tests.rs"]
mod order_tests;
