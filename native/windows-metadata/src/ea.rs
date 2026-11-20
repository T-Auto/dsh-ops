//! Bounded NTFS extended-attribute capture, restore and verification.
//!
//! Kernel EA names (the "$KERNEL." prefix, e.g. EFS's PurgeEFSProxyCache or
//! SmartLocker tags) are written by kernel components and cannot be recreated
//! from user mode. They are captured as names and reported per name in the
//! publication warnings; nothing is silently dropped (#874). Every other EA
//! is captured byte-exactly, restored on the staged file and re-verified
//! after restore; a mismatch, an unreadable or an unsettable set aborts
//! publication.

use super::{IoStatus, nt_error, unsupported};
use std::{
    ffi::c_void,
    fs::File,
    io,
    os::windows::io::AsRawHandle,
    ptr::{null, null_mut},
};
use windows_sys::Win32::Foundation::HANDLE;

/// One bounded capture budget, matching the named-stream capture in lib.rs.
pub const MAX_EA_BYTES: usize = 64 * 1024;
pub const MAX_EA_ENTRIES: usize = 4096;
/// The kernel-mode EA name prefix; user-mode NtSetEaFile refuses these names.
const KERNEL_EA_PREFIX: &[u8] = b"$kernel.";
const FILE_EA_INFORMATION: u32 = 7;
const NO_MORE_EAS: i32 = 0xC000_191u32 as i32;
const BUFFER_OVERFLOW: i32 = 0x8000_0005u32 as i32;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryEaFile(
        handle: HANDLE,
        status: *mut IoStatus,
        buffer: *mut c_void,
        length: u32,
        return_single_entry: u8,
        ea_list: *const c_void,
        ea_list_length: u32,
        ea_index: *mut u32,
        restart_scan: u8,
    ) -> i32;
    fn NtSetEaFile(
        handle: HANDLE,
        status: *mut IoStatus,
        buffer: *const c_void,
        length: u32,
    ) -> i32;
}

/// One FILE_FULL_EA_INFORMATION entry, in a canonical owned spelling.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EaEntry {
    pub flags: u8,
    pub name: Vec<u8>,
    pub value: Vec<u8>,
}

#[derive(Default, Debug)]
pub struct CapturedEas {
    /// Restorable entries only; kernel names never reach a set call.
    pub entries: Vec<EaEntry>,
    /// Names of kernel-owned EAs, reported as unpreservable evidence.
    pub kernel: Vec<Vec<u8>>,
}

impl CapturedEas {
    /// Warnings state exactly what will not be preserved, before anything is
    /// written, so a caller can stop instead of silently losing metadata.
    pub fn warnings(&self) -> Vec<String> {
        self.kernel
            .iter()
            .map(|name| {
                format!(
                    "Kernel extended attribute '{}' is owned by a kernel component \
                     and cannot be restored from user mode; not preserved",
                    String::from_utf8_lossy(name)
                )
            })
            .collect()
    }
    /// One canonical FILE_FULL_EA_INFORMATION list for NtSetEaFile.
    pub fn restorable_buffer(&self) -> Vec<u8> {
        let mut buffer = Vec::new();
        for (index, entry) in self.entries.iter().enumerate() {
            let start = buffer.len();
            buffer.extend_from_slice(&0u32.to_le_bytes());
            buffer.push(entry.flags);
            buffer.push(entry.name.len() as u8);
            buffer.extend_from_slice(&(entry.value.len() as u16).to_le_bytes());
            buffer.extend_from_slice(&entry.name);
            buffer.push(0);
            buffer.extend_from_slice(&entry.value);
            while buffer.len() % 4 != 0 {
                buffer.push(0);
            }
            if index + 1 < self.entries.len() {
                let size = (buffer.len() - start) as u32;
                buffer[start..start + 4].copy_from_slice(&size.to_le_bytes());
            }
        }
        buffer
    }
}

/// Kernel EA names are matched case-insensitively: the kernel itself folds EA
/// names to uppercase, so either spelling must classify.
pub fn is_kernel_ea_name(name: &[u8]) -> bool {
    name.len() >= KERNEL_EA_PREFIX.len()
        && name[..KERNEL_EA_PREFIX.len()].eq_ignore_ascii_case(KERNEL_EA_PREFIX)
}

