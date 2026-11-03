// Design informed by mustafaahci/goz (MIT).

//! Pure spelling rules for the drive device path.
//!
//! `\\.\X:` is how Win32 addresses a volume, and the caller can hand W1's
//! root spelling in several shapes: `C:\`, `c:/`, a bare `C:`, a verbatim
//! `\\?\C:\`. This module owns that translation as a pure function, so the
//! rules are asserted on every OS instead of only inside a Windows binary.
//!
//! Rules:
//!
//! - verbatim drive prefixes `\\?\C:` are accepted and stripped;
//! - `C:` and `C:/` (a drive root) are accepted; a trailing separator is
//!   optional;
//! - a bare `C:` (drive-relative, no tail) is accepted;
//! - a drive-relative tail (`C:some\dir`) is accepted: the handle addresses the
//!   volume, not the drive's current directory, so the tail does not change
//!   which volume is opened;
//! - an absolute path *below* a drive root (`C:\sub`) is rejected, as are UNC
//!   (`\\server\share`), verbatim UNC (`\\?\UNC\...`), device namespace and
//!   relative paths: these FSCTLs address a whole volume and a caller that
//!   needs another volume must pass its root.

use crate::winfs::error::WinfsError;

/// The `\\.\X:` device path for the drive `mount_point` spells.
///
/// `mount_point` is the path as the caller wrote it; `None` is never returned:
/// a spelling this fallback cannot address is [`WinfsError::Unsupported`].
pub fn device_path(mount_point: &str) -> Result<Vec<u16>, WinfsError> {
    let spelling = mount_point.strip_prefix(r"\\?\").unwrap_or(mount_point);
    let bytes = spelling.as_bytes();
    let Some(letter) = bytes.first().copied() else {
        return Err(WinfsError::Unsupported);
    };
    if !letter.is_ascii_alphabetic() || bytes.get(1) != Some(&b':') {
        return Err(WinfsError::Unsupported);
    }
    let rest = &spelling[2..];
    match rest {
        // `C:` or `C:/`: the drive root itself.
        "" | "\\" | "/" => {}
        _ => {
            // An absolute tail is a directory below the root, which this
            // fallback must not silently treat as its volume.
            if rest.starts_with('\\') || rest.starts_with('/') {
                return Err(WinfsError::Unsupported);
            }
            // Otherwise it is a drive-relative tail: the volume is unchanged.
        }
    }
    let mut wide: Vec<u16> = Vec::with_capacity(7);
    wide.extend(r"\\.\".encode_utf16());
    wide.push(u16::from(letter.to_ascii_uppercase()));
    wide.push(u16::from(b':'));
    wide.push(0);
    Ok(wide)
}

#[cfg(test)]
#[path = "volume_path_tests.rs"]
mod volume_path_tests;
