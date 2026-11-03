// Design informed by mustafaahci/goz (MIT).
//! Structured name patterns: substring or prefix over interned name bytes.
//!
//! A Pattern is a needle plus a MatchMode. It never parses user query syntax:
//! the goz es.exe tokenizer (case:, ext:, quoted phrases, | and !, whole-name
//! globs) is deliberately not ported, because a structured pattern is what a
//! name index can filter without guessing a user's intent. Callers build
//! patterns themselves and hand them to a query.
//!
//! Matching is byte-exact on whichever name form the query selects: raw WTF-8
//! bytes for a case-sensitive query, folded bytes for a case-insensitive one.
//! The fold is defined by crate::fold (NFC(simple_lowercase(NFD(name)))); it
//! never drops combining marks, so "cafe" does not match "café".
//!
//! Three byte classes are rejected at construction so that a plan never has to
//! guess what a pattern means:
//!
//! - empty needles, because "match everything" is expressed by a query with no
//!   patterns, not by a silent empty pattern;
//! - needles longer than MAX_PATTERN_BYTES, because no platform name can
//!   contain them and every extra byte only inflates the prefilter table;
//! - needles containing a NUL byte, because NUL separates names inside the
//!   folded arena and a prefilter hit could otherwise start inside one name and
//!   end inside the next one.

use crate::query::QueryError;

/// Upper bound on one pattern needle, in bytes.
///
/// Far above every platform name limit this index can see (NTFS names are at
/// most 255 UTF-16 units; Linux and macOS cap a path component at 255 bytes),
/// while keeping memchr's prefilter tables tiny.
pub const MAX_PATTERN_BYTES: usize = 1024;

/// How a pattern compares against a name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MatchMode {
    /// The needle may appear anywhere in the name.
    Substring,
    /// The name must start with the needle.
    ///
    /// The prefix is compared against the whole name after folding, never
    /// against a prefix of the folded name's source bytes: NFC composition can
    /// change a byte boundary, so folding after truncation would be wrong.
    Prefix,
}

/// One validated needle together with its match mode.
///
/// Construction is the only fallible step: a Pattern in hand is always
/// non-empty, at most MAX_PATTERN_BYTES long, and free of NUL bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
    needle: Box<[u8]>,
    mode: MatchMode,
}

impl Pattern {
    /// Builds a substring pattern from UTF-8 text.
    pub fn substring(needle: &str) -> Result<Self, QueryError> {
        Self::from_bytes(needle.as_bytes(), MatchMode::Substring)
    }

    /// Builds a prefix pattern from UTF-8 text.
    pub fn prefix(needle: &str) -> Result<Self, QueryError> {
        Self::from_bytes(needle.as_bytes(), MatchMode::Prefix)
    }

    /// Builds a pattern from raw name bytes.
    ///
    /// This is the byte-level constructor for callers that hold WTF-8 names
    /// (which cannot be represented as str when they contain unpaired
    /// surrogates) or that want to match non-UTF-8 bytes exactly.
    pub fn from_bytes(needle: &[u8], mode: MatchMode) -> Result<Self, QueryError> {
        if needle.is_empty() {
            return Err(QueryError::EmptyPattern);
        }
        if needle.len() > MAX_PATTERN_BYTES {
            return Err(QueryError::PatternTooLong {
                len: needle.len(),
                max: MAX_PATTERN_BYTES,
            });
        }
        if needle.contains(&0) {
            return Err(QueryError::PatternContainsNul);
        }
        Ok(Self {
            needle: needle.into(),
            mode,
        })
    }

    /// Match mode of this pattern.
    pub const fn mode(&self) -> MatchMode {
        self.mode
    }

    /// Needle bytes exactly as supplied by the caller (not folded).
    pub fn needle(&self) -> &[u8] {
        &self.needle
    }
}

#[cfg(test)]
#[path = "pattern_tests.rs"]
mod pattern_tests;
