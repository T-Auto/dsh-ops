# Read LABEL_SECURITY_INFORMATION only. No privilege enabling or security writes.
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    @{ error = 'ConstrainedLanguage: integrity labels could not be inspected' } | ConvertTo-Json -Compress
    exit 0
}
try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OpsIntegrityRead {
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern uint GetNamedSecurityInfoW(string name, uint type, uint info,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor,
        uint revision, uint info, out IntPtr text, out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string Query(string path) {
        IntPtr owner, group, dacl, sacl, descriptor = IntPtr.Zero, text = IntPtr.Zero;
        try {
            uint error = GetNamedSecurityInfoW(path, 1, 0x10, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0) throw new Win32Exception((int)error);
            uint size;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 0x10, out text, out size))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return Marshal.PtrToStringUni(text) ?? "";
        } finally {
            if (text != IntPtr.Zero) LocalFree(text);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }
}
'@
    $entries = @($paths | ForEach-Object {
        try { @{ path = [string]$_; sddl = [OpsIntegrityRead]::Query([string]$_) } }
        catch { @{ path = [string]$_; error = $_.Exception.Message } }
    })
    @{ entries = $entries } | ConvertTo-Json -Depth 4 -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
