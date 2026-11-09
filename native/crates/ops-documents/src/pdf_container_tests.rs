//! Private container details that no public read path reaches: the literal-string lexer.
use super::*;

#[test]
fn literal_strings_escapes_line_endings_and_odd_hex_are_exact() {
    let mut lexer = Lexer::new(b"(a\\n\\r\\t\\b\\f\\(b\\)\\134\\101\\\r\nc\r\nd)");
    assert!(
        matches!(lexer.value(0).unwrap(), Value::String(v) if v == b"a\n\r\t\x08\x0c(b)\\Ac\nd")
    );
    let mut lexer = Lexer::new(b"<123>");
    assert!(matches!(lexer.value(0).unwrap(), Value::String(v) if v == [0x12, 0x30]));
    assert!(Lexer::new(b"1.0").value(0).unwrap().integer().is_err());
    assert!(Lexer::new(b"+1").value(0).unwrap().integer().is_ok());
}
