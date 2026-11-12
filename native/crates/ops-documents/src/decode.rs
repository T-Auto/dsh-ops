//! Strict streaming Unicode decoding. Invalid bytes/surrogates are never replaced.
use ops_protocol::{Failure, Result};
use sha2::{Digest, Sha256};
use std::io::{BufReader, Read};
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
#[derive(Clone, Copy)]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}
impl Encoding {
    pub fn parse(name: &str) -> Result<Self> {
        match name.to_ascii_lowercase().as_str() {
            "utf-8" => Ok(Self::Utf8),
            "utf-16le" => Ok(Self::Utf16Le),
            "utf-16be" => Ok(Self::Utf16Be),
            _ => Err(invalid(
                "Supported table encodings: utf-8, utf-16le, utf-16be",
            )),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf16Le => "utf-16le",
            Self::Utf16Be => "utf-16be",
        }
    }
}
fn invalid(message: &str) -> Failure {
    Failure::new("ERR_INVALID_ENCODING", message)
}
struct Tracked<R> {
    input: R,
    bytes: usize,
    hash: Sha256,
}
impl<R: Read> Read for Tracked<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let room = buffer.len().min((MAX_BYTES + 1).saturating_sub(self.bytes));
        let count = self.input.read(&mut buffer[..room])?;
        self.bytes += count;
        self.hash.update(&buffer[..count]);
        Ok(count)
    }
}
pub struct Decoder<R> {
    input: BufReader<Tracked<R>>,
    encoding: Encoding,
    first: bool,
    consumed: usize,
    prefix: [u8; 3],
    prefix_len: usize,
    prefix_at: usize,
    pub line: usize,
}
impl<R: Read> Decoder<R> {
    pub fn new(input: R, encoding: Encoding) -> Result<Self> {
        let mut decoder = Self {
            input: BufReader::new(Tracked {
                input,
                bytes: 0,
                hash: Sha256::new(),
            }),
            encoding,
            first: true,
            consumed: 0,
            prefix: [0; 3],
            prefix_len: 0,
            prefix_at: 0,
            line: 1,
        };
        while decoder.prefix_len < 3 {
            let count = decoder
                .input
                .read(&mut decoder.prefix[decoder.prefix_len..])?;
            if count == 0 {
                break;
            }
            decoder.prefix_len += count;
        }
        let prefix = &decoder.prefix[..decoder.prefix_len];
        let mismatch = (prefix.starts_with(&[0xef, 0xbb, 0xbf])
            && !matches!(encoding, Encoding::Utf8))
            || (prefix.starts_with(&[0xff, 0xfe]) && !matches!(encoding, Encoding::Utf16Le))
            || (prefix.starts_with(&[0xfe, 0xff]) && !matches!(encoding, Encoding::Utf16Be));
        if mismatch {
            return Err(invalid("Table BOM conflicts with the requested encoding"));
        }
        Ok(decoder)
    }
    pub fn bytes_read(&self) -> usize {
        self.input.get_ref().bytes
    }
    pub fn revision(&self) -> String {
        format!("{:x}", self.input.get_ref().hash.clone().finalize())
    }
    fn byte(&mut self) -> Result<Option<u8>> {
        let mut byte = [0];
        if self.prefix_at < self.prefix_len {
            byte[0] = self.prefix[self.prefix_at];
            self.prefix_at += 1;
        } else if self.input.read(&mut byte)? == 0 {
            return Ok(None);
        }
        self.consumed += 1;
        if self.consumed > MAX_BYTES {
            return Err(Failure::new(
                "OUTPUT_LIMIT",
                "Table scan reached the 32 MiB byte limit",
            ));
        }
        Ok(Some(byte[0]))
    }
    fn required(&mut self) -> Result<u8> {
        self.byte()?
            .ok_or_else(|| invalid("Incomplete Unicode sequence at end of table"))
    }
    fn unit(&mut self) -> Result<Option<u16>> {
        let Some(first) = self.byte()? else {
            return Ok(None);
        };
        let second = self.required()?;
        Ok(Some(match self.encoding {
            Encoding::Utf16Le => u16::from_le_bytes([first, second]),
            _ => u16::from_be_bytes([first, second]),
        }))
    }
    pub fn next(&mut self) -> Result<Option<char>> {
        let character = match self.encoding {
            Encoding::Utf8 => {
                let Some(first) = self.byte()? else {
                    return Ok(None);
                };
                let width = match first {
                    0..=0x7f => 1,
                    0xc2..=0xdf => 2,
                    0xe0..=0xef => 3,
                    0xf0..=0xf4 => 4,
                    _ => return Err(invalid("Invalid UTF-8 table bytes")),
                };
                let mut bytes = [0; 4];
                bytes[0] = first;
                for byte in bytes.iter_mut().take(width).skip(1) {
                    *byte = self.required()?;
                }
                std::str::from_utf8(&bytes[..width])
                    .map_err(|_| invalid("Invalid UTF-8 table bytes"))?
                    .chars()
                    .next()
                    .unwrap()
            }
            Encoding::Utf16Le | Encoding::Utf16Be => {
                let Some(first) = self.unit()? else {
                    return Ok(None);
                };
                if (0xd800..=0xdbff).contains(&first) {
                    let second = self
                        .unit()?
                        .ok_or_else(|| invalid("Unpaired UTF-16 high surrogate"))?;
                    if !(0xdc00..=0xdfff).contains(&second) {
                        return Err(invalid("Invalid UTF-16 surrogate pair"));
                    }
                    char::from_u32(
                        0x10000 + ((u32::from(first) - 0xd800) << 10) + u32::from(second) - 0xdc00,
                    )
                    .unwrap()
                } else {
                    char::from_u32(u32::from(first))
                        .ok_or_else(|| invalid("Unpaired UTF-16 low surrogate"))?
                }
            }
        };
        if self.first {
            self.first = false;
            if character == '\u{fffe}' {
                return Err(invalid("Table BOM conflicts with the requested byte order"));
            }
            if character == '\u{feff}' {
                return self.next();
            }
        }
        if character == '\n' {
            self.line += 1;
        }
        Ok(Some(character))
    }
}
