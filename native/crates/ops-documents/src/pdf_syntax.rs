//! Bounded PDF values, shared by classic-object and content-stream parsing. No recovery heuristics.
use ops_protocol::{Failure, Result};
use std::collections::BTreeMap;
pub const MAX_NODES: usize = 100_000;
pub const MAX_STRING: usize = 1024 * 1024;
pub type Dict = BTreeMap<Vec<u8>, Value>;
#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Integer(i64),
    Number(f64),
    Name(Vec<u8>),
    String(Vec<u8>),
    Array(Vec<Value>),
    Dict(Dict),
    Ref(u32, u16),
}
impl Value {
    pub fn integer(&self) -> Result<usize> {
        match self {
            Self::Integer(n) if *n >= 0 && *n <= u32::MAX as i64 => Ok(*n as usize),
            _ => Err(bad("Expected a bounded nonnegative PDF integer")),
        }
    }
    pub fn dict(&self) -> Result<&Dict> {
        match self {
            Self::Dict(d) => Ok(d),
            _ => Err(bad("Expected a PDF dictionary")),
        }
    }
    pub fn name(&self) -> Result<&[u8]> {
        match self {
            Self::Name(n) => Ok(n),
            _ => Err(bad("Expected a PDF name")),
        }
    }
}
pub fn bad(message: impl ToString) -> Failure {
    Failure::new("DOCUMENT_PARSE_ERROR", message)
}
pub fn unsupported(message: impl ToString) -> Failure {
    Failure::new("UNSUPPORTED_DOCUMENT", message)
}
pub fn limit(message: &str) -> Failure {
    Failure::new("OUTPUT_LIMIT", message)
}
pub fn white(b: u8) -> bool {
    matches!(b, 0 | 9 | 10 | 12 | 13 | 32)
}
fn delimiter(b: u8) -> bool {
    white(b) || b"()<>[]{}/%".contains(&b)
}
fn hex(b: u8) -> Result<u8> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(bad("Invalid PDF hexadecimal digit")),
    }
}
pub struct Lexer<'a> {
    pub data: &'a [u8],
    pub at: usize,
    pub nodes: usize,
}
impl<'a> Lexer<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            at: 0,
            nodes: 0,
        }
    }
    pub fn skip(&mut self) {
        loop {
            while self.at < self.data.len() && white(self.data[self.at]) {
                self.at += 1
            }
            if self.data.get(self.at) != Some(&b'%') {
                break;
            }
            while self.at < self.data.len() && !matches!(self.data[self.at], 10 | 13) {
                self.at += 1
            }
        }
    }
    pub fn word(&mut self) -> Result<&'a [u8]> {
        self.skip();
        let start = self.at;
        while self.at < self.data.len() && !delimiter(self.data[self.at]) {
            self.at += 1;
            if self.at - start > 256 {
                return Err(limit("PDF token exceeds 256 bytes"));
            }
        }
        if self.at == start {
            return Err(bad("Expected a PDF keyword"));
        }
        Ok(&self.data[start..self.at])
    }
    pub fn keyword(&mut self, expected: &[u8]) -> Result<()> {
        if self.word()? != expected {
            return Err(bad(format!(
                "Expected PDF keyword {}",
                String::from_utf8_lossy(expected)
            )));
        }
        Ok(())
    }
    pub fn unsigned(&mut self) -> Result<usize> {
        let token = self.word()?;
        if !token.iter().all(u8::is_ascii_digit) || token.len() > 10 {
            return Err(bad("Invalid bounded PDF integer"));
        }
        std::str::from_utf8(token)
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n <= u32::MAX as usize)
            .ok_or_else(|| bad("PDF integer overflow"))
    }
    fn string(&mut self) -> Result<Vec<u8>> {
        self.at += 1;
        let mut output = Vec::new();
        let mut depth = 1;
        while let Some(&b) = self.data.get(self.at) {
            self.at += 1;
            match b {
                b'(' => {
                    depth += 1;
                    if depth > 64 {
                        return Err(limit("PDF string nesting exceeds 64"));
                    }
                    output.push(b)
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(output);
                    }
                    output.push(b)
                }
                b'\\' => {
                    let b = *self
                        .data
                        .get(self.at)
                        .ok_or_else(|| bad("Unclosed PDF string escape"))?;
                    self.at += 1;
                    match b {
                        b'n' => output.push(10),
                        b'r' => output.push(13),
                        b't' => output.push(9),
                        b'b' => output.push(8),
                        b'f' => output.push(12),
                        10 => {}
                        13 => {
                            if self.data.get(self.at) == Some(&10) {
                                self.at += 1
                            }
                        }
                        b'0'..=b'7' => {
                            let mut value = (b - b'0') as u16;
                            for _ in 0..2 {
                                if let Some(b'0'..=b'7') = self.data.get(self.at) {
                                    value = value * 8 + (self.data[self.at] - b'0') as u16;
                                    self.at += 1
                                } else {
                                    break;
                                }
                            }
                            output.push(value as u8)
                        }
                        _ => output.push(b),
                    }
                }
                13 => {
                    if self.data.get(self.at) == Some(&10) {
                        self.at += 1
                    }
                    output.push(10)
                }
                _ => output.push(b),
            }
            if output.len() > MAX_STRING {
                return Err(limit("PDF string exceeds 1 MiB"));
            }
        }
        Err(bad("Unclosed PDF literal string"))
    }
    /// A name is a token, not a policy decision.
    ///
    /// `/Prev` and `/XRefStm` only describe an incremental update while they are
    /// trailer keys, and an outline item legitimately carries `/Prev` as its
    /// previous sibling. Those two are therefore refused where a trailer is read
    /// (`pdf_container::parse`), not here; `/Encrypt`, `/ObjStm` and `/XRef`
    /// stay refused at the token because no supported structure can hold them.
    fn name(&mut self) -> Result<Vec<u8>> {
        self.at += 1;
        let mut name = Vec::new();
        while let Some(&b) = self.data.get(self.at) {
            if delimiter(b) {
                break;
            }
            self.at += 1;
            let decoded = if b == b'#' {
                if self.data.len() - self.at < 2 {
                    return Err(bad("Incomplete PDF name escape"));
                }
                let b = hex(self.data[self.at])? * 16 + hex(self.data[self.at + 1])?;
                self.at += 2;
                b
            } else {
                b
            };
            if decoded == 0 {
                return Err(bad("PDF names cannot contain NUL"));
            }
            name.push(decoded);
            if name.len() > 256 {
                return Err(limit("PDF name exceeds 256 bytes"));
            }
        }
        if matches!(name.as_slice(), b"Encrypt" | b"ObjStm" | b"XRef") {
            return Err(unsupported(
                "Encrypted, incremental, object-stream and xref-stream PDFs are unsupported",
            ));
        }
        Ok(name)
    }
    pub fn value(&mut self, depth: usize) -> Result<Value> {
        if depth > 64 {
            return Err(limit("PDF object nesting exceeds 64"));
        }
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(limit("PDF metadata exceeds 100000 values"));
        }
        self.skip();
        match self
            .data
            .get(self.at)
            .copied()
            .ok_or_else(|| bad("Missing PDF value"))?
        {
            b'/' => Ok(Value::Name(self.name()?)),
            b'(' => Ok(Value::String(self.string()?)),
            b'<' => {
                self.at += 1;
                if self.data.get(self.at) == Some(&b'<') {
                    self.at += 1;
                    let mut dict = Dict::new();
                    loop {
                        self.skip();
                        if self.data.get(self.at..self.at + 2) == Some(b">>") {
                            self.at += 2;
                            return Ok(Value::Dict(dict));
                        }
                        if self.data.get(self.at) != Some(&b'/') {
                            return Err(bad("PDF dictionary key is not a name"));
                        }
                        let key = self.name()?;
                        if dict.contains_key(&key) {
                            return Err(bad("Duplicate PDF dictionary keys are ambiguous"));
                        }
                        if dict.len() >= 4096 {
                            return Err(limit("PDF dictionary exceeds 4096 keys"));
                        }
                        let value = self.value(depth + 1)?;
                        dict.insert(key, value);
                    }
                } else {
                    let mut output = Vec::new();
                    let mut high = None;
                    loop {
                        let b = *self
                            .data
                            .get(self.at)
                            .ok_or_else(|| bad("Unclosed PDF hex string"))?;
                        self.at += 1;
                        if b == b'>' {
                            if let Some(high) = high {
                                output.push(high * 16)
                            }
                            if output.len() > MAX_STRING {
                                return Err(limit("PDF hex string exceeds 1 MiB"));
                            }
                            return Ok(Value::String(output));
                        }
                        if white(b) {
                            continue;
                        }
                        let digit = hex(b)?;
                        if let Some(h) = high.take() {
                            output.push(h * 16 + digit)
                        } else {
                            high = Some(digit)
                        }
                        if output.len() > MAX_STRING {
                            return Err(limit("PDF hex string exceeds 1 MiB"));
                        }
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut values = Vec::new();
                loop {
                    self.skip();
                    if self.data.get(self.at) == Some(&b']') {
                        self.at += 1;
                        return Ok(Value::Array(values));
                    }
                    values.push(self.value(depth + 1)?)
                }
            }
            _ => {
                let token = self.word()?;
                match token {
                    b"null" => Ok(Value::Null),
                    b"true" => Ok(Value::Bool(true)),
                    b"false" => Ok(Value::Bool(false)),
                    _ => {
                        if !token
                            .iter()
                            .all(|b| b.is_ascii_digit() || b"+-.".contains(b))
                        {
                            return Err(bad("Invalid PDF value token"));
                        }
                        let number = std::str::from_utf8(token)
                            .ok()
                            .and_then(|s| s.parse::<f64>().ok())
                            .filter(|n| n.is_finite())
                            .ok_or_else(|| bad("Invalid PDF number"))?;
                        let saved = self.at;
                        if token.iter().all(u8::is_ascii_digit)
                            && number <= 10000.0
                            && number.fract() == 0.0
                        {
                            if let Ok(generation) = self.unsigned()
                                && generation <= 65535
                                && self.word().is_ok_and(|w| w == b"R")
                            {
                                return Ok(Value::Ref(number as u32, generation as u16));
                            }
                            self.at = saved;
                        }
                        if !token.contains(&b'.') {
                            let integer = std::str::from_utf8(token)
                                .ok()
                                .and_then(|s| s.parse::<i64>().ok())
                                .ok_or_else(|| bad("PDF integer overflow"))?;
                            Ok(Value::Integer(integer))
                        } else {
                            Ok(Value::Number(number))
                        }
                    }
                }
            }
        }
    }
}
