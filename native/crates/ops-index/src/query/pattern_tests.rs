use super::*;

#[test]
fn substring_and_prefix_keep_mode_and_needle() {
    let substring = Pattern::substring("Report").expect("valid substring");
    assert_eq!(substring.mode(), MatchMode::Substring);
    assert_eq!(substring.needle(), b"Report");

    let prefix = Pattern::prefix("docs/").expect("valid prefix");
    assert_eq!(prefix.mode(), MatchMode::Prefix);
    assert_eq!(prefix.needle(), b"docs/");
}

#[test]
fn empty_needle_is_rejected_for_both_modes() {
    assert_eq!(Pattern::substring(""), Err(QueryError::EmptyPattern));
    assert_eq!(Pattern::prefix(""), Err(QueryError::EmptyPattern));
    assert_eq!(
        Pattern::from_bytes(&[], MatchMode::Substring),
        Err(QueryError::EmptyPattern)
    );
}

#[test]
fn maximum_length_is_inclusive_and_one_more_is_rejected() {
    let at_limit = vec![b'a'; MAX_PATTERN_BYTES];
    assert!(Pattern::from_bytes(&at_limit, MatchMode::Substring).is_ok());

    let too_long = vec![b'a'; MAX_PATTERN_BYTES + 1];
    assert_eq!(
        Pattern::from_bytes(&too_long, MatchMode::Prefix),
        Err(QueryError::PatternTooLong {
            len: MAX_PATTERN_BYTES + 1,
            max: MAX_PATTERN_BYTES,
        })
    );
}

#[test]
fn nul_byte_is_rejected() {
    assert_eq!(
        Pattern::from_bytes(b"a\0b", MatchMode::Substring),
        Err(QueryError::PatternContainsNul)
    );
}

#[test]
fn needles_keep_their_original_bytes() {
    let folded_later = Pattern::substring("Résumé").expect("valid utf-8 pattern");
    assert_eq!(folded_later.needle(), "Résumé".as_bytes());

    let raw = Pattern::from_bytes(&[0xFF, 0xFE, b'a'], MatchMode::Substring)
        .expect("arbitrary non-NUL bytes are allowed");
    assert_eq!(raw.needle(), &[0xFF, 0xFE, b'a']);
}

#[test]
fn patterns_are_not_folded_at_construction() {
    let pattern = Pattern::substring("ABC").expect("valid");
    assert_eq!(
        pattern.needle(),
        b"ABC",
        "the query's case switch decides folding, not the pattern"
    );
}
