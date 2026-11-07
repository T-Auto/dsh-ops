//! Lexical declaration detection for `grep`'s `definitions` output mode.
//!
//! The mode answers one narrow question — does the matched identifier sit where
//! a declaration names it? — from the physical line alone. There is no parse
//! tree: the classifier reads declaration keywords, modifiers and the line's
//! shape, and the tool documents the limits that follow from that. A miss never
//! proves a declaration is absent; `content` remains the exhaustive mode.
//!
//! This module owns only the decision. Counting, paging and the scan budget stay
//! in [`crate::search`].

/// The declaration verbs a line can use; the value becomes the receipt's `kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Function,
    Method,
    Type,
    Variable,
    Macro,
}

impl Kind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Type => "type",
            Self::Variable => "variable",
            Self::Macro => "macro",
        }
    }
}

const FUNCTION_WORDS: &[&str] = &["function", "fn", "func", "def", "defp", "defmacro", "sub"];
const TYPE_WORDS: &[&str] = &[
    "class",
    "interface",
    "trait",
    "struct",
    "enum",
    "type",
    "namespace",
    "module",
    "record",
    "union",
    "typedef",
    "object",
];
const VARIABLE_WORDS: &[&str] = &["const", "let", "var", "static", "final"];
const MODIFIERS: &[&str] = &[
    "export",
    "default",
    "async",
    "abstract",
    "pub",
    "public",
    "private",
    "protected",
    "readonly",
    "override",
    "unsafe",
    "declare",
    "sealed",
    "virtual",
    "internal",
    "extern",
    "inline",
    "const",
    "static",
    "final",
    "mut",
    "get",
    "set",
];
const CONTROL: &[&str] = &[
    "if",
    "else",
    "for",
    "while",
    "switch",
    "catch",
    "match",
    "when",
    "loop",
    "return",
    "new",
    "throw",
    "await",
    "yield",
    "typeof",
    "sizeof",
    "case",
    "and",
    "or",
    "not",
    "do",
    "try",
    "with",
    "unless",
    "until",
    "foreach",
    "using",
    "lock",
    "synchronized",
];
const PRIMITIVE_TYPES: &[&str] = &[
    "void", "int", "char", "bool", "float", "double", "long", "short", "byte", "string", "str",
    "u8", "u16", "u32", "u64", "u128", "i8", "i16", "i32", "i64", "i128", "usize", "isize", "f32",
    "f64", "any", "unknown", "never", "object", "number", "boolean", "bigint", "symbol", "unit",
];

/// Which language family the file belongs to, so a few constructs can stay
/// precise without turning the classifier into a parser.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Language {
    Go,
    Python,
    Shell,
    Ruby,
    Other,
}

impl Language {
    fn of(extension: &str) -> Self {
        match extension.to_ascii_lowercase().as_str() {
            "go" => Self::Go,
            "py" => Self::Python,
            "sh" | "bash" | "zsh" => Self::Shell,
            "rb" => Self::Ruby,
            _ => Self::Other,
        }
    }

    /// Languages where `name = value` at the start of a line names the value.
    const fn bare_assignment_names(self) -> bool {
        matches!(self, Self::Python | Self::Shell | Self::Ruby)
    }
}

/// True when `line[start..end]` is a whole identifier, not a fragment of a
/// longer one: `get` inside `getUser` is a different identifier.
pub(crate) fn whole_identifier(line: &str, start: usize, end: usize) -> bool {
    let before = line[..start].chars().next_back();
    let after = line[end..].chars().next();
    !before.is_some_and(is_identifier) && !after.is_some_and(is_identifier)
}

fn is_identifier(value: char) -> bool {
    value.is_alphanumeric() || value == '_' || value == '$'
}

