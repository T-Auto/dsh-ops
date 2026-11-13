use super::{check, owned};
use std::{ffi::c_void, io, mem::size_of, os::windows::io::AsRawHandle, ptr};
use windows_sys::Win32::{
    Foundation::{HANDLE, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_GROUPS, TOKEN_INFORMATION_CLASS,
        TOKEN_QUERY, TOKEN_USER, TokenLogonSid, TokenUser,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        // SAFETY: both conversion APIs transfer a LocalAlloc allocation to the caller.
        unsafe { LocalFree(self.0) };
    }
}

pub(super) struct Security(Local);
impl Security {
    pub(super) fn new() -> io::Result<Self> {
        let mut token = ptr::null_mut();
        // SAFETY: output pointer is valid and the current-process pseudo handle is borrowed.
        check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
        let token = owned(token)?;
        let owner = token_sid(token.as_raw_handle(), TokenUser)?;
        let logon = token_sid(token.as_raw_handle(), TokenLogonSid)?;
        // Restricted tokens retain the logon SID; no Everyone write ACE is needed.
        let sddl: Vec<u16> =
            format!("O:{owner}D:P(A;;GA;;;SY)(A;;GA;;;{owner})(A;;GRGW;;;{logon})S:(ML;;NW;;;LW)")
                .encode_utf16()
                .chain([0])
                .collect();
        let mut descriptor = ptr::null_mut();
        // SAFETY: the SDDL is terminated and output storage remains valid for the call.
        check(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        })?;
        Ok(Self(Local(descriptor)))
    }

    pub(super) fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: 0,
        }
    }
}

fn token_sid(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> io::Result<String> {
    let mut required = 0;
    // SAFETY: a null buffer with zero length requests the required allocation size.
    unsafe { GetTokenInformation(token, class, ptr::null_mut(), 0, &mut required) };
    if required == 0 || required > 65_536 {
        return Err(io::Error::other("invalid token information size"));
    }
    // usize storage supplies alignment for TOKEN_USER/TOKEN_GROUPS and their SID pointers.
    let mut buffer = vec![0usize; (required as usize).div_ceil(size_of::<usize>())];
    check(unsafe {
        GetTokenInformation(
            token,
            class,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    })?;
    let sid = if class == TokenUser && required as usize >= size_of::<TOKEN_USER>() {
        // SAFETY: the successful API populated this aligned, sufficiently large buffer.
        unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    } else if class == TokenLogonSid && required as usize >= size_of::<TOKEN_GROUPS>() {
        let groups = unsafe { &*buffer.as_ptr().cast::<TOKEN_GROUPS>() };
        if groups.GroupCount != 1 {
            return Err(io::Error::other("expected one logon SID"));
        }
        groups.Groups[0].Sid
    } else {
        return Err(io::Error::other("incomplete token SID information"));
    };
    let mut text = ptr::null_mut();
    // SAFETY: the SID refers to buffer, which remains alive through conversion.
    check(unsafe { ConvertSidToStringSidW(sid, &mut text) })?;
    let _allocation = Local(text.cast());
    let mut length = 0;
    // SAFETY: conversion returns a valid NUL-terminated SID string.
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| io::Error::other("invalid SID string"))
}

pub(super) fn private_name() -> io::Result<Vec<u16>> {
    let mut random = [0u8; 16];
    // SAFETY: the system-preferred RNG accepts a null algorithm and this writable buffer.
    let status = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            random.as_mut_ptr(),
            random.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(io::Error::other(format!(
            "BCryptGenRandom failed: {status:#x}"
        )));
    }
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(r"\\.\pipe\ops-shell-{suffix}")
        .encode_utf16()
        .chain([0])
        .collect())
}
