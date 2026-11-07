//! Compute new-file permissions with Windows inheritance, never by copying ACE strings.
use super::{descriptor, sddl, unsupported};
use std::{
    ffi::c_void,
    fs::File,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::null_mut,
};
use windows_permissions::{SecurityDescriptor, constants::SecurityInformation as Info, wrappers};
use windows_sys::Win32::{
    Security::{
        CreatePrivateObjectSecurityEx, DACL_SECURITY_INFORMATION, DestroyPrivateObjectSecurity,
        GENERIC_MAPPING, SE_DACL_AUTO_INHERIT_REQ, SEF_DACL_AUTO_INHERIT, SetKernelObjectSecurity,
        SetSecurityDescriptorControl, UNPROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{
        FILE_ALL_ACCESS, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    },
};

struct InheritedDescriptor(*mut c_void);
impl Drop for InheritedDescriptor {
    fn drop(&mut self) {
        // SAFETY: this pointer is owned exclusively and was allocated by CreatePrivateObjectSecurityEx.
        unsafe {
            DestroyPrivateObjectSecurity(&mut self.0);
        }
    }
}

/// Called only after staging bytes are complete and before create-only publication.
/// Uses the held parent descriptor and the current process token; no privileges are enabled.
pub fn inherit_new_file_dacl(parent: &File, file: &File) -> io::Result<()> {
    let parent_sd = descriptor(parent)?;
    let mut token = null_mut();
    // SAFETY: query-only token request with a live output pointer. Success transfers an owned handle.
    if unsafe {
        winapi::um::processthreadsapi::OpenProcessToken(
            winapi::um::processthreadsapi::GetCurrentProcess(),
            winapi::um::winnt::TOKEN_QUERY,
            &mut token,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the successful call above returned exactly one owned handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    let mut inherited = null_mut();
    // SAFETY: borrowed parent descriptor/token and output storage remain live. No creator ACL means
    // ordinary new-file inheritance, including denies, creator-owner substitution and token defaults.
    if unsafe {
        CreatePrivateObjectSecurityEx(
            &*parent_sd as *const _ as *mut _,
            null_mut(),
            &mut inherited,
            std::ptr::null(),
            0,
            SEF_DACL_AUTO_INHERIT,
            token.as_raw_handle(),
            &mapping,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let inherited = InheritedDescriptor(inherited);
    // SAFETY: a successful allocation returns a valid self-relative security descriptor.
    let expected = unsafe { &*(inherited.0 as *const SecurityDescriptor) };
    let expected_dacl =
        wrappers::ConvertSecurityDescriptorToStringSecurityDescriptor(expected, Info::Dacl)?;
    // Match Metadata::restore: request auto-inherited marking when the computed ACL is applied.
    // SAFETY: the newly allocated descriptor is exclusively owned until the function returns.
    if unsafe {
        SetSecurityDescriptorControl(
            inherited.0,
            SE_DACL_AUTO_INHERIT_REQ,
            SE_DACL_AUTO_INHERIT_REQ,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both handle and descriptor are live. Change only the DACL, preserving owner/group.
    if unsafe {
        SetKernelObjectSecurity(
            file.as_raw_handle(),
            DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
            inherited.0,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let actual = descriptor(file)?;
    let actual_dacl =
        wrappers::ConvertSecurityDescriptorToStringSecurityDescriptor(&actual, Info::Dacl)?;
    if actual_dacl != expected_dacl {
        return Err(unsupported("New-file inherited DACL verification failed"));
    }
    // A concurrent parent permission change invalidates this inheritance snapshot before publication.
    if sddl(&*descriptor(parent)?)? != sddl(&parent_sd)? {
        return Err(unsupported(
            "Parent permissions changed before new-file publication",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::windows::fs::OpenOptionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };
    #[test]
    fn expanded_staging_dacl_never_admits_a_competing_writer() {
        let root = std::env::temp_dir().join(format!(
            "dsh-inherit-share-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(&root)
            .unwrap();
        let mut file = crate::create_private(&parent, "staging").unwrap();
        file.write_all(b"complete bytes").unwrap();
        inherit_new_file_dacl(&parent, &file).unwrap();
        let attempted = std::fs::OpenOptions::new()
            .write(true)
            .open(root.join("staging"));
        assert_eq!(
            attempted.unwrap_err().raw_os_error(),
            Some(32),
            "FILE_SHARE_WRITE must remain excluded after expansion"
        );
        assert_eq!(
            std::fs::read(root.join("staging")).unwrap(),
            b"complete bytes"
        );
        drop(file);
        drop(
            std::fs::OpenOptions::new()
                .write(true)
                .open(root.join("staging"))
                .unwrap(),
        );
        std::fs::remove_file(root.join("staging")).unwrap();
        drop(parent);
        std::fs::remove_dir(root).unwrap();
    }
}
