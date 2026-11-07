//! CSV/TSV record state machine; quoted fields retain exact embedded LF/CRLF text.
use crate::decode::Decoder;
use ops_protocol::{Failure, Result};
use std::io::Read;
pub const MAX_COLUMNS: usize = 1024;
const MAX_RECORD_BYTES: usize = 1024 * 1024;
pub struct Record {
    pub cells: Vec<String>,
    pub first: usize,
    pub last: usize,
}
fn malformed(message: &str, line: usize) -> Failure {
    let mut error = Failure::new(
        "TABLE_PARSE_ERROR",
        format!("{message} at physical line {line}"),
    );
    error.next_action = "Inspect the reported record and correct CSV/TSV quoting or column counts; preceding complete rows remain observations.".into();
    error
}
pub fn next<R: Read>(input: &mut Decoder<R>, delimiter: char) -> Result<Option<Record>> {
    let first = input.line;
    let mut cells = Vec::new();
    let mut field = String::new();
    let (mut quoted, mut closed, mut started, mut count) = (false, false, false, 0usize);
    loop {
        let line = input.line;
        let character = input.next()?;
        let Some(character) = character else {
            if quoted {
                return Err(malformed("Unclosed quoted field", line));
            }
            if !started {
                return Ok(None);
            }
            cells.push(field);
            return Ok(Some(Record {
                cells,
                first,
                last: line,
            }));
        };
        started = true;
        count += character.len_utf8();
        if count > MAX_RECORD_BYTES {
            return Err(Failure::new(
                "OUTPUT_LIMIT",
                "One decoded table record exceeds 1 MiB",
            ));
        }
        if quoted {
            if character == '"' {
                quoted = false;
                closed = true;
            } else {
                field.push(character);
            }
            continue;
        }
        if character == '"' {
            if closed {
                field.push('"');
                quoted = true;
                closed = false;
            } else if field.is_empty() {
                quoted = true;
            } else {
                return Err(malformed("Quote inside unquoted field", line));
            }
        } else if character == delimiter {
            cells.push(std::mem::take(&mut field));
            closed = false;
            if cells.len() >= MAX_COLUMNS {
                return Err(Failure::new(
                    "OUTPUT_LIMIT",
                    "One table record exceeds 1024 columns",
                ));
            }
        } else if character == '\n' || character == '\r' {
            if character == '\r' && input.next()? != Some('\n') {
                return Err(malformed(
                    "Bare CR outside quoted field; use LF or CRLF records",
                    line,
                ));
            }
            cells.push(field);
            return Ok(Some(Record {
                cells,
                first,
                last: line,
            }));
        } else if closed {
            return Err(malformed("Unexpected character after closing quote", line));
        } else {
            field.push(character);
        }
    }
}
