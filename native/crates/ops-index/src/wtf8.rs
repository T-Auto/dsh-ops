// Design informed by mustafaahci/goz (MIT).
//! WTF-8: the UTF-8 byte encoding that also carries unpaired UTF-16 surrogates.
//!
//! Names on NTFS are sequences of UTF-16 code units and may contain an unpaired
//! surrogate; `String` and `Path` cannot. WTF-8 encodes every `u16` sequence
//! exactly once, so a name survives a round trip byte for byte, including the
//! ones that are not valid UTF-8. The decoder is total over arbitrary bytes: a
//! malformed sequence becomes one `U+FFFD` per offending byte and decoding
//! resynchronizes at the next byte, so hostile input stays linear and cannot
//! panic.
//!
//! Two invariants matter for path handling:
//!
//! - Decoding accepts only shortest forms. An overlong sequence can therefore
//!   never smuggle `/` (0x2F) or `\` (0x5C) into a name: those ASCII values
//!   appear in the decoded code points if and only if they appear literally in
//!   the input bytes.
//! - [`to_utf16`] is not injective on malformed input (bad bytes collapse to
//!   `U+FFFD`), so it is a display/interop helper, never an identity key. The
//!   index keys names by their raw WTF-8 bytes.

/// Replacement code point emitted for every byte that starts no valid sequence.
const REPLACEMENT: u32 = 0xFFFD;

/// Encodes UTF-16 code units as WTF-8, appending to `out`.
///
/// Pairs a high surrogate with an immediately following low surrogate; any
/// other surrogate is encoded as its own code point, which is what makes the
/// mapping reversible. Returns `true` when the encoded bytes are not valid
/// UTF-8 because at least one unpaired surrogate was present. `out` is never
/// cleared, so callers can accumulate several units in one buffer.
pub fn from_utf16(units: &[u16], out: &mut Vec<u8>) -> bool {
    encode_units(units.iter().copied(), out)
}

/// Encodes little-endian UTF-16 bytes as WTF-8, appending to `out`.
///
/// This is the form a record buffer carries. Callers must have validated that
/// the byte length is even; a trailing odd byte is ignored rather than guessed
/// at. Returns `true` when the encoded bytes are not valid UTF-8.
pub fn from_utf16_le(bytes: &[u8], out: &mut Vec<u8>) -> bool {
    encode_units(
        bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|chunk| u16::from_le_bytes(*chunk)),
        out,
    )
}

/// Shared pairing pass, so the slice and the byte-slice entry points cannot
/// disagree about surrogate handling.
fn encode_units<I: Iterator<Item = u16>>(units: I, out: &mut Vec<u8>) -> bool {
    let mut lone = false;
    let mut pending_high: Option<u16> = None;
    for unit in units {
        if let Some(high) = pending_high.take() {
            if (0xDC00..0xE000).contains(&unit) {
                let code = 0x1_0000 + (((high as u32 - 0xD800) << 10) | (unit as u32 - 0xDC00));
                encode_code_point(code, out);
                continue;
            }
            lone = true;
            encode_code_point(high as u32, out);
        }
        if (0xD800..0xDC00).contains(&unit) {
            pending_high = Some(unit);
        } else {
            if (0xDC00..0xE000).contains(&unit) {
                lone = true;
            }
            encode_code_point(unit as u32, out);
        }
    }
    if let Some(high) = pending_high {
        lone = true;
        encode_code_point(high as u32, out);
    }
    lone
}

/// Appends the shortest WTF-8 encoding of `code`.
///
/// Encodes surrogates as their own three-byte sequences; callers must not pass
/// anything above `U+10FFFF`.
pub(crate) fn encode_code_point(code: u32, out: &mut Vec<u8>) {
    debug_assert!(code <= 0x10_FFFF, "code point out of range: {code:#x}");
    if code < 0x80 {
        out.push(code as u8);
    } else if code < 0x800 {
        out.push(0xC0 | (code >> 6) as u8);
        out.push(0x80 | (code & 0x3F) as u8);
    } else if code < 0x1_0000 {
        out.push(0xE0 | (code >> 12) as u8);
        out.push(0x80 | ((code >> 6) & 0x3F) as u8);
        out.push(0x80 | (code & 0x3F) as u8);
    } else {
        out.push(0xF0 | (code >> 18) as u8);
        out.push(0x80 | ((code >> 12) & 0x3F) as u8);
        out.push(0x80 | ((code >> 6) & 0x3F) as u8);
        out.push(0x80 | (code & 0x3F) as u8);
    }
}

/// Iterator over the code points of a WTF-8 byte string.
///
/// Yields `u32` rather than `char` on purpose: an unpaired surrogate is a
/// first-class code point here and must not be collapsed. Malformed input is
/// reported as [`REPLACEMENT`], one per byte, without panicking.
#[derive(Clone, Debug)]
pub struct CodePoints<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> CodePoints<'a> {
    /// Iterates over `bytes`.
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
}

impl Iterator for CodePoints<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        let first = *self.bytes.get(self.offset)?;
        if first < 0x80 {
            self.offset += 1;
            return Some(first as u32);
        }
        let (len, minimum) = match first {
            0xC0..=0xDF => (2, 0x80),
            0xE0..=0xEF => (3, 0x800),
            0xF0..=0xF7 => (4, 0x1_0000),
            _ => {
                self.offset += 1;
                return Some(REPLACEMENT);
            }
        };
        let Some(payload) = self.bytes.get(self.offset + 1..self.offset + len) else {
            self.offset += 1;
            return Some(REPLACEMENT);
        };
        let mut code = (first as u32) & (0x7F >> len);
        for &byte in payload {
            if byte & 0xC0 != 0x80 {
                self.offset += 1;
                return Some(REPLACEMENT);
            }
            code = (code << 6) | (byte as u32 & 0x3F);
        }
        if code < minimum || code > 0x10_FFFF {
            self.offset += 1;
            return Some(REPLACEMENT);
        }
        self.offset += len;
        Some(code)
    }
}

/// Re-encodes WTF-8 as UTF-16 code units.
///
/// Malformed input collapses to `U+FFFD`, so this is a lossy conversion in the
/// same way [`to_string_lossy`] is; valid WTF-8 (including unpaired
/// surrogates) round-trips exactly through [`from_utf16`].
pub fn to_utf16(bytes: &[u8]) -> Vec<u16> {
    let mut units = Vec::with_capacity(bytes.len());
    for code in CodePoints::new(bytes) {
        if code <= 0xFFFF {
            units.push(code as u16);
        } else {
            let code = code - 0x1_0000;
            units.push(0xD800 | (code >> 10) as u16);
            units.push(0xDC00 | (code & 0x3FF) as u16);
        }
    }
    units
}

/// Renders WTF-8 as a `String`, replacing unpaired surrogates and malformed
/// bytes with `U+FFFD`.
///
/// Valid UTF-8 is returned unchanged (fast path); otherwise the result is
/// rebuilt from code points. Never fails, and never grows by more than three
/// bytes per replacement.
pub fn to_string_lossy(bytes: &[u8]) -> String {
    match core::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => CodePoints::new(bytes)
            .map(|code| char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect(),
    }
}

#[cfg(test)]
#[path = "wtf8_tests.rs"]
mod wtf8_tests;
