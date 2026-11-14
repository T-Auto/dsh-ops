//! Keep delete-pending distinct from access denial when opening a lock sidecar.
use super::{IoStatus, NtCreateFile, nt_error};
use std::{
    fs::File,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle},
    ptr::{null, null_mut},
};
use winapi::shared::ntdef::{OBJECT_ATTRIBUTES, UNICODE_STRING};

/// Open or create one non-followed sibling relative to a held directory.
/// Request only ordinary read/write access; deletion and ACL privileges are not
/// needed. Preserve STATUS_DELETE_PENDING as ERROR_DELETE_PENDING (303), since
/// RtlNtStatusToDosError otherwise collapses it into ERROR_ACCESS_DENIED (5).
pub fn open_update_lock(parent: &File, name: &str) -> io::Result<File> {
    if name.is_empty() || name.contains(['/', '\\', ':', '\0']) || name == "." || name == ".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a single sibling name",
        ));
    }
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    let length = u16::try_from(wide.len() * 2)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Sibling name too long"))?;
    let mut unicode = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: wide.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &mut unicode,
        Attributes: 0x40, // OBJ_CASE_INSENSITIVE
        SecurityDescriptor: null_mut(),
        SecurityQualityOfService: null_mut(),
    };
    let mut handle = null_mut();
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    // SAFETY: parent and name storage remain live through the synchronous call.
    // OPEN_IF never truncates; NON_DIRECTORY|OPEN_REPARSE_POINT prevents leaf
    // traversal. The caller checks the returned handle's regular-file metadata.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            0xc0100080, // GENERIC_READ|GENERIC_WRITE|SYNCHRONIZE|FILE_READ_ATTRIBUTES
            &attributes,
            &mut status,
            null(),
            0x80,                     // FILE_ATTRIBUTE_NORMAL
            7,                        // FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE
            3,                        // FILE_OPEN_IF
            0x00200000 | 0x40 | 0x20, // OPEN_REPARSE_POINT|NON_DIRECTORY|SYNCHRONOUS_IO_NONALERT
            null(),
            0,
        )
    };
    if result as u32 == 0xc0000056 {
        // STATUS_DELETE_PENDING
        return Err(io::Error::from_raw_os_error(303));
    }
    if result < 0 {
        return Err(nt_error(result));
    }
    // SAFETY: successful NtCreateFile transferred exactly one owned handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}