/// Classify one matched identifier occurrence.
///
/// `extension` is the file extension without the dot (`ts`, `rs`, `py`, …);
/// `start` and `end` are byte offsets inside `line`. Returns the declaration
/// verb when the occurrence names a declaration, and `None` for a reference,
/// a comment, a string body or an unrecognised shape.
pub(crate) fn classify(extension: &str, line: &str, start: usize, end: usize) -> Option<Kind> {
    if start >= end || !line.is_char_boundary(start) || !line.is_char_boundary(end) {
        return None;
    }
    let trimmed_start = line.len() - line.trim_start().len();
    if start < trimmed_start {
        return None;
    }
    let head = &line[trimmed_start..];
    if head.starts_with("//")
        || head.starts_with("/*")
        || head.starts_with('*')
        || head.starts_with("--")
        || head.starts_with("<!--")
        || head.starts_with('@')
    {
        return None;
    }
    if head.starts_with('#') && !head.starts_with("#[") {
        if head.starts_with("#define") && start > trimmed_start + "#define".len() {
            return Some(Kind::Macro);
        }
        return None;
    }
    if !in_code(line, start) {
        return None;
    }
    let prefix = &line[trimmed_start..start];
    let words = words_before(prefix);
    if let Some(last) = words.last()
        && let Some(kind) = keyword(last)
    {
        if kind == Kind::Variable && function_valued(&line[end..]) {
            return Some(Kind::Function);
        }
        return Some(kind);
    }
    let after = &line[end..];
    let starts_paren = after.trim_start().starts_with('(');
    let ends_brace = line.trim_end().ends_with('{');
    let language = Language::of(extension);
    if starts_paren && language == Language::Go && words.first() == Some(&"func") {
        return Some(Kind::Method);
    }
    // A name that opens the line (or follows only modifiers and a return type)
    // and is followed by a parameter list and a body is a method or function.
    let first_token = prefix.trim().is_empty();
    if starts_paren
        && ends_brace
        && !words.iter().any(|word| CONTROL.contains(word))
        && (first_token || method_head(&words))
    {
        return Some(Kind::Method);
    }
    if first_token && after.trim_start().starts_with('=') {
        if function_valued(after) {
            return Some(Kind::Function);
        }
        if language.bare_assignment_names() {
            return Some(Kind::Variable);
        }
    }
    None
}

fn keyword(word: &str) -> Option<Kind> {
    if FUNCTION_WORDS.contains(&word) {
        Some(Kind::Function)
    } else if TYPE_WORDS.contains(&word) {
        Some(Kind::Type)
    } else if VARIABLE_WORDS.contains(&word) {
        Some(Kind::Variable)
    } else if word == "macro_rules" {
        Some(Kind::Macro)
    } else {
        None
    }
}

/// Words before the identifier, so `export async function foo` and
/// `pub(crate) fn foo` both leave a declaration verb last.
fn words_before(prefix: &str) -> Vec<&str> {
    prefix
        .split(|value: char| !is_identifier(value))
        .filter(|word| !word.is_empty())
        .collect()
}

/// True when only modifiers, a return type or nothing precedes the name.
fn method_head(words: &[&str]) -> bool {
    !words.is_empty()
        && words.iter().all(|word| {
            MODIFIERS.contains(word)
                || PRIMITIVE_TYPES.contains(word)
                || word.chars().next().is_some_and(char::is_uppercase)
        })
}

/// `= (...) =>`, `= function`, `= async`, `= lambda` and the single-argument
/// arrow name a function, so a variable declaration of one is a function.
fn function_valued(after: &str) -> bool {
    let Some(rest) = after.trim_start().strip_prefix('=') else {
        return false;
    };
    let rest = rest.trim_start();
    if rest.starts_with("function")
        || rest.starts_with("async")
        || rest.starts_with("lambda")
        || rest.starts_with("fn ")
    {
        return true;
    }
    if rest.starts_with('(') {
        return rest.contains("=>");
    }
    let word_end = rest
        .find(|value: char| !is_identifier(value))
        .unwrap_or(rest.len());
    rest[word_end..].trim_start().starts_with("=>")
}

/// Whether the byte at `start` is code rather than a comment or string body.
///
/// The scan is line-local: a block comment or template literal that opened on an
/// earlier line cannot be seen, which is one of the limits the tool states.
fn in_code(line: &str, start: usize) -> bool {
    #[derive(Clone, Copy)]
    enum State {
        Code,
        Double,
        Single,
        Backtick,
        BlockComment,
    }
    let bytes = line.as_bytes();
    let mut state = State::Code;
    let mut index = 0;
    while index < start {
        let byte = bytes[index];
        match state {
            State::Code => {
                if byte == b'/' && index + 1 < start && bytes[index + 1] == b'/' {
                    return false;
                }
                if byte == b'/' && index + 1 < start && bytes[index + 1] == b'*' {
                    state = State::BlockComment;
                    index += 2;
                    continue;
                }
                if byte == b'#' && (index + 1 >= start || bytes[index + 1] != b'[') {
                    return false;
                }
                state = match byte {
                    b'"' => State::Double,
                    b'\'' => State::Single,
                    b'`' => State::Backtick,
                    _ => State::Code,
                };
                index += 1;
            }
            State::Double | State::Single | State::Backtick => {
                let closing = match state {
                    State::Double => b'"',
                    State::Single => b'\'',
                    _ => b'`',
                };
                if byte == b'\\' {
                    index += 2;
                    continue;
                }
                if byte == closing {
                    state = State::Code;
                }
                index += 1;
            }
            State::BlockComment => {
                if byte == b'*' && index + 1 < start && bytes[index + 1] == b'/' {
                    state = State::Code;
                    index += 2;
                    continue;
                }
                index += 1;
            }
        }
    }
    matches!(state, State::Code)
}

#[cfg(test)]
#[path = "definitions_tests.rs"]
mod tests;
