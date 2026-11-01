//! Windows-only FFI boundary. Callers supply owned/borrowed file handles; no
//! model paths, shells, privilege enabling, or publication policy live here.
#![cfg(windows)]
use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle},
    ptr::{addr_of_mut, null_mut},
};
use winapi::shared::ntdef::{OBJECT_ATTRIBUTES, UNICODE_STRING};
use windows_permissions::{
    LocalBox, SecurityDescriptor,
    constants::{AceFlags, AceType, SeObjectType::SE_FILE_OBJECT, SecurityInformation as Info},
    wrappers,
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Security::{
        GetSecurityDescriptorControl, SetKernelObjectSecurity, SetSecurityDescriptorControl,
    },
    Storage::FileSystem::{
        FILE_BASIC_INFO, FILE_STREAM_INFO, FileBasicInfo, FileStreamInfo,
        GetFileInformationByHandleEx, SetFileInformationByHandle,
    },
};

#[repr(C)]
struct IoStatus {
    status: usize,
    information: usize,
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        handle: *mut HANDLE,
        access: u32,
        attributes: *const OBJECT_ATTRIBUTES,
        status: *mut IoStatus,
        size: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *const c_void,
        ea_length: u32,
    ) -> i32;
    fn NtQueryInformationFile(
        handle: HANDLE,
        status: *mut IoStatus,
        information: *mut c_void,
        length: u32,
        class: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}
fn unsupported(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, message)
}
fn nt_error(status: i32) -> io::Error {
    // SAFETY: total scalar conversion, no pointer arguments.
    io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
}
fn info() -> Info {
    Info::Owner | Info::Group | Info::Dacl
}
fn descriptor(file: &File) -> io::Result<LocalBox<SecurityDescriptor>> {
    wrappers::GetSecurityInfo(file, SE_FILE_OBJECT, info())
}
fn sddl(sd: &SecurityDescriptor) -> io::Result<std::ffi::OsString> {
    wrappers::ConvertSecurityDescriptorToStringSecurityDescriptor(sd, info())
}
fn control(sd: &SecurityDescriptor) -> io::Result<u16> {
    let mut flags = 0;
    let mut revision = 0;
    // SAFETY: sd is an OS-allocated valid descriptor, output scalars are live.
    if unsafe { GetSecurityDescriptorControl(sd as *const _ as *mut _, &mut flags, &mut revision) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    // DACL present/defaulted, auto-inherit requested/inherited, protected.
    Ok(flags & 0x150f)
}

/// CREATE_NEW relative to a held directory, with a protected current-process
/// user DACL at creation, before any bytes can be written. No inherited grants.
pub fn create_private(parent: &File, name: &str) -> io::Result<File> { create_private_object(parent, name, false, None) }
/// A private cache directory, created relative to an already-held directory.
pub fn create_cache_object(parent: &File, name: &str, directory: bool, write_sid: Option<&str>) -> io::Result<File> {
    if let Some(capability) = write_sid {
        let _ = private_descriptor(Some(capability))?;
        // The envelope names the host's exact private-temp capability, and the held
        // parent must already grant it. Never synthesize workspace/public grants.
        let inherited = sddl(&*descriptor(parent)?)?.to_string_lossy().split('(').any(|ace| {
            let parts: Vec<_> = ace.trim_end_matches(')').split(';').collect();
            if parts.len() != 6 || parts[0] != "A" || parts[5] != capability { return false; }
            let mask = if parts[2] == "FA" { 0x1f01ff } else { u32::from_str_radix(parts[2].trim_start_matches("0x"), 16).unwrap_or(0) };
            mask & 0x116 == 0x116
        });
        if !inherited { return Err(unsupported("Cache parent lacks the trusted private-temp write capability")); }
    }
    create_private_object(parent, name, directory, write_sid)
}
fn private_descriptor(write_sid: Option<&str>) -> io::Result<LocalBox<SecurityDescriptor>> {
    let sid = windows_permissions::utilities::current_process_sid()?;
    let extra = match write_sid {
        None => String::new(),
        Some(capability) => {
            let parts: Vec<_> = capability.split('-').collect();
            if parts.len() != 6 || parts[..3] != ["S", "1", "4"] || parts[5] != "1"
                || !parts[3..5].iter().all(|part| part.parse::<u32>().is_ok_and(|value| value > 0 && value < 1 << 30 && value.to_string() == *part)) {
                return Err(unsupported("Expected the host's private-temp capability SID"));
            }
            format!("(A;;FA;;;{capability})")
        }
    };
    format!("D:P(A;;FA;;;{sid}){extra}").parse()
}
fn create_private_object(parent: &File, name: &str, directory: bool, write_sid: Option<&str>) -> io::Result<File> {
    if name.is_empty() || name.contains(['/', '\\', ':', '\0']) || name == "." || name == ".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a single sibling name",
        ));
    }
    let private = private_descriptor(write_sid)?;
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
        SecurityDescriptor: &*private as *const _ as *mut _,
        SecurityQualityOfService: null_mut(),
    };
    let mut handle = null_mut();
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    // SAFETY: parent is borrowed for the syscall; unicode and descriptor storage
    // outlive the call. FILE_CREATE is exclusive; NON_DIRECTORY|OPEN_REPARSE_POINT
    // forbids traversal of the leaf. The returned handle is adopted exactly once.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            0xc00f0000 | 0x00100000, // GENERIC_READ|WRITE, STANDARD_RIGHTS_ALL, SYNCHRONIZE
            &attributes,
            &mut status,
            std::ptr::null(),
            if directory { 0x10 } else { 0x80 }, // DIRECTORY or NORMAL
            7,                        // FILE_SHARE_READ|WRITE|DELETE
            2,                        // FILE_CREATE (never overwrite)
            0x00200000 | (if directory { 0x1 } else { 0x40 }) | 0x20, // no-follow, object kind, synchronous
            std::ptr::null(),
            0,
        )
    };
    if result < 0 {
        return Err(nt_error(result));
    }
    // SAFETY: successful NtCreateFile transferred one live owned file handle.
    let file = unsafe { File::from_raw_handle(handle) };
    let verified = verify_cache(&file, write_sid);
    if let Err(error) = verified {
        let _ = discard(&file);
        return Err(error);
    }
    Ok(file)
}

