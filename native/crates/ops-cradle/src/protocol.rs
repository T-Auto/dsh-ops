//! Private, length-prefixed protocol. Command output is never parsed as control.
use serde_json::Value;
use std::io::{self, Read, Write};
pub const MAX_FRAME: usize = 1024 * 1024;
pub fn read(input: &mut impl Read) -> io::Result<Option<Value>> {
    let mut size = [0; 4];
    match input.read(&mut size[..1])? {
        0 => return Ok(None),
        _ => input.read_exact(&mut size[1..])?,
    }
    let length = u32::from_le_bytes(size) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid cradle frame length",
        ));
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(io::Error::other)
}
pub fn write(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME {
        return Err(io::Error::other("cradle frame too large"));
    }
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(DIGITS[(byte >> 4) as usize] as char);
        text.push(DIGITS[(byte & 15) as usize] as char);
    }
    text
}
