# Trusted bootstrap for DSH workspace-write. Never accepts model-selected roots.
param([Parameter(Mandatory=$true)][string]$Workspace, [Parameter(Mandatory=$true)][string]$BackupDir)
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'DSH_OPS_CONSTRAINED_LANGUAGE: workspace ACL preparation requires PowerShell FullLanguage; no ACL preparation was completed. Keep the host security policy enabled and ask its administrator for a supported preparation path.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$item = Get-Item -LiteralPath $Workspace -Force
if (!$item.PSIsContainer) { throw 'Workspace is not a directory' }
. (Join-Path $PSScriptRoot 'workspace-reparse.ps1')
# Cloud storage placeholders (OneDrive) tag an in-place directory with a cloud
# reparse point; those stay usable. Every other reparse point could redirect the
# ACL write away from the directory the caller named, so it still refuses.
$ancestry = @()
$cursor = $item
while ($null -ne $cursor) {
    $tag = $null
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { $tag = [uint32]0 }
    $ancestry += [pscustomobject]@{ Path = $cursor.FullName; Tag = $tag }
    $cursor = $cursor.Parent
}
$reparse = @($ancestry | Where-Object { $null -ne $_.Tag })
if ($reparse.Count -gt 0) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DshOpsReparseTag {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle device, uint code, IntPtr input, uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
    public static uint Read(string path) {
        // FILE_READ_EA; share read/write/delete; OPEN_EXISTING; FILE_FLAG_OPEN_REPARSE_POINT
        // queries the reparse point on this directory instead of following it.
        using (SafeFileHandle handle = CreateFileW(path, 0x00000008u, 7u, IntPtr.Zero, 3u, 0x02000000u | 0x00200000u, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr buffer = Marshal.AllocHGlobal(16384);
            try {
                uint returned;
                if (!DeviceIoControl(handle, 0x000900A8u, IntPtr.Zero, 0u, buffer, 16384u, out returned, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                // The REPARSE_DATA_BUFFER begins with the 32-bit tag.
                return unchecked((uint)Marshal.ReadInt32(buffer));
            } finally {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
}
'@
    foreach ($entry in $reparse) {
        try { $entry.Tag = [DshOpsReparseTag]::Read($entry.Path) }
        catch { throw "Cannot read the reparse point tag of $($entry.Path): $($_.Exception.Message)" }
    }
}
$unaccounted = Find-DshOpsUnaccountedReparsePoint -Entries $ancestry
if ($null -ne $unaccounted) {
    throw ('Workspace ancestry contains a reparse point that is not a cloud storage placeholder: {0} (tag 0x{1:X8}). Junctions, symlinks and other reparse points could redirect the ACL write outside the workspace; open a workspace reached through a real directory, or use danger-full-access.' -f $unaccounted.Path, $unaccounted.Tag)
}
$acl = Get-Acl -LiteralPath $item.FullName
. (Join-Path $PSScriptRoot 'workspace-acl.ps1')
$decision = Get-DshOpsWorkspaceDecision -Acl $acl -Identity $identity -Principal $principal
if ($decision.State -eq 'denied') { throw $decision.Reason }
if ($decision.State -eq 'ready') { Write-Output 'ready'; exit 0 }
if ($decision.State -eq 'foreign-owner') { throw $decision.Reason }
$needed = [Security.AccessControl.FileSystemRights]::TakeOwnership # WRITE_OWNER, needed to set the sandbox integrity label
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