/// Cache objects are private to the current user plus exactly the trusted temp capability.
pub fn verify_cache(file: &File, write_sid: Option<&str>) -> io::Result<()> {
    let private = private_descriptor(write_sid)?;
    let actual = descriptor(file)?;
    let actual_dacl = sddl(&actual)?.to_string_lossy().split("D:").nth(1).unwrap_or("").replace("AI", "");
    let expected = sddl(&private)?.to_string_lossy().into_owned();
    if actual_dacl != expected.trim_start_matches("D:") { return Err(unsupported("Private creation DACL verification failed")); }
    Ok(())
}

/// The protected-DACL bit, the one control flag that stops a file from inheriting.
const SE_DACL_PROTECTED_BIT: u16 = 0x1000;
/// FILE_ALL_ACCESS, the mask this crate grants the calling process.
const FILE_ALL_ACCESS: u32 = 0x1f01ff;

/// Windows maps generic rights to the object type's specific rights while it
/// propagates an inheritable ACE, so a directory entry spelled `GA` reaches a file
/// as `FA` and `SDGXGWGR` as `0x1301bf`. Both sides of every comparison are reduced
/// through the file mapping first; otherwise a correctly inherited generic entry
/// reads as a missing one.
fn specific_mask(mask: u32) -> u32 {
    use windows_sys::Win32::Security::{GENERIC_MAPPING, MapGenericMask};
    let mapping = GENERIC_MAPPING {
        GenericRead: 0x0012_0089,    // FILE_GENERIC_READ
        GenericWrite: 0x0012_0116,   // FILE_GENERIC_WRITE
        GenericExecute: 0x0012_00a0, // FILE_GENERIC_EXECUTE
        GenericAll: FILE_ALL_ACCESS,
    };
    let mut value = mask;
    // SAFETY: MapGenericMask only reads the mapping and rewrites the scalar mask.
    unsafe { MapGenericMask(&mut value, &mapping) };
    value
}