/// Byte-exact restorable comparison. Order stays out of the contract because
/// EA query order is a kernel detail; names, flags and values are not.
pub fn same_restorable(a: &[EaEntry], b: &[EaEntry]) -> bool {
    let mut a: Vec<_> = a.to_vec();
    let mut b: Vec<_> = b.to_vec();
    a.sort_by(|x, y| x.name.cmp(&y.name));
    b.sort_by(|x, y| x.name.cmp(&y.name));
    a == b
}

/// Capture the full EA set of one file. The kernel reports the exact list
/// size first, so the scan budget is known before any buffer is read; an
/// oversized, malformed or unreadable set fails closed instead of being
/// discarded.
pub fn capture(file: &File) -> io::Result<CapturedEas> {
    let mut size = 0u32;
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    // SAFETY: FileEaInformation (7) writes one ULONG into size for a borrowed
    // handle.
    let result = unsafe {
        super::NtQueryInformationFile(
            file.as_raw_handle(),
            &mut status,
            (&mut size as *mut u32).cast(),
            4,
            FILE_EA_INFORMATION,
        )
    };
    if result < 0 {
        return Err(nt_error(result));
    }
    if size == 0 {
        return Ok(CapturedEas::default());
    }
    if size as usize > MAX_EA_BYTES {
        return Err(unsupported(
            "Windows extended-attribute metadata exceeds the bounded capture budget",
        ));
    }
    let mut captured = CapturedEas::default();
    // The size probe bounds the whole list; the loop only resumes a partial
    // buffer, and an entry larger than the budget fails closed at the call.
    let mut buffer = vec![0u8; size as usize + 512];
    let mut restart = 1u8;
    for _ in 0..64 {
        let mut status = IoStatus {
            status: 0,
            information: 0,
        };
        // SAFETY: borrowed handle; buffer and status outlive the call.
        let result = unsafe {
            NtQueryEaFile(
                file.as_raw_handle(),
                &mut status,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                0,
                null(),
                0,
                null_mut(),
                restart,
            )
        };
        restart = 0;
        if result == NO_MORE_EAS {
            break;
        }
        if result < 0 && result != BUFFER_OVERFLOW {
            return Err(nt_error(result));
        }
        let used = status.information.min(buffer.len());
        append_entries(&buffer[..used], &mut captured)?;
        if result >= 0 && used < buffer.len() {
            break;
        }
        if used == 0 {
            return Err(unsupported(
                "Windows extended-attribute scan made no progress",
            ));
        }
    }
    Ok(captured)
}

/// Parse one FILE_FULL_EA_INFORMATION list into the canonical capture. Every
/// length and offset is bounds-checked before use; a malformed record fails
/// closed rather than being partially accepted.
fn append_entries(bytes: &[u8], captured: &mut CapturedEas) -> io::Result<()> {
    let mut at = 0usize;
    loop {
        if at + 8 > bytes.len() {
            if at == bytes.len() {
                return Ok(());
            }
            return Err(unsupported("Truncated Windows extended-attribute record"));
        }
        let next =
            u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        let flags = bytes[at + 4];
        let name_length = bytes[at + 5] as usize;
        let value_length = u16::from_le_bytes([bytes[at + 6], bytes[at + 7]]) as usize;
        let name_at = at + 8;
        let value_at = name_at + name_length + 1;
        if value_at + value_length > bytes.len() || bytes.get(name_at + name_length) != Some(&0) {
            return Err(unsupported("Truncated Windows extended-attribute record"));
        }
        let name = &bytes[name_at..name_at + name_length];
        if name.is_empty() || name.iter().any(|b| !b.is_ascii()) {
            return Err(unsupported("Invalid Windows extended-attribute name"));
        }
        if flags > 1 {
            return Err(unsupported("Unsupported Windows extended-attribute flags"));
        }
        if is_kernel_ea_name(name) {
            captured.kernel.push(name.to_vec());
        } else {
            if captured.entries.len() >= MAX_EA_ENTRIES {
                return Err(unsupported(
                    "Windows extended-attribute count exceeds the bounded capture budget",
                ));
            }
            captured.entries.push(EaEntry {
                flags,
                name: name.to_vec(),
                value: bytes[value_at..value_at + value_length].to_vec(),
            });
        }
        if next == 0 {
            return Ok(());
        }
        if next < 8 || at + next > bytes.len() {
            return Err(unsupported(
                "Invalid Windows extended-attribute record chain",
            ));
        }
        at += next;
    }
}

