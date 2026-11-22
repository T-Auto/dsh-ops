//! Decode the reversible rendering the Native reader shows for source lines.
//!
//! The encoder is "src/projections/native/line-encoding.ts"; this module is
//! its exact inverse, never a second encoding policy. ops_edit_file consults
//! it only after a raw match has failed (#939), so literal text keeps
//! precedence.

/// Interpret "text" as one rendered source line: a doubled backslash and the
/// JSON-style escapes (\b, \t, \n, \f, \r, \uXXXX) become their raw
/// characters. Unknown escapes and plain text stay byte-identical, so a string
/// that never came from the renderer decodes to itself and a half escape
/// invents nothing.
pub fn decode_rendered(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' && at + 1 < bytes.len() {
            match bytes[at + 1] {
                b'\\' => {
                    out.push('\\');
                    at += 2;
                    continue;
                }
                b'b' => {
                    out.push('\u{0008}');
                    at += 2;
                    continue;
                }
                b't' => {
                    out.push('\t');
                    at += 2;
                    continue;
                }
                b'n' => {
                    out.push('\n');
                    at += 2;
                    continue;
                }
                b'f' => {
                    out.push('\u{000c}');
                    at += 2;
                    continue;
                }
                b'r' => {
                    out.push('\r');
                    at += 2;
                    continue;
                }
                b'u' if at + 6 <= bytes.len()
                    && bytes[at + 2..at + 6].iter().all(u8::is_ascii_hexdigit) =>
                {
                    let code = u32::from_str_radix(&text[at + 2..at + 6], 16).unwrap_or(0);
                    match char::from_u32(code) {
                        Some(decoded) => out.push(decoded),
                        // Surrogate halves never appear in rendered text; keep
                        // the six characters literal instead of inventing one.
                        None => out.push_str(&text[at..at + 6]),
                    }
                    at += 6;
                    continue;
                }
                _ => {}
            }
        }
        // Copy one whole UTF-8 character: astral text stays intact.
        let width = character_width(bytes[at]);
        out.push_str(&text[at..at + width]);
        at += width;
    }
    out
}

fn character_width(lead: u8) -> usize {
    match lead {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf7 => 4,
        // A valid &str never offers any other lead byte.
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_escapes_decode_to_their_exact_source_characters() {
        assert_eq!(decode_rendered(r"a\tb"), "a\tb");
        assert_eq!(decode_rendered(r"C:\\new"), "C:\\new");
        assert_eq!(decode_rendered(r"\b\f\r\n"), "\u{0008}\u{000c}\r\n");
        assert_eq!(decode_rendered(r"\u0000"), "\0");
        assert_eq!(decode_rendered(r"\u2028text"), "\u{2028}text");
        assert_eq!(decode_rendered(r"\u0085"), "\u{0085}");
    }

    #[test]
    fn plain_text_unknown_and_broken_escapes_stay_byte_identical() {
        assert_eq!(decode_rendered("plain 中文 😀"), "plain 中文 😀");
        assert_eq!(decode_rendered(r"\q\z"), "\\q\\z");
        assert_eq!(decode_rendered(r"\uzzzz"), "\\uzzzz");
        assert_eq!(decode_rendered(r"\ud800"), "\\ud800");
        assert_eq!(decode_rendered(r"\u12"), "\\u12");
        assert_eq!(decode_rendered("trailing\\"), "trailing\\");
        assert_eq!(decode_rendered("back\\中"), "back\\中");
    }

    #[test]
    fn decoding_the_renderer_output_restores_every_source_sample() {
        // The same escape classes the TS encoder renders (see its suite); a
        // decoded rendering must be the raw source again.
        for source in [
            "alpha\ttab C:\\path\nbeta\n",
            "literal\\tab\treal\n",
            "\u{7f}\u{85}\u{2028}\u{2029}\0",
        ] {
            let rendered = encode_for_test(source);
            assert_ne!(rendered, source, "the sample must actually be rendered");
            assert_eq!(decode_rendered(&rendered), source);
        }
    }

    /// A mirror of the projection encoder, for round-trip coverage only.
    fn encode_for_test(source: &str) -> String {
        let mut out = String::new();
        for ch in source.chars() {
            match ch {
                '\\' => out.push_str("\\\\"),
                '\u{0008}' => out.push_str("\\b"),
                '\t' => out.push_str("\\t"),
                '\n' => out.push_str("\\n"),
                '\u{000c}' => out.push_str("\\f"),
                '\r' => out.push_str("\\r"),
                c if (c as u32) < 0x20 || matches!(c as u32, 0x7f | 0x85 | 0x2028 | 0x2029) => {
                    out.push_str(&format!("\\u{:04x}", c as u32));
                }
                c => out.push(c),
            }
        }
        out
    }
}