/// One DACL entry as a comparable fact: type, specific access mask, SID.
fn entries(sd: &SecurityDescriptor) -> Vec<(AceType, u32, String)> {
    let Some(dacl) = sd.dacl() else { return Vec::new() };
    (0..dacl.len())
        .filter_map(|index| dacl.get_ace(index))
        .filter_map(|ace| Some((ace.ace_type(), specific_mask(ace.mask().bits()), ace.sid()?.to_string())))
        .collect()
}

/// Every entry a file child inherits from its directory: the ones carrying
/// OBJECT_INHERIT_ACE. Container-only entries never reach a file, and inheriting
/// them would grant more than the directory asked for.
fn inheritable_grants(sd: &SecurityDescriptor) -> Vec<(AceType, u32, String)> {
    let Some(dacl) = sd.dacl() else { return Vec::new() };
    (0..dacl.len())
        .filter_map(|index| dacl.get_ace(index))
        .filter(|ace| ace.flags().contains(AceFlags::ObjectInherit))
        .filter_map(|ace| Some((ace.ace_type(), specific_mask(ace.mask().bits()), ace.sid()?.to_string())))
        .collect()
}

/// Give a just-created object the entries its directory would have inherited into it,
/// while the calling process keeps explicit full control. The written DACL stays
/// unprotected, so later directory changes keep propagating, and a directory deny
/// entry survives because the operating system merges the set instead of this crate
/// rebuilding it. The caller must not use this for a replaced file: that path keeps
/// the target's own descriptor.
pub fn adopt_parent_dacl(parent: &File, child: &File) -> io::Result<()> {
    let sid = windows_permissions::utilities::current_process_sid()?;
    let granted: LocalBox<SecurityDescriptor> = format!("D:(A;;FA;;;{sid})").parse()?;
    let acl = granted
        .dacl()
        .ok_or_else(|| unsupported("Adopted descriptor lost its DACL"))?;
    let mut handle = child.try_clone()?;
    // UNPROTECTED is what makes the system recompute this DACL from the directory:
    // the inherited entries arrive as inherited ACEs, not as copies this crate chose.
    wrappers::SetSecurityInfo(
        &mut handle,
        SE_FILE_OBJECT,
        Info::Dacl | Info::UnprotectedDacl,
        None,
        None,
        Some(acl),
        None,
    )?;
    verify_adopted(parent, child)
}

/// Fail closed unless the object now carries the directory's inheritable entries and
/// the caller's explicit full control, and is no longer protected.
fn verify_adopted(parent: &File, child: &File) -> io::Result<()> {
    let adopted = descriptor(child)?;
    if control(&adopted)? & SE_DACL_PROTECTED_BIT != 0 {
        return Err(unsupported(
            "Adopted DACL is still protected; the created file cannot inherit",
        ));
    }
    let caller = windows_permissions::utilities::current_process_sid()?;
    let mut explicit_caller = false;
    if let Some(dacl) = adopted.dacl() {
        for index in 0..dacl.len() {
            let Some(ace) = dacl.get_ace(index) else { continue };
            let Some(sid) = ace.sid() else { continue };
            if *sid == *caller
                && !ace.flags().contains(AceFlags::Inherited)
                && ace.mask().bits() == FILE_ALL_ACCESS
            {
                explicit_caller = true;
            }
        }
    }
    if !explicit_caller {
        return Err(unsupported(
            "Adopted DACL lost the caller's explicit full control",
        ));
    }
    let present = entries(&adopted);
    let directory = descriptor(parent)?;
    for grant in inheritable_grants(&directory) {
        if !present.contains(&grant) {
            return Err(unsupported(
                "Adopted DACL is missing a directory grant the file should inherit",
            ));
        }
    }
    Ok(())
}

