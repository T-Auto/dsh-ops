// Design informed by mustafaahci/goz (MIT).
//! Compiled query plan: folded needles, the folded-arena prefilter, and the
//! per-name predicate.
//!
//! A plan is built per call, never cached. A Pattern stores the bytes the
//! caller supplied; only the query's case switch decides whether those bytes
//! are folded. Caching a compiled pattern across queries would let a plan built
//! for one case mode run against another, so the plan owns its folded needles
//! instead of borrowing a pattern.
//!
//! Prefilter choice: the longest folded needle among the patterns is searched
//! over the whole folded arena. Any final match must contain (or, for a prefix
//! pattern, start with) that needle, so the arena scan is only a superset
//! filter and every hit is verified against all patterns afterwards. A
//! case-sensitive query has no prefilter: the folded arena is the wrong
//! haystack, and the raw arena is not guaranteed to be one contiguous block.

use crate::fold;
use crate::ids::NameId;
use crate::query::{MatchMode, Query};

use super::scan::NameSource;

#[derive(Debug)]
pub(crate) struct Plan {
    patterns: Vec<CompiledPattern>,
    prefilter: Option<Vec<u8>>,
    case_sensitive: bool,
}

#[derive(Debug)]
struct CompiledPattern {
    mode: MatchMode,
    needle: Vec<u8>,
}

impl Plan {
    pub(crate) fn new(query: &Query) -> Self {
        let case_sensitive = query.case_sensitive;
        let patterns: Vec<CompiledPattern> = query
            .patterns
            .iter()
            .map(|pattern| CompiledPattern {
                mode: pattern.mode(),
                needle: if case_sensitive {
                    pattern.needle().to_vec()
                } else {
                    fold::fold(pattern.needle())
                },
            })
            .collect();
        let prefilter = if case_sensitive {
            None
        } else {
            patterns
                .iter()
                .max_by_key(|pattern| pattern.needle.len())
                .map(|pattern| pattern.needle.clone())
        };
        Self {
            patterns,
            prefilter,
            case_sensitive,
        }
    }

    /// Needle to search across the folded arena, when one is useful.
    pub(crate) fn prefilter(&self) -> Option<&[u8]> {
        self.prefilter.as_deref()
    }

    /// Whether every name matches (a query with no patterns).
    pub(crate) fn matches<S: NameSource + ?Sized>(&self, source: &S, name: NameId) -> bool {
        if self.patterns.is_empty() {
            return true;
        }
        if self.case_sensitive {
            self.matches_bytes(source.name_raw(name))
        } else {
            self.matches_bytes(source.name_folded(name))
        }
    }

    fn matches_bytes(&self, name: &[u8]) -> bool {
        self.patterns.iter().all(|pattern| match pattern.mode {
            MatchMode::Substring => memchr::memmem::find(name, &pattern.needle).is_some(),
            MatchMode::Prefix => name.starts_with(&pattern.needle),
        })
    }
}

#[cfg(test)]
#[path = "plan_tests.rs"]
mod plan_tests;
