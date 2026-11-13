use ops_process::shell::Launch;
use serde_json::Value;
use std::{io, path::PathBuf, time::Duration};

pub(super) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
pub(super) fn text<'a>(value: &'a Value, name: &str, limit: usize) -> io::Result<&'a str> {
    value[name]
        .as_str()
        .filter(|value| value.len() <= limit && !value.contains('\0'))
        .ok_or_else(|| invalid(&format!("invalid task {name}")))
}
pub(super) fn id(value: &Value, name: &str) -> io::Result<String> {
    let value = text(value, name, 128)?;
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid("invalid task identity"));
    }
    Ok(value.to_owned())
}
pub(super) fn number(value: &Value, name: &str, min: u64, max: u64) -> io::Result<u64> {
    value[name]
        .as_u64()
        .filter(|value| (min..=max).contains(value))
        .ok_or_else(|| invalid(&format!("invalid task {name}")))
}
pub(super) fn duration(value: &Value, name: &str) -> io::Result<Duration> {
    let millis = value[name]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= 2_147_483_647.0)
        .ok_or_else(|| invalid(&format!("invalid task {name}")))?;
    Ok(Duration::from_secs_f64(millis / 1000.0))
}
pub(super) fn launch(value: &Value) -> io::Result<Launch> {
    let argv = value["argv"]
        .as_array()
        .filter(|values| !values.is_empty())
        .ok_or_else(|| invalid("invalid task argv"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.contains('\0'))
                .map(Into::into)
                .ok_or_else(|| invalid("invalid task argument"))
        })
        .collect::<io::Result<Vec<_>>>()?;
    let cwd = PathBuf::from(text(value, "cwd", 32767)?);
    if !cwd.is_absolute() {
        return Err(invalid("task cwd must be absolute"));
    }
    let env = value["env"]
        .as_object()
        .ok_or_else(|| invalid("invalid task environment"))?
        .iter()
        .map(|(name, value)| {
            value
                .as_str()
                .map(|value| (name.into(), value.into()))
                .ok_or_else(|| invalid("invalid task environment value"))
        })
        .collect::<io::Result<Vec<_>>>()?;
    Ok(Launch {
        argv,
        cwd,
        env,
        output_cap: 64000,
    })
}
pub(super) fn admission(value: &Value) -> io::Result<()> {
    match value["decision"].as_str() {
        Some("launch") => {
            launch(&value["launch"])?;
        }
        Some("reject") => {
            text(&value["error"], "code", 128)?;
            text(&value["error"], "message", 4096)?;
        }
        _ => return Err(invalid("invalid task admission decision")),
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
