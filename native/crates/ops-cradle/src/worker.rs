//! Data validation runs on a replaceable worker, never on the Job ownership thread.
use serde_json::Value;
use std::{io, path::Path};
pub struct Launch {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}
pub fn prepare(value: Value) -> io::Result<Launch> {
    let invalid = || io::Error::other("invalid cradle launch request");
    let argv = value["argv"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|arg| {
            arg.as_str()
                .filter(|s| !s.contains('\0'))
                .map(String::from)
                .ok_or_else(invalid)
        })
        .collect::<io::Result<Vec<_>>>()?;
    if argv.is_empty() || argv.len() > 4096 || !Path::new(&argv[0]).is_absolute() {
        return Err(invalid());
    }
    let cwd = value["cwd"]
        .as_str()
        .filter(|s| !s.contains('\0') && Path::new(s).is_absolute())
        .ok_or_else(invalid)?
        .to_owned();
    let mut env = value["env"]
        .as_object()
        .ok_or_else(invalid)?
        .iter()
        .map(|(key, value)| {
            let value = value.as_str().ok_or_else(invalid)?;
            if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                return Err(invalid());
            }
            Ok((key.clone(), value.to_owned()))
        })
        .collect::<io::Result<Vec<_>>>()?;
    env.sort_by_key(|(key, _)| key.to_uppercase());
    if env
        .windows(2)
        .any(|pair| pair[0].0.eq_ignore_ascii_case(&pair[1].0))
    {
        return Err(invalid());
    }
    Ok(Launch { argv, cwd, env })
}
