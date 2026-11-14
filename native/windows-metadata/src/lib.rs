//! Windows-only FFI boundary. Callers supply owned/borrowed file handles; no
//! model paths, shells, privilege enabling, or publication policy live here.
#![cfg(windows)]
mod inheritance;
mod update_lock;
pub use inheritance::inherit_new_file_dacl;
use std::{
    ffi::c_void,
    fs::File,
    io,
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle},
    ptr::{addr_of_mut, null_mut},
};
pub use update_lock::open_update_lock;
use winapi::shared::ntdef::{OBJECT_ATTRIBUTES, UNICODE_STRING};
use windows_permissions::{
    LocalBox, SecurityDescriptor,
    constants::{SeObjectType::SE_FILE_OBJECT, SecurityInformation as Info},
    wrappers,
};
use windows_sys::Win32::{
    Foundation::HANDLE,
    Security::{
        GetSecurityDescriptorControl, SetKernelObjectSecurity, SetSecurityDescriptorControl,
    },
    Storage::FileSystem::{
        FILE_BASIC_INFO, FILE_STREAM_INFO, FileBasicInfo, FileStreamInfo,
        GetFileInformationByHandleEx, GetVolumeInformationByHandleW, SetFileInformationByHandle,
    },
    System::SystemServices::{
        FILE_NAMED_STREAMS, FILE_PERSISTENT_ACLS, FILE_SUPPORTS_EXTENDED_ATTRIBUTES,
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

/// Metadata capabilities reported by the volume itself, rather than inferred
/// from an operation's errno after the fact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VolumeCapabilities {
    flags: u32,
}
impl VolumeCapabilities {
    pub fn query(file: &File) -> io::Result<Self> {
        let mut flags = 0;
        // SAFETY: every optional output except the flags pointer is null; the
        // handle is borrowed and flags is a live u32 for the duration of the call.
        if unsafe {
            GetVolumeInformationByHandleW(
                file.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                &mut flags,
                null_mut(),
                0,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { flags })
    }
    pub fn named_streams(self) -> bool {
        self.flags & FILE_NAMED_STREAMS != 0
    }
    pub fn persistent_acls(self) -> bool {
        self.flags & FILE_PERSISTENT_ACLS != 0
    }
    pub fn extended_attributes(self) -> bool {
        self.flags & FILE_SUPPORTS_EXTENDED_ATTRIBUTES != 0
    }
    pub fn warnings(self) -> Vec<String> {
        let mut warnings = Vec::new();
        if !self.named_streams() {
            warnings.push(
                "Volume does not support named streams; no alternate stream metadata exists to preserve"
                    .into(),
            );
        }
        if !self.extended_attributes() {
            warnings.push(
                "Volume does not support extended attributes; no extended-attribute metadata exists to preserve"
                    .into(),
            );
        }
        if !self.persistent_acls() {
            warnings.push(
                "Volume does not support persistent ACLs; owner/group/DACL metadata is unavailable"
                    .into(),
            );
        }
        warnings
    }
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

/// CREATE_NEW relative to a held directory. On volumes with persistent ACLs,
/// creation uses a protected current-process user DACL before any bytes can be
/// written. ACL-less volumes cannot provide that isolation and report it through
/// the publication metadata warnings instead.
pub fn create_private(parent: &File, name: &str) -> io::Result<File> {
    // Exclude FILE_SHARE_WRITE for the entire publication lifetime, including after
    // the final DACL is restored/expanded. Readers and hard-link/rename cleanup remain allowed.
    let capabilities = VolumeCapabilities::query(parent)?;
    create_private_object(parent, name, false, None, 5, capabilities.persistent_acls())
}
/// A private cache directory, created relative to an already-held directory.
pub fn create_cache_object(
    parent: &File,
    name: &str,
    directory: bool,
    write_sid: Option<&str>,
) -> io::Result<File> {
    if let Some(capability) = write_sid {
        let _ = private_descriptor(Some(capability))?;
        // The envelope names the host's exact private-temp capability, and the held
        // parent must already grant it. Never synthesize workspace/public grants.
        let inherited = sddl(&*descriptor(parent)?)?
            .to_string_lossy()
            .split('(')
            .any(|ace| {
                let parts: Vec<_> = ace.trim_end_matches(')').split(';').collect();
                if parts.len() != 6 || parts[0] != "A" || parts[5] != capability {
                    return false;
                }
                let mask = if parts[2] == "FA" {
                    0x1f01ff
                } else {
                    u32::from_str_radix(parts[2].trim_start_matches("0x"), 16).unwrap_or(0)
                };
                mask & 0x116 == 0x116
            });
        if !inherited {
            return Err(unsupported(
                "Cache parent lacks the trusted private-temp write capability",
            ));
        }
    }
    create_private_object(parent, name, directory, write_sid, 7, true)
}
fn private_descriptor(write_sid: Option<&str>) -> io::Result<LocalBox<SecurityDescriptor>> {
    let sid = windows_permissions::utilities::current_process_sid()?;
    let extra = match write_sid {
        None => String::new(),
        Some(capability) => {
            let parts: Vec<_> = capability.split('-').collect();
            if parts.len() != 6
                || parts[..3] != ["S", "1", "4"]
                || parts[5] != "1"
                || !parts[3..5].iter().all(|part| {
                    part.parse::<u32>().is_ok_and(|value| {
                        value > 0 && value < 1 << 30 && value.to_string() == *part
                    })
                })
            {
                return Err(unsupported(
                    "Expected the host's private-temp capability SID",
                ));
            }
            format!("(A;;FA;;;{capability})")
        }
    };
    format!("D:P(A;;FA;;;{sid}){extra}").parse()
}
fn create_private_object(
    parent: &File,
    name: &str,
    directory: bool,
    write_sid: Option<&str>,
    share: u32,
    private_security: bool,
) -> io::Result<File> {
    if name.is_empty() || name.contains(['/', '\\', ':', '\0']) || name == "." || name == ".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected a single sibling name",
        ));
    }
    let private = if private_security {
        Some(private_descriptor(write_sid)?)
    } else {
        None
    };
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
        SecurityDescriptor: private
            .as_ref()
            .map_or(null_mut(), |sd| &**sd as *const _ as *mut _),
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
            share, // publication excludes WRITE; cache retains READ|WRITE|DELETE
            2,     // FILE_CREATE (never overwrite)
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
    let verified = if private_security {
        verify_cache(&file, write_sid)
    } else {
        Ok(())
    };
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
    let actual_dacl = sddl(&actual)?
        .to_string_lossy()
        .split("D:")
        .nth(1)
        .unwrap_or("")
        .replace("AI", "");
    let expected = sddl(&private)?.to_string_lossy().into_owned();
    if actual_dacl != expected.trim_start_matches("D:") {
        return Err(unsupported("Private creation DACL verification failed"));
    }
    Ok(())
}

