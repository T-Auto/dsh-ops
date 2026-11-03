use super::*;
use proptest::prelude::*;

fn encode(units: &[u16]) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let lone = from_utf16(units, &mut out);
    (out, lone)
}

fn decode(bytes: &[u8]) -> Vec<u32> {
    CodePoints::new(bytes).collect()
}

#[test]
fn ascii_is_identity() {
    let (bytes, lone) = encode(&[
        b'h' as u16,
        b'e' as u16,
        b'l' as u16,
        b'l' as u16,
        b'o' as u16,
    ]);
    assert_eq!(bytes, b"hello");
    assert!(!lone);
    assert_eq!(to_string_lossy(&bytes), "hello");
}

#[test]
fn bmp_and_supplementary_match_utf8() {
    for text in ["ağaç.pdf", "文件名.txt", "𝄞.mid", "ß.md"] {
        let units: Vec<u16> = text.encode_utf16().collect();
        let (bytes, lone) = encode(&units);
        assert_eq!(bytes, text.as_bytes(), "{text}");
        assert!(!lone, "{text}");
        assert_eq!(to_string_lossy(&bytes), text);
        assert_eq!(to_utf16(&bytes), units);
    }
}

#[test]
fn lone_surrogates_round_trip_exactly() {
    for units in [
        vec![0x0061, 0xD800, 0x0062],
        vec![0xDC00, 0x0041],
        vec![0x0041, 0xD9FF],
        vec![0xD800],
        vec![0xDFFF, 0xD800],
    ] {
        let (bytes, lone) = encode(&units);
        assert!(lone, "{units:?}");
        assert_eq!(to_utf16(&bytes), units, "{units:?}");
        assert!(to_string_lossy(&bytes).contains('\u{FFFD}'));
    }
}

#[test]
fn paired_surrogates_do_not_flag_lossy() {
    let (bytes, lone) = encode(&[0xD834, 0xDD1E]);
    assert!(!lone);
    assert_eq!(to_string_lossy(&bytes), "𝄞");
    assert_eq!(to_utf16(&bytes), vec![0xD834, 0xDD1E]);
}

#[test]
fn decoder_survives_malformed_bytes() {
    let decoded = decode(&[0xE0, 0x80, b'a', 0xFF]);
    assert!(decoded.contains(&(b'a' as u32)));
    assert!(decoded.contains(&REPLACEMENT));
}

#[test]
fn overlong_and_over_range_decode_to_replacement() {
    for bytes in [
        vec![0xC0, 0xAF],
        vec![0xE0, 0x80, 0xAF],
        vec![0xF7, 0xBF, 0xBF, 0xBF],
        vec![0xF4, 0x90, 0x80, 0x80],
        vec![0xF0, 0x8D, 0xA0, 0x80],
    ] {
        let decoded = decode(&bytes);
        assert_eq!(decoded.len(), bytes.len(), "{bytes:02X?}");
        assert!(
            decoded.iter().all(|code| *code == REPLACEMENT),
            "{bytes:02X?}"
        );
    }
    assert!(!to_string_lossy(&[0xC0, 0xAF]).contains('/'));
    // The slash in this input is literal: after the overlong sequence is
    // rejected, 0x2F is decoded on its own. The invariant is "output contains
    // an ASCII value iff the input contains it", not "output never contains
    // slashes" — otherwise a real separator in a real name would be dropped.
    assert!(to_string_lossy(&[0xE0, 0x80, 0x2F]).contains('/'));
    assert!(decode(&[0xE0, 0x80, 0x2F]).contains(&0x2F));
}

#[test]
fn exact_resync_counts() {
    assert_eq!(decode(&[0xC0, 0xAF]).len(), 2);
    assert_eq!(decode(&[0xE0, 0x80, 0xAF]).len(), 3);
    assert_eq!(decode(&[0xF7, 0xBF, 0xBF, 0xBF]).len(), 4);
    assert_eq!(decode(&[0xF0, 0x8D, 0xA0, 0x80]).len(), 4);
    assert_eq!(decode(&[0xC2]).len(), 1);
    assert_eq!(decode(&[0xE0, 0xA0]).len(), 2);
    assert_eq!(decode(&[0xF0, 0x90, 0x80]).len(), 3);
    assert_eq!(decode(&[0xF8, 0x41]).len(), 2);
}

#[test]
fn legal_boundaries_are_accepted() {
    assert_eq!(decode(&[0xED, 0xA0, 0x80]), vec![0xD800]);
    assert_eq!(decode(&[0xED, 0xBF, 0xBF]), vec![0xDFFF]);
    assert_eq!(decode(&[0xEE, 0x80, 0x80]), vec![0xE000]);
    assert_eq!(decode(&[0xF4, 0x8F, 0xBF, 0xBF]), vec![0x10_FFFF]);
    assert_eq!(decode(&[0xE0, 0xA0, 0x80]), vec![0x0800]);
    assert_eq!(decode(&[0xC2, 0x80]), vec![0x80]);
}

