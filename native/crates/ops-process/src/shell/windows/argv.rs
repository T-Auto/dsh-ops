use std::{
    cmp::Ordering,
    ffi::{OsStr, OsString},
    io,
    os::windows::ffi::OsStrExt,
};
use windows_sys::Win32::Globalization::CompareStringOrdinal;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub(super) fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut units: Vec<u16> = value.encode_wide().collect();
    if units.contains(&0) {
        return Err(invalid("embedded NUL in Windows string"));
    }
    units.push(0);
    Ok(units)
}

pub(super) fn command_line(argv: &[OsString]) -> io::Result<Vec<u16>> {
    if argv.is_empty() || argv[0].is_empty() {
        return Err(invalid("missing executable"));
    }
    let mut output = Vec::new();
    for (index, argument) in argv.iter().enumerate() {
        let units = wide(argument)?;
        let units = &units[..units.len() - 1];
        if index == 0 && units.contains(&34) {
            return Err(invalid("quote in executable name"));
        }
        if index > 0 {
            output.push(32);
        }
        output.push(34);
        if index == 0 {
            // The CRT parses argv[0] specially: backslashes do not escape its closing quote.
            output.extend_from_slice(units);
        } else {
            let mut slashes = 0;
            for &unit in units {
                if unit == 92 {
                    slashes += 1;
                    continue;
                }
                output.extend(std::iter::repeat_n(
                    92,
                    slashes * if unit == 34 { 2 } else { 1 },
                ));
                if unit == 34 {
                    output.push(92);
                }
                output.push(unit);
                slashes = 0;
            }
            output.extend(std::iter::repeat_n(92, slashes * 2));
        }
        output.push(34);
        if output.len() >= 32_767 {
            return Err(invalid("Windows command line exceeds 32767 UTF-16 units"));
        }
    }
    output.push(0);
    Ok(output)
}

fn ordinal(left: &[u16], right: &[u16]) -> io::Result<Ordering> {
    let left_len = i32::try_from(left.len()).map_err(|_| invalid("environment name too long"))?;
    let right_len = i32::try_from(right.len()).map_err(|_| invalid("environment name too long"))?;
    // SAFETY: both explicit-length UTF-16 slices remain valid; ordinal comparison is locale-free.
    match unsafe { CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) } {
        1 => Ok(Ordering::Less),
        2 => Ok(Ordering::Equal),
        3 => Ok(Ordering::Greater),
        _ => Err(io::Error::last_os_error()),
    }
}

pub(super) fn environment(environment: &[(OsString, OsString)]) -> io::Result<Vec<u16>> {
    let mut entries = Vec::with_capacity(environment.len());
    for (name, value) in environment {
        let mut name = wide(name)?;
        name.pop();
        let drive = name.len() == 3
            && name[0] == 61
            && name[2] == 58
            && ((65..=90).contains(&name[1]) || (97..=122).contains(&name[1]));
        if name.is_empty() || (name.contains(&61) && !drive) {
            return Err(invalid("invalid environment variable name"));
        }
        entries.push((name, wide(value)?));
    }
    let mut failure = None;
    entries.sort_by(|left, right| {
        ordinal(&left.0, &right.0).unwrap_or_else(|error| {
            failure = Some(error);
            Ordering::Equal
        })
    });
    if let Some(error) = failure {
        return Err(error);
    }
    for pair in entries.windows(2) {
        if ordinal(&pair[0].0, &pair[1].0)? == Ordering::Equal {
            return Err(invalid("duplicate environment variable name"));
        }
    }
    let mut output = Vec::new();
    for (name, value) in entries {
        output.extend(name);
        output.push(61);
        output.extend(value);
    }
    if output.is_empty() {
        output.push(0);
    }
    output.push(0);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStringExt;

    fn line(arguments: &[&str]) -> String {
        let line = command_line(
            &arguments
                .iter()
                .map(|value| OsString::from(*value))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        String::from_utf16(&line[..line.len() - 1]).unwrap()
    }

    #[test]
    fn command_line_quotes_msvc_arguments_without_changing_their_units() {
        assert_eq!(
            line(&[r"C:\Program Files\app.exe", "", "a b", "a\tb"]),
            "\"C:\\Program Files\\app.exe\" \"\" \"a b\" \"a\tb\""
        );
        assert_eq!(
            line(&["app", "a\"b", "a\\\"b", "a\\", "\\\\"]),
            "\"app\" \"a\\\"b\" \"a\\\\\\\"b\" \"a\\\\\" \"\\\\\\\\\""
        );
        assert_eq!(line(&["C:\\"]), "\"C:\\\"");
        let raw = OsString::from_wide(&[0xd800, 92]);
        assert_eq!(
            command_line(&["app".into(), raw]).unwrap(),
            vec![34, 97, 112, 112, 34, 32, 34, 0xd800, 92, 92, 34, 0]
        );
    }

    #[test]
    fn command_line_rejects_ambiguous_or_oversized_input() {
        for argv in [
            vec![],
            vec!["".into()],
            vec!["a\"b".into()],
            vec!["app".into(), "a\0b".into()],
        ] {
            assert!(command_line(&argv).is_err());
        }
        assert_eq!(
            command_line(&[OsString::from("a".repeat(32_764))])
                .unwrap()
                .len(),
            32_767
        );
        assert!(command_line(&[OsString::from("a".repeat(32_765))]).is_err());
        assert!(wide(OsStr::new("a\0b")).is_err());
    }

    #[test]
    fn environment_is_unicode_sorted_and_double_terminated() {
        assert_eq!(environment(&[]).unwrap(), vec![0, 0]);
        let entries = [
            ("z", "last"),
            ("ä", "unicode"),
            ("Path", "first"),
            ("=C:", r"C:\"),
        ];
        let block = environment(&entries.map(|(key, value)| (key.into(), value.into()))).unwrap();
        assert_eq!(
            String::from_utf16(&block).unwrap(),
            "=C:=C:\\\0Path=first\0z=last\0ä=unicode\0\0"
        );
        let raw = OsString::from_wide(&[0xdc00]);
        assert_eq!(
            environment(&[("x".into(), raw)]).unwrap(),
            vec![120, 61, 0xdc00, 0, 0]
        );
    }

    #[test]
    fn environment_rejects_duplicate_names_and_invalid_delimiters() {
        for entries in [
            vec![("PATH", "a"), ("Path", "b")],
            vec![("ä", "a"), ("Ä", "b")],
            vec![("", "")],
            vec![("a=b", "")],
            vec![("a\0b", "")],
            vec![("a", "b\0c")],
        ] {
            assert!(
                environment(
                    &entries
                        .into_iter()
                        .map(|(key, value)| (key.into(), value.into()))
                        .collect::<Vec<_>>()
                )
                .is_err()
            );
        }
    }
}
