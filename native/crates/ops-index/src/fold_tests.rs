use super::*;
use crate::wtf8;
use proptest::prelude::*;

fn fold_text(text: &str) -> Vec<u8> {
    fold(text.as_bytes())
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[test]
fn ascii_folds_case() {
    assert_eq!(fold_text("Report.PDF"), b"report.pdf");
    assert_eq!(fold_text("already"), b"already");
    assert_eq!(fold_text("A1_b-C"), b"a1_b-c");
}

#[test]
fn fold_is_idempotent() {
    for text in [
        "ÇAĞAÇ",
        "Straße",
        "ФайЛ",
        "İstanbul",
        "ΜΈΓΑ",
        "café",
        "ﬁle",
        "Ǆungla",
    ] {
        let once = fold_text(text);
        let twice = fold(&once);
        assert_eq!(once, twice, "{text}");
    }
}

#[test]
fn needle_and_haystack_fold_consistently() {
    let needle = fold_text("çağ");
    let haystack = fold_text("ÇAĞAÇ.pdf");
    assert!(
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    );
}

#[test]
fn non_ascii_lowercases() {
    assert_eq!(fold_text("ФАЙЛ"), "файл".as_bytes());
    assert_eq!(fold_text("I"), b"i");
    assert_eq!(
        fold_text("ı"),
        "ı".as_bytes(),
        "dotless i must not become i"
    );
}

#[test]
fn dotted_capital_i_folds_to_two_code_points() {
    let folded = fold_text("İ");
    let units = wtf8::to_utf16(&folded);
    assert_eq!(units, vec![0x0069, 0x0307]);
    assert_eq!(folded.len(), 3, "i plus U+0307 in WTF-8");
}

#[test]
fn specific_characters_match_the_contract() {
    assert_eq!(wtf8::to_utf16(&fold_text("Σ")), units("σ"));
    assert_eq!(wtf8::to_utf16(&fold_text("ς")), units("ς"));
    assert_ne!(fold_text("ς"), fold_text("σ"));
    assert_eq!(wtf8::to_utf16(&fold_text("ẞ")), units("ß"));
    assert_eq!(wtf8::to_utf16(&fold_text("ß")), units("ß"));
    assert_ne!(fold_text("SS"), fold_text("ß"));
    assert_eq!(wtf8::to_utf16(&fold_text("Å")), units("å"));
    assert_eq!(fold_text("\u{212A}"), b"k", "Kelvin sign lowercases to k");
    assert_eq!(wtf8::to_utf16(&fold_text("ﬁ")), units("ﬁ"));
    assert_eq!(wtf8::to_utf16(&fold_text("Ǆ")), units("ǆ"));
}

#[test]
fn nfc_and_nfd_fold_identically() {
    let nfc = "café";
    let nfd = "cafe\u{0301}";
    assert_ne!(nfc.as_bytes(), nfd.as_bytes());
    assert_eq!(fold_text(nfc), fold_text(nfd));
}

#[test]
fn folding_is_not_accent_insensitive() {
    let folded_cafe = fold_text("cafe");
    let folded_cafe_accent = fold_text("café");
    assert!(
        !folded_cafe_accent
            .windows(folded_cafe.len())
            .any(|window| window == folded_cafe),
        "removing accents would silently match different names"
    );
    assert_ne!(fold_text("й"), fold_text("и"));
}

#[test]
fn folding_is_not_full_case_folding() {
    // Full case folding would map these together; the contract does not.
    assert_ne!(fold_text("ﬁ"), fold_text("fi"));
    assert_ne!(fold_text("İ"), fold_text("i"));
}

#[test]
fn surrogates_pass_through_and_stop_composition() {
    let mut bytes = Vec::new();
    wtf8::from_utf16(&[0x0041, 0xD800, 0x0042], &mut bytes);
    let folded = fold(&bytes);
    assert_eq!(wtf8::to_utf16(&folded), vec![0x0061, 0xD800, 0x0062]);
    // A combining mark before the surrogate must not compose with it.
    let mut with_mark = Vec::new();
    wtf8::from_utf16(&[0xD800, 0x0301], &mut with_mark);
    let folded = fold(&with_mark);
    assert_eq!(wtf8::to_utf16(&folded), vec![0xD800, 0x0301]);
}

#[test]
fn fold_into_appends_without_clearing() {
    let mut out = b"keep:".to_vec();
    fold_into("AB".as_bytes(), &mut out);
    assert_eq!(out, b"keep:ab");
    fold_into(b"", &mut out);
    assert_eq!(out, b"keep:ab");
}

#[test]
fn folded_output_is_normalized_wtf8() {
    let mut bytes = Vec::new();
    wtf8::from_utf16(&[0x0041, 0x030A, 0xD800, 0x2F], &mut bytes);
    let folded = fold(&bytes);
    let mut reencoded = Vec::new();
    let lone = wtf8::from_utf16(&wtf8::to_utf16(&folded), &mut reencoded);
    assert_eq!(reencoded, folded);
    assert!(lone, "the unpaired surrogate survives");
    assert!(folded.contains(&b'/'));
}

#[test]
fn ascii_fast_path_and_slow_path_agree() {
    for text in ["Plain.ASCII", "ÇAĞAÇ", "mixedABCçağ", "İIı", "SS ß ẞ"] {
        assert_eq!(fold_text(text), fold_non_ascii_for_test(text.as_bytes()));
    }
}

fn fold_non_ascii_for_test(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    fold_non_ascii(bytes, &mut out);
    out
}

proptest! {
    #[test]
    fn fold_is_total_idempotent_and_normalized(
        units in prop::collection::vec(
            prop_oneof![
                Just(0x0041u16), Just(0x0061), Just(0x0049), Just(0x0130), Just(0x0131),
                Just(0x03A3), Just(0x03C3), Just(0x03C2), Just(0x1E9E), Just(0x00DF),
                Just(0x00C5), Just(0x212A), Just(0xFB01), Just(0x01C4), Just(0x0301),
                Just(0x030A), Just(0xD800), Just(0xDC00), Just(0xDFFF), Just(0x2F),
                Just(0x4100),
            ],
            0..32
        )
    ) {
        let mut bytes = Vec::new();
        wtf8::from_utf16(&units, &mut bytes);
        let once = fold(&bytes);
        let twice = fold(&once);
        prop_assert_eq!(&once, &twice);
        let mut reencoded = Vec::new();
        wtf8::from_utf16(&wtf8::to_utf16(&once), &mut reencoded);
        prop_assert_eq!(reencoded, once);
    }
}
