//! Read-only, handle-relative directory lookup with kernel reparse refusal.
use super::{IoStatus, NtCreateFile, nt_error};
use std::{
    fs::File,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle},
    ptr::{null, null_mut},
};
use winapi::shared::ntdef::{OBJECT_ATTRIBUTES, UNICODE_STRING};

/// Open one existing directory below a held anchor. The name must already have
/// passed the caller's lexical/policy checks. Refuse separators so callers cannot
/// bypass read-access checks on intermediate directories with a combined lookup.
/// OBJ_DONT_REPARSE refuses directory links and all other reparse points.
/// No create, backup privilege, ACL change, ambient path or retry is involved.
pub fn open_directory_no_reparse(parent: &File, name: &str) -> io::Result<File> {
    if name.is_empty() || name.contains(['/', '\\', ':', '\0']) || name == "." || name == ".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected one relative directory component",
        ));
    }
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    let length = u16::try_from(wide.len() * 2)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Directory name too long"))?;
    let mut unicode = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &mut unicode,
        Attributes: 0x40 | 0x1000, // OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE
        SecurityDescriptor: null_mut(),
        SecurityQualityOfService: null_mut(),
    };
    let mut handle = null_mut();
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    // SAFETY: the borrowed directory and name storage outlive the synchronous
    // call. FILE_OPEN never creates; DIRECTORY_FILE rejects a non-directory.
    // No OPEN_REPARSE_POINT override: final and intermediate reparses both fail.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            0x00120089, // READ_CONTROL | SYNCHRONIZE | LIST_DIRECTORY | READ_EA | READ_ATTRIBUTES
            &attributes,
            &mut status,
            null(),
            0,
            3,          // SHARE_READ | SHARE_WRITE; retain cap-std's no-delete directory lease
            1,          // FILE_OPEN
            0x1 | 0x20, // DIRECTORY_FILE | SYNCHRONOUS_IO_NONALERT
            null(),
            0,
        )
    };
    if result < 0 {
        return Err(nt_error(result));
    }
    // SAFETY: successful NtCreateFile transfers exactly one live owned handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::windows::fs::OpenOptionsExt,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn relative_lookup_refuses_junctions_and_combined_paths() {
        let root = std::env::temp_dir().join(format!(
            "ops-noreparse-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("plain/child")).unwrap();
        let parent = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(&root)
            .unwrap();
        let opened = open_directory_no_reparse(&parent, "plain").unwrap();
        assert!(opened.metadata().unwrap().is_dir());
        drop(opened);
        let junction = root.join("alias");
        assert!(
            Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(&junction)
                .arg(root.join("plain"))
                .output()
                .unwrap()
                .status
                .success()
        );
        let final_result = open_directory_no_reparse(&parent, "alias")
            .map(drop)
            .map_err(|error| error.raw_os_error());
        let combined_result = open_directory_no_reparse(&parent, "plain/child")
            .map(drop)
            .map_err(|error| error.kind());
        fs::remove_dir(&junction).unwrap();
        drop(parent);
        fs::remove_dir(root.join("plain/child")).unwrap();
        fs::remove_dir(root.join("plain")).unwrap();
        fs::remove_dir(&root).unwrap();
        assert_eq!(
            final_result,
            Err(Some(4395)),
            "final junction must not be followed"
        );
        assert_eq!(
            combined_result,
            Err(io::ErrorKind::InvalidInput),
            "combined paths must not bypass per-ancestor access checks"
        );
    }
}
