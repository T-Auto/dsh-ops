// Design informed by mustafaahci/goz (MIT).
//! Case folding for name matching.
//!
//! The folded form is `NFC(simple_lowercase(NFD(name)))`: canonical
//! decomposition, one-to-one lowercase, canonical recomposition. That makes a
//! macOS/APFS name stored as NFD and the same name stored as NFC compare equal,
//! while remaining byte-precise for everything else. It is **not** full case
//! folding, not NFKC, and not accent removal: `ς` stays `ς` (it does not fold
//! to `σ`), `ẞ` folds to `ß` but `SS` does not, and `ﬁ` is left alone.
//!
//! Unpaired surrogates pass through unchanged and act as composition barriers:
//! a base character before a surrogate and a combining mark after it cannot be
//! composed across it.
//!
//! A folded name is a comparison key, never an identity key: two different
//! names may fold to the same bytes, so the index keeps raw bytes as identity
//! and folded bytes only for matching.

use crate::wtf8;
use unicode_normalization::UnicodeNormalization;

/// Folds `bytes` and appends the result to `out` (which is never cleared).
pub fn fold_into(bytes: &[u8], out: &mut Vec<u8>) {
    if bytes.is_ascii() {
        out.extend(bytes.iter().map(|byte| byte.to_ascii_lowercase()));
        return;
    }
    fold_non_ascii(bytes, out);
}

/// Slow path: canonical decompose, one-to-one lowercase, canonical compose.
///
/// Kept out of line so the ASCII fast path does not pay for the scratch buffer
/// it never uses.
#[inline(never)]
fn fold_non_ascii(bytes: &[u8], out: &mut Vec<u8>) {
    let mut run: Vec<char> = Vec::with_capacity(16);
    for code in wtf8::CodePoints::new(bytes) {
        match char::from_u32(code) {
            Some(character) => {
                unicode_normalization::char::decompose_canonical(character, |part| {
                    run.push(lower(part));
                });
            }
            None => {
                compose_into(&mut run, out);
                wtf8::encode_code_point(code, out);
            }
        }
    }
    compose_into(&mut run, out);
}

/// Composes a decomposed run and appends it, then empties the run.
fn compose_into(run: &mut Vec<char>, out: &mut Vec<u8>) {
    if run.is_empty() {
        return;
    }
    for character in run.iter().copied().nfc() {
        wtf8::encode_code_point(character as u32, out);
    }
    run.clear();
}

/// One-to-one lowercase, as required by the folding contract.
fn lower(character: char) -> char {
    character.to_lowercase().next().unwrap_or(character)
}

/// Folds `bytes` into a fresh buffer.
pub fn fold(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    fold_into(bytes, &mut out);
    out
}

#[cfg(test)]
#[path = "fold_tests.rs"]
mod fold_tests;