#[test]
fn from_utf16_appends_and_reports_each_call() {
    let mut out = b"prefix:".to_vec();
    assert!(!from_utf16(&[b'A' as u16], &mut out));
    assert!(from_utf16(&[0xD800], &mut out));
    assert_eq!(&out[..7], b"prefix:");
    assert_eq!(to_utf16(&out[7..]), vec![b'A' as u16, 0xD800]);
    assert!(!from_utf16(&[], &mut out));
}

#[test]
fn little_endian_bytes_match_the_unit_slice_entry_point() {
    let units: [u16; 5] = [0x0061, 0xD800, 0x4E2D, 0xD834, 0xDD1E];
    let mut le = Vec::new();
    for unit in units {
        le.extend_from_slice(&unit.to_le_bytes());
    }
    let (expected, expected_lone) = encode(&units);
    let mut actual = Vec::new();
    let actual_lone = from_utf16_le(&le, &mut actual);
    assert_eq!(actual, expected);
    assert_eq!(actual_lone, expected_lone);
}

#[test]
#[cfg(debug_assertions)]
fn odd_byte_length_is_a_debug_contract_violation() {
    let result = std::panic::catch_unwind(|| {
        let mut out = Vec::new();
        from_utf16_le(&[0x61, 0x00, 0xAA], &mut out)
    });
    assert!(
        result.is_err(),
        "callers validate the even UTF-16 length; an odd buffer is a bug"
    );
}

#[test]
fn to_utf16_replaces_each_bad_byte_once() {
    assert_eq!(to_utf16(&[0xFF]), vec![0xFFFD]);
    assert_eq!(to_utf16(&[0xC0, 0xAF]), vec![0xFFFD, 0xFFFD]);
    assert_eq!(to_utf16(&[0xE0, 0x80, 0xAF]), vec![0xFFFD, 0xFFFD, 0xFFFD]);
    assert!(!from_utf16(&to_utf16(&[0xE0, 0x80, 0xAF]), &mut Vec::new()));
}

#[test]
fn to_string_lossy_fast_path_matches_slow_path_on_valid_utf8() {
    for text in ["plain", "café", "𝄞𝄞", "文件名"] {
        let bytes = text.as_bytes();
        assert_eq!(to_string_lossy(bytes), text);
        assert_eq!(to_utf16(bytes), text.encode_utf16().collect::<Vec<_>>());
    }
}

#[test]
fn ascii_invariant_is_bidirectional() {
    // Values chosen because each is a leader, a continuation, an overlong
    // candidate or an ASCII separator: the interesting corners of the decoder.
    const ALPHABET: [u8; 14] = [
        0x2F, 0x80, 0xAF, 0xC0, 0xC1, 0xE0, 0xED, 0xA0, 0xBF, 0xF0, 0xF4, 0xF7, 0xFF, 0x41,
    ];
    for length in 0..=4 {
        let total = ALPHABET.len().pow(length as u32);
        for mut selector in 0..total {
            let mut bytes = Vec::with_capacity(length);
            for _ in 0..length {
                bytes.push(ALPHABET[selector % ALPHABET.len()]);
                selector /= ALPHABET.len();
            }
            let mut decoded_ascii = [false; 128];
            for code in decode(&bytes) {
                assert!(code <= 0x10_FFFF);
                if code < 128 {
                    decoded_ascii[code as usize] = true;
                }
            }
            for value in 0..128u8 {
                assert_eq!(
                    decoded_ascii[value as usize],
                    bytes.contains(&value),
                    "ASCII 0x{value:02X} invariant broke for {bytes:02X?}"
                );
            }
        }
    }
}

proptest! {
    #[test]
    fn utf16_round_trips_through_wtf8(units in prop::collection::vec(any::<u16>(), 0..64)) {
        let (bytes, lone) = encode(&units);
        prop_assert_eq!(to_utf16(&bytes), units);
        prop_assert_eq!(lone, core::str::from_utf8(&bytes).is_err());
    }

    #[test]
    fn decoder_is_total_on_arbitrary_bytes(bytes in prop::collection::vec(any::<u8>(), 0..128)) {
        let decoded: Vec<u32> = CodePoints::new(&bytes).collect();
        prop_assert!(decoded.iter().all(|code| *code <= 0x10_FFFF));
        let _ = to_string_lossy(&bytes);
        // Re-encoding the decoded units is stable: to_utf16 output, fed back
        // through from_utf16, must produce the same units.
        let units = to_utf16(&bytes);
        let mut reencoded = Vec::new();
        from_utf16(&units, &mut reencoded);
        prop_assert_eq!(to_utf16(&reencoded), units);
    }
}
