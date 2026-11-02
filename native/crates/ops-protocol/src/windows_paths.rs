//! Windows component restrictions also apply when a fixed Linux worker serves Windows UNC paths.
use crate::{Failure, Result};
pub fn validate_name(name: &str) -> Result<()> {
    let base = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let port = base.strip_prefix("COM").or_else(|| base.strip_prefix("LPT"));
    if name.ends_with(['.', ' ']) || name.contains([':', '*', '?', '<', '>', '|', '"', '\\'])
        || matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || port.is_some_and(|p| matches!(p, "1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"¹"|"²"|"³"))
    { return Err(Failure::new("INVALID_ARGUMENT", format!("Reserved, ambiguous or device path component {name:?}"))); }
    Ok(())
}