/// Captures security and basic metadata supported by the source volume. Metadata
/// that genuinely exists but cannot be preserved still fails closed; capabilities
/// absent from the volume are reported as warnings instead.
pub struct Metadata {
    sd: Option<LocalBox<SecurityDescriptor>>,
    basic: FILE_BASIC_INFO,
    warnings: Vec<String>,
}
impl Metadata {
    pub fn capture(file: &File) -> io::Result<Self> {
        let capabilities = VolumeCapabilities::query(file)?;
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
        if capabilities.named_streams() {
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
        }
        if capabilities.extended_attributes() {
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
        }
        Ok(Self {
            sd: if capabilities.persistent_acls() {
                Some(descriptor(file)?)
            } else {
                None
            },
            basic,
            warnings: capabilities.warnings(),
        })
    }
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }
    pub fn has_persistent_acls(&self) -> bool {
        self.sd.is_some()
    }
    pub fn readonly(&self) -> bool {
        self.basic.FileAttributes & 1 != 0
    }
    pub fn restore(&self, file: &File) -> io::Result<()> {
        if let Some(sd) = &self.sd {
            let original_control = control(sd)?;
            let mut working: LocalBox<SecurityDescriptor> = sddl(sd)?.to_string_lossy().parse()?;
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
        if let Some(sd) = &self.sd {
            let actual = descriptor(file)?;
            if actual.owner() != sd.owner()
                || actual.group() != sd.group()
                || sddl(&actual)? != sddl(sd)?
                || control(&actual)? != control(sd)?
            {
                return Err(unsupported(
                    "Windows owner/group/DACL/control preservation verification failed",
                ));
            }
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
            .unwrap()
            .to_string_lossy()
            .replace("D:PAI", "D:P")
    }

    #[test]
    fn dacl_comparison_normalizes_sid_aliases_without_accepting_other_grants() {
        let canonical = |text: &str| {
            let sd: LocalBox<SecurityDescriptor> = text.parse().unwrap();
            canonical_dacl(&sd)
        };
        assert_eq!(
            canonical("D:P(A;;FA;;;S-1-5-18)"),
            canonical("D:P(A;;FA;;;SY)")
        );
        assert_eq!(canonical("D:PAI(A;;FA;;;SY)"), canonical("D:P(A;;FA;;;SY)"));
        assert_ne!(
            canonical("D:P(A;;FA;;;SY)"),
            canonical("D:P(A;;FA;;;SY)(A;;FR;;;WD)")
        );
        assert_ne!(canonical("D:P(A;;FA;;;SY)"), canonical("D:(A;;FA;;;SY)"));
    }

    #[test]
    fn volume_flags_select_queries_and_warnings_without_errno_guesses() {
        let all = VolumeCapabilities {
            flags: FILE_NAMED_STREAMS | FILE_PERSISTENT_ACLS | FILE_SUPPORTS_EXTENDED_ATTRIBUTES,
        };
        assert!(all.named_streams());
        assert!(all.persistent_acls());
        assert!(all.extended_attributes());
        assert!(all.warnings().is_empty());

        let basic = VolumeCapabilities { flags: 0 };
        assert!(!basic.named_streams());
        assert!(!basic.persistent_acls());
        assert!(!basic.extended_attributes());
        assert_eq!(basic.warnings().len(), 3);

        let streams_only = VolumeCapabilities {
            flags: FILE_NAMED_STREAMS,
        };
        assert!(streams_only.named_streams());
        assert!(!streams_only.persistent_acls());
        assert!(!streams_only.extended_attributes());
        assert_eq!(streams_only.warnings().len(), 2);
    }

    #[test]
    fn real_named_streams_on_a_capable_volume_still_fail_closed() {
        let root = std::env::temp_dir().join(format!(
            "dsh-metadata-stream-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("streamed");
        std::fs::write(&path, b"main").unwrap();
        let alternate = path.with_file_name("streamed:private");
        std::fs::write(&alternate, b"secret").unwrap();
        let file = File::open(&path).unwrap();
        assert!(VolumeCapabilities::query(&file).unwrap().named_streams());
        let error = match Metadata::capture(&file) {
            Ok(_) => panic!("named streams must not be discarded"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        assert!(error.to_string().contains("Named Windows streams"));
        drop(file);
        std::fs::remove_dir_all(root).unwrap();
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
}
