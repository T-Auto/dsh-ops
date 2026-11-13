use ops_process::shell::Launch;
use serde_json::Value;
use std::{io, path::PathBuf};

pub(super) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
pub(super) fn text<'a>(value: &'a Value, name: &str, limit: usize) -> io::Result<&'a str> {
    value[name]
        .as_str()
        .filter(|value| value.len() <= limit && !value.contains('\0'))
        .ok_or_else(|| invalid(&format!("invalid shell {name}")))
}
pub(super) fn id(value: &Value, name: &str) -> io::Result<String> {
    let value = text(value, name, 128)?;
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid("invalid shell identity"));
    }
    Ok(value.to_owned())
}
pub(super) fn number(value: &Value, name: &str, min: u64, max: u64) -> io::Result<u64> {
    value[name]
        .as_u64()
        .filter(|value| (min..=max).contains(value))
        .ok_or_else(|| invalid(&format!("invalid shell {name}")))
}
pub(super) fn launch(value: &Value) -> io::Result<Launch> {
    let argv = value["argv"]
        .as_array()
        .filter(|values| !values.is_empty())
        .ok_or_else(|| invalid("invalid shell launch argv"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.contains('\0'))
                .map(Into::into)
                .ok_or_else(|| invalid("invalid shell launch argument"))
        })
        .collect::<io::Result<Vec<_>>>()?;
    let cwd = PathBuf::from(text(value, "cwd", 32767)?);
    if !cwd.is_absolute() {
        return Err(invalid("shell cwd must be absolute"));
    }
    let env = value["env"]
        .as_object()
        .ok_or_else(|| invalid("invalid shell environment"))?
        .iter()
        .map(|(name, value)| {
            value
                .as_str()
                .map(|value| (name.into(), value.into()))
                .ok_or_else(|| invalid("invalid shell environment value"))
        })
        .collect::<io::Result<Vec<_>>>()?;
    Ok(Launch {
        argv,
        cwd,
        env,
        output_cap: 4096,
    })
}
pub(super) fn admission(value: &Value, has_shell: bool) -> io::Result<()> {
    match value["decision"].as_str() {
        Some("reuse") if has_shell => {}
        Some("launch") if !has_shell => {
            launch(&value["launch"])?;
            if !value["closeAfter"].is_boolean() {
                return Err(invalid("missing closeAfter"));
            }
        }
        Some("retire") => {}
        Some("reject") => {
            text(&value["error"], "code", 128)?;
            text(&value["error"], "message", 4096)?;
        }
        _ => return Err(invalid("unexpected shell admission decision")),
    }
    if !value["commandCwd"].is_null()
        && !PathBuf::from(text(value, "commandCwd", 32767)?).is_absolute()
    {
        return Err(invalid("command cwd must be absolute"));
    }
    Ok(())
}
pub(super) fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            output.push(if index > chunk.len() {
                '='
            } else {
                ALPHABET[((word >> (18 - index * 6)) & 63) as usize] as char
            });
        }
    }
    output
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base64_uses_canonical_padding_and_binary_bytes() {
        for (bytes, encoded) in [
            (b"".as_slice(), ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (&[0, 255, 128], "AP+A"),
        ] {
            assert_eq!(base64(bytes), encoded);
        }
    }
}
