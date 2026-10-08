//! Windows-only launch primitive for a detached control center.

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateProcessW, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, STARTUPINFOW,
};

/// Starts `runtime-host` without inheriting any of the proxy's stdio capture pipes.
///
/// `std::process::Command` must enable handle inheritance to install redirected standard handles.
/// A bootstrap launched beneath `Command::output` can therefore receive unrelated inheritable pipe
/// handles and pass them to its detached child, keeping the caller blocked on EOF indefinitely.
pub(super) fn spawn_without_inherited_handles(
    executable: &Path,
    cwd: &Path,
    creation_flags: PROCESS_CREATION_FLAGS,
) -> io::Result<()> {
    let application = nul_terminated(executable.as_os_str());
    let current_directory = nul_terminated(cwd.as_os_str());
    let mut command_line = Vec::with_capacity(application.len() + 16);
    command_line.push(b'"' as u16);
    command_line.extend(executable.as_os_str().encode_wide());
    command_line.extend(['"' as u16, ' ' as u16]);
    command_line.extend(OsStr::new("runtime-host").encode_wide());
    command_line.push(0);

    // SAFETY: all pointers reference live, NUL-terminated buffers for the duration of the call;
    // the output structure is initialized by CreateProcessW on success. No handles are inherited.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    // SAFETY: PROCESS_INFORMATION is a plain output structure whose null handles are valid before
    // CreateProcessW initializes it.
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            creation_flags | CREATE_NO_WINDOW,
            std::ptr::null(),
            current_directory.as_ptr(),
            &startup,
            &mut process,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: CreateProcessW returned ownership of two valid handles on success.
    unsafe {
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    Ok(())
}

fn nul_terminated(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