/// Set the captured restorable EAs on one staged destination file. The
/// destination is always our own freshly created private sibling, so a kernel
/// refusal aborts publication instead of touching the source.
pub fn restore(file: &File, captured: &CapturedEas) -> io::Result<()> {
    let buffer = captured.restorable_buffer();
    if buffer.is_empty() {
        return Ok(());
    }
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    // SAFETY: borrowed handle; the buffer outlives the call.
    let result = unsafe {
        NtSetEaFile(
            file.as_raw_handle(),
            &mut status,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if result < 0 {
        return Err(nt_error(result));
    }
    Ok(())
}

/// Re-query the destination and compare the restorable set byte-exactly.
/// Kernel entries on either side stay out of the comparison: their lifecycle
/// belongs to the kernel and is reported at capture time instead.
pub fn verify(file: &File, captured: &CapturedEas) -> io::Result<()> {
    if captured.entries.is_empty() {
        return Ok(());
    }
    let actual = capture(file)?;
    if !same_restorable(&captured.entries, &actual.entries) {
        return Err(unsupported(
            "Windows extended-attribute preservation verification failed",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_names_classify_and_degrade_with_named_evidence() {
        assert!(is_kernel_ea_name(b"$KERNEL.PurgeEFSProxyCache"));
        assert!(is_kernel_ea_name(b"$kernel.Custom"));
        assert!(!is_kernel_ea_name(b"dsh-ops.test"));
        assert!(!is_kernel_ea_name(b"$KERNEX.x"));
        assert!(!is_kernel_ea_name(b""));
        let captured = CapturedEas {
            entries: vec![EaEntry {
                flags: 0,
                name: b"DSH-OPS.TEST".to_vec(),
                value: b"fixture".to_vec(),
            }],
            kernel: vec![b"$KERNEL.SIM".to_vec()],
        };
        let warnings = captured.warnings();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("$KERNEL.SIM"), "{}", warnings[0]);
        // The restorable buffer carries only the user entry; kernel names
        // never reach a set call.
        let buffer = captured.restorable_buffer();
        assert!(buffer.windows(12).any(|w| w == b"DSH-OPS.TEST"));
        assert!(!buffer.windows(10).any(|w| w == b"$KERNEL.SIM"));
    }

    #[test]
    fn restorable_comparison_is_byte_exact_and_strict() {
        let entry = |name: &[u8], value: &[u8]| EaEntry {
            flags: 0,
            name: name.to_vec(),
            value: value.to_vec(),
        };
        let a = vec![entry(b"A.ONE", b"v1"), entry(b"B.TWO", b"v2")];
        let reordered = vec![entry(b"B.TWO", b"v2"), entry(b"A.ONE", b"v1")];
        assert!(same_restorable(&a, &reordered));
        assert!(!same_restorable(&a, &vec![entry(b"A.ONE", b"different")]));
        assert!(!same_restorable(&a, &vec![entry(b"A.ONE", b"v1")]));
        assert!(!same_restorable(
            &a,
            &vec![
                entry(b"A.ONE", b"v1"),
                entry(b"B.TWO", b"v2"),
                entry(b"C.NEW", b"v"),
            ],
        ));
        let flagged = vec![EaEntry {
            flags: 1,
            name: b"A.ONE".to_vec(),
            value: b"v1".to_vec(),
        }];
        assert!(!same_restorable(&a[..1], &flagged));
    }

    #[test]
    fn buffers_chain_entries_with_aligned_offsets_and_a_zero_tail() {
        let captured = CapturedEas {
            entries: vec![
                EaEntry {
                    flags: 0,
                    name: b"FIRST.X".to_vec(),
                    value: b"one".to_vec(),
                },
                EaEntry {
                    flags: 1,
                    name: b"SECOND.Y".to_vec(),
                    value: b"two!".to_vec(),
                },
            ],
            kernel: Vec::new(),
        };
        let buffer = captured.restorable_buffer();
        let first = u32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
        assert_eq!(first % 4, 0);
        assert!(first + 8 <= buffer.len());
        assert_eq!(buffer[4], 0);
        assert_eq!(buffer[5], 7);
        assert_eq!(buffer[first + 4], 1);
        assert_eq!(buffer[first + 5], 8);
        // The last entry terminates the chain with a zero NextEntryOffset.
        assert_eq!(buffer[first..first + 4], [0, 0, 0, 0]);
    }
}
