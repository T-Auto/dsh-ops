# Trusted bootstrap for DSH workspace-write. Never accepts model-selected roots.
param([Parameter(Mandatory=$true)][string]$Workspace, [Parameter(Mandatory=$true)][string]$BackupDir)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
. (Join-Path $PSScriptRoot 'reparse-tag.ps1')
$item = Get-Item -LiteralPath $Workspace -Force
if (!$item.PSIsContainer) { throw 'Workspace is not a directory' }
# Read the tag, not just the attribute bit: a sync engine's placeholder is a reparse point that
# names the directory itself, while a junction or a symlink names another path. A tag that cannot
# be read is treated as a link, so an unexpected filter fails closed.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DshOpsReparseTag {
    const uint FSCTL_GET_REPARSE_POINT = 0x000900A8;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(IntPtr handle, uint code, IntPtr inBuffer, uint inSize, byte[] outBuffer, uint outSize, out uint returned, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    public static uint Read(string path) {
        // FILE_READ_ATTRIBUTES; share read/write/delete; OPEN_EXISTING; FILE_FLAG_BACKUP_SEMANTICS
        // opens a directory; FILE_FLAG_OPEN_REPARSE_POINT reads the entry instead of following it.
        IntPtr handle = CreateFileW(path, 0x0080u, 7u, IntPtr.Zero, 3u, 0x02000000u | 0x00200000u, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            byte[] buffer = new byte[16384];
            uint returned;
            if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, IntPtr.Zero, 0u, buffer, (uint)buffer.Length, out returned, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return BitConverter.ToUInt32(buffer, 0);
        } finally { CloseHandle(handle); }
    }
}
'@
$cursor = $item
while ($null -ne $cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $placeholder = $false
        try { $placeholder = Test-DshOpsCloudReparseTag ([DshOpsReparseTag]::Read($cursor.FullName)) } catch { $placeholder = $false }
        if (!$placeholder) { throw 'Workspace ancestry contains a reparse point; refusing ACL preparation' }
    }
    $cursor = $cursor.Parent
}
$acl = Get-Acl -LiteralPath $item.FullName
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) {
    throw 'Workspace is not owned by the current user; refusing automatic ACL preparation'
}
$needed = [Security.AccessControl.FileSystemRights]::TakeOwnership # WRITE_OWNER, needed to set the sandbox integrity label
$allow = 0L
$deny = 0L
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
    $active = $rule.IdentityReference.Value -eq $identity.User.Value -or $principal.IsInRole($rule.IdentityReference)
    if (!$active) { continue }
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { $deny = $deny -bor [long]$rule.FileSystemRights }
    else { $allow = $allow -bor [long]$rule.FileSystemRights }
}
if ($deny -band [long]$needed) { throw 'Explicit effective denial of WRITE_OWNER; refusing to override user policy' }
if ($allow -band [long]$needed) { Write-Output 'ready'; exit 0 }
# Write only the root's own DACL through its handle. The added ACE is directory-only and the
# inheritable ACEs are unchanged, so no descendant needs a new ACL; path-based SetAccessControl
# (SetNamedSecurityInfo) would still walk and re-propagate the whole subtree, which scales with
# workspace size (#43). SetKernelObjectSecurity sets this object only.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using Microsoft.Win32.SafeHandles;
public static class DshOpsDirectoryDacl {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information, byte[] descriptor);
    public static void Set(string path, byte[] descriptor) {
        // Keep the auto-inherited (AI) DACL flag: the kernel retains it only when the request asks
        // for auto-inheritance on this object. It still never propagates to descendants.
        RawSecurityDescriptor raw = new RawSecurityDescriptor(descriptor, 0);
        if ((raw.ControlFlags & ControlFlags.DiscretionaryAclAutoInherited) != 0) {
            raw.SetFlags(raw.ControlFlags | ControlFlags.DiscretionaryAclAutoInheritRequired);
            descriptor = new byte[raw.BinaryLength];
            raw.GetBinaryForm(descriptor, 0);
        }
        // READ_CONTROL | WRITE_DAC; share read/write/delete; OPEN_EXISTING; FILE_FLAG_BACKUP_SEMANTICS opens a directory.
        using (SafeFileHandle handle = CreateFileW(path, 0x00020000u | 0x00040000u, 7u, IntPtr.Zero, 3u, 0x02000000u, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            // DACL_SECURITY_INFORMATION only: owner, group and SACL are untouched.
            if (!SetKernelObjectSecurity(handle, 4u, descriptor)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
'@
# Save only the DACL. Owner, SACL, existing ACEs and child ACLs are not changed.
$before = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
[IO.Directory]::CreateDirectory($BackupDir) | Out-Null
$receipt = Join-Path $BackupDir (([guid]::NewGuid().ToString()) + '.json')
@{ workspace=$item.FullName; userSid=$identity.User.Value; dacl=$before; added='WRITE_OWNER (directory only)' } | ConvertTo-Json | Set-Content -LiteralPath $receipt -Encoding UTF8
try {
    $updated = [Security.AccessControl.DirectorySecurity]::new()
    $updated.SetSecurityDescriptorSddlForm($before, [Security.AccessControl.AccessControlSections]::Access)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity.User, $needed, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $updated.AddAccessRule($rule)
    [DshOpsDirectoryDacl]::Set($item.FullName, $updated.GetSecurityDescriptorBinaryForm())
    $after = Get-Acl -LiteralPath $item.FullName
    $verified = @($after.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]) | Where-Object {
        $_.IdentityReference.Value -eq $identity.User.Value -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        ($_.FileSystemRights -band $needed) -eq $needed -and $_.InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]::None
    }).Count -gt 0
    if (!$verified) { throw 'WRITE_OWNER verification failed' }
    Write-Output 'prepared'
} catch {
    $failure = $_
    $restore = [Security.AccessControl.DirectorySecurity]::new()
    $restore.SetSecurityDescriptorSddlForm($before, [Security.AccessControl.AccessControlSections]::Access)
    [DshOpsDirectoryDacl]::Set($item.FullName, $restore.GetSecurityDescriptorBinaryForm())
    throw $failure
}