/// Captures mandatory security and supported basic metadata. Named streams,
/// extended attributes, EFS/compression/sparse/other special storage fail closed.
pub struct Metadata {
    sd: LocalBox<SecurityDescriptor>,
    basic: FILE_BASIC_INFO,
}
impl Metadata {
    pub fn capture(file: &File) -> io::Result<Self> {
        // SAFETY: zero is a valid initial output struct; API writes its full size.
        let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                addr_of_mut!(basic).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if basic.FileAttributes & !(0x1 | 0x2 | 0x4 | 0x20 | 0x80 | 0x100 | 0x2000) != 0 {
            return Err(unsupported(
                "Special Windows storage attributes are not supported",
            ));
        }
        // SAFETY: aligned buffer is writable for its advertised byte size. The
        // only accepted record is one fixed, bounded unnamed data stream.
        let mut streams = vec![0u64; 8192];
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileStreamInfo,
                streams.as_mut_ptr().cast(),
                (streams.len() * 8) as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(234 | 122)) {
                return Err(unsupported(
                    "Windows stream metadata exceeds the bounded capture budget",
                ));
            }
            return Err(error);
        }
        // SAFETY: the aligned allocation holds a full FILE_STREAM_INFO; Windows
        // returned success, and name length/next offset are checked before use.
        let stream = unsafe { &*streams.as_ptr().cast::<FILE_STREAM_INFO>() };
        if stream.NextEntryOffset != 0 || stream.StreamNameLength != 14 {
            return Err(unsupported("Named Windows streams are not supported"));
        }
        // SAFETY: 14 name bytes fit in the 64KiB allocation after the fixed header.
        let name = unsafe { std::slice::from_raw_parts(stream.StreamName.as_ptr(), 7) };
        if name != "::$DATA".encode_utf16().collect::<Vec<_>>() {
            return Err(unsupported("Unknown Windows stream metadata"));
        }
        let mut ea_size = 0u32;
        let mut status = IoStatus {
            status: 0,
            information: 0,
        };
        // SAFETY: FileEaInformation (7) writes one ULONG into ea_size.
        let result = unsafe {
            NtQueryInformationFile(
                file.as_raw_handle(),
                &mut status,
                addr_of_mut!(ea_size).cast(),
                4,
                7,
            )
        };
        if result < 0 {
            return Err(nt_error(result));
        }
        if ea_size != 0 {
            return Err(unsupported("Windows extended attributes are not supported"));
        }
        Ok(Self {
            sd: descriptor(file)?,
            basic,
        })
    }
    pub fn readonly(&self) -> bool {
        self.basic.FileAttributes & 1 != 0
    }
    pub fn restore(&self, file: &File) -> io::Result<()> {
        let original_control = control(&self.sd)?;
        let mut working: LocalBox<SecurityDescriptor> =
            sddl(&self.sd)?.to_string_lossy().parse()?;
        // SAFETY: working is freshly allocated and exclusively owned here.
        // AR is an input request consumed by the kernel into AI.
        if unsafe {
            SetSecurityDescriptorControl(
                &mut *working as *mut _ as *mut _,
                0x0100,
                if original_control & 0x0400 != 0 {
                    0x0100
                } else {
                    0
                },
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: borrowed handle and OS-owned valid descriptor. No privilege is
        // enabled; inability to restore a different owner aborts publication.
        let result = unsafe {
            SetKernelObjectSecurity(
                file.as_raw_handle(),
                info().bits(),
                &mut *working as *mut _ as *mut _,
            )
        };
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: FILE_BASIC_INFO is fully initialized and borrowed for the call.
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileBasicInfo,
                &self.basic as *const _ as *const _,
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        self.verify(file)
    }
    pub fn verify(&self, file: &File) -> io::Result<()> {
        let actual = descriptor(file)?;
        if actual.owner() != self.sd.owner()
            || actual.group() != self.sd.group()
            || sddl(&actual)? != sddl(&self.sd)?
            || control(&actual)? != control(&self.sd)?
        {
            return Err(unsupported(
                "Windows owner/group/DACL/control preservation verification failed",
            ));
        }
        // SAFETY: fixed-size initialized output for the borrowed live handle.
        let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                addr_of_mut!(basic).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if basic.FileAttributes != self.basic.FileAttributes
            || basic.CreationTime != self.basic.CreationTime
            || basic.LastWriteTime != self.basic.LastWriteTime
        {
            return Err(unsupported("Windows basic metadata verification failed"));
        }
        Ok(())
    }
}

/// Remove only the link associated with this staged handle, even if captured
/// readonly attributes were restored. Other hardlinks keep their attributes.
pub fn discard(file: &File) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FileDispositionInfoEx,
    };
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    // SAFETY: borrowed live DELETE-capable staging handle; initialized fixed-size
    // input. This unlinks its own staging name, never changes inode permissions.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfoEx,
            &disposition as *const _ as *const _,
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
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

    fn canonical_dacl(sd: &SecurityDescriptor) -> String {
        // Auto-inherited describes how an ACL was computed; P still prevents
        // inheritance and every ACE must match. create_private verifies the same.
        wrappers::ConvertSecurityDescriptorToStringSecurityDescriptor(sd, Info::Dacl)
            .unwrap().to_string_lossy().replace("D:PAI", "D:P")
    }

    #[test]
    fn dacl_comparison_normalizes_sid_aliases_without_accepting_other_grants() {
        let canonical = |text: &str| {
            let sd: LocalBox<SecurityDescriptor> = text.parse().unwrap();
            canonical_dacl(&sd)
        };
        assert_eq!(canonical("D:P(A;;FA;;;S-1-5-18)"), canonical("D:P(A;;FA;;;SY)"));
        assert_eq!(canonical("D:PAI(A;;FA;;;SY)"), canonical("D:P(A;;FA;;;SY)"));
        assert_ne!(canonical("D:P(A;;FA;;;SY)"), canonical("D:P(A;;FA;;;SY)(A;;FR;;;WD)"));
        assert_ne!(canonical("D:P(A;;FA;;;SY)"), canonical("D:(A;;FA;;;SY)"));
    }

    #[test]
    fn staging_is_private_before_bytes_and_exclusive() {
        let root = std::env::temp_dir().join(format!(
            "dsh-metadata-{}-{}",
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
        let mut file = create_private(&parent, "private").unwrap();
        let sd = descriptor(&file).unwrap();
        let sid = windows_permissions::utilities::current_process_sid().unwrap();
        // Windows may render well-known/account SIDs as SDDL aliases. Compare
        // the exact canonical DACL, not a numeric SID's spelling in full SDDL.
        let expected: LocalBox<SecurityDescriptor> = format!("D:P(A;;FA;;;{sid})").parse().unwrap();
        assert_eq!(canonical_dacl(&sd), canonical_dacl(&expected));
        assert_eq!(file.metadata().unwrap().len(), 0);
        assert_eq!(
            create_private(&parent, "private").unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        file.write_all(b"private bytes").unwrap();
        assert!(create_private(&parent, "../escape").is_err());
        discard(&file).unwrap();
        drop(file);
        drop(parent);
        assert!(!root.join("private").exists());
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn a_created_file_adopts_directory_grants_and_keeps_the_caller_ace() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
        let temporary = std::env::temp_dir();
        let root = temporary.join(format!(
            "dsh-adopt-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sid = windows_permissions::utilities::current_process_sid().unwrap();
        // A distinctive inheritable grant: Remote Desktop Users may read this
        // directory and everything created inside it. No temporary directory grants
        // that entry, so its presence in the child can only come from this fixture.
        let distinctive = "S-1-5-32-555";
        // A sandboxed caller may only create children where the host's own write
        // capability is granted, so the fixture carries the temporary directory's
        // capability entries too. This is test scaffolding, not part of the subject.
        let mut capability = String::new();
        {
            let ambient = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(0x02000000)
                .open(&temporary)
                .unwrap();
            let ambient_sd = descriptor(&ambient).unwrap();
            let Some(dacl) = ambient_sd.dacl() else { unreachable!() };
            for index in 0..dacl.len() {
                let Some(ace) = dacl.get_ace(index) else { continue };
                let Some(ace_sid) = ace.sid() else { continue };
                let name = ace_sid.to_string();
                if name.starts_with("S-1-4-") {
                    capability.push_str(&format!("(A;OICI;0x{:08x};;;{name})", ace.mask().bits()));
                }
            }
        }
        let directory_sd: LocalBox<SecurityDescriptor> =
            format!("D:(A;;FA;;;{sid})(A;OICI;FR;;;{distinctive})(A;OICIIO;GA;;;AU){capability}")
                .parse()
                .unwrap();
        // Create the fixture directory WITH its descriptor: this process cannot rewrite
        // a directory DACL it did not create, and a creation-time descriptor needs none.
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: &*directory_sd as *const _ as *mut _,
            bInheritHandle: 0,
        };
        let wide: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: NUL-terminated path and a live SECURITY_ATTRIBUTES whose descriptor
        // outlives the call; the directory is created once and never replaced.
        assert_ne!(
            unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) },
            0,
            "fixture directory creation failed"
        );
        let parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(&root)
            .unwrap();
        let mut file = create_private(&parent, "adopted").unwrap();
        // Staging is private before the bytes exist; that half must not change.
        assert_ne!(
            control(&descriptor(&file).unwrap()).unwrap() & SE_DACL_PROTECTED_BIT,
            0,
            "a staged object starts private"
        );
        file.write_all(b"adopted bytes").unwrap();
        adopt_parent_dacl(&parent, &file).unwrap();
        let adopted = descriptor(&file).unwrap();
        assert_eq!(
            control(&adopted).unwrap() & SE_DACL_PROTECTED_BIT,
            0,
            "the adopted DACL must not stay protected"
        );
        let child = entries(&adopted);
        assert!(
            child
                .iter()
                .any(|(_, _, ace_sid)| ace_sid.as_str() == distinctive),
            "the directory's inheritable grant must reach the created file: {:?}",
            sddl(&adopted)
        );
        let dacl = adopted.dacl().unwrap();
        assert!(
            (0..dacl.len())
                .filter_map(|index| dacl.get_ace(index))
                .any(|ace| ace
                    .sid()
                    .is_some_and(|ace_sid| *ace_sid == *sid)
                    && !ace.flags().contains(AceFlags::Inherited)
                    && ace.mask().bits() == FILE_ALL_ACCESS),
            "the caller keeps one explicit full-control entry"
        );
        let parent_sd = descriptor(&parent).unwrap();
        // Generic directory rights must be compared as the specific rights Windows
        // propagates: `GA` reaches the file as full control. Comparing the stored
        // spelling instead reports a correctly inherited entry as missing.
        assert!(
            inheritable_grants(&parent_sd)
                .iter()
                .any(|(_, mask, ace_sid)| ace_sid == "S-1-5-11" && *mask == FILE_ALL_ACCESS),
            "a generic directory grant is compared as the specific mask: {:?}",
            inheritable_grants(&parent_sd)
        );
        for grant in inheritable_grants(&parent_sd) {
            assert!(child.contains(&grant), "every inheritable directory entry must arrive: {grant:?}");
        }
        // Generic rights are mapped while they propagate: the directory's `GA` entry
        // reaches the file as full control, and the comparison above must not read the
        // spelling difference as a missing grant.
        assert!(
            child.iter().any(|(kind, mask, ace_sid)| *kind == AceType::ACCESS_ALLOWED_ACE_TYPE
                && *mask == FILE_ALL_ACCESS
                && ace_sid == "S-1-5-11"),
            "the directory's generic full-control entry must arrive as full control: {:?}",
            sddl(&adopted)
        );
        discard(&file).unwrap();
        drop(file);
        drop(parent);
        assert!(!root.join("adopted").exists());
        std::fs::remove_dir(root).unwrap();
    }
}
