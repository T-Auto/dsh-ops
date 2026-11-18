# Trusted bootstrap for DSH workspace-write. Never accepts model-selected roots.
param([Parameter(Mandatory=$true)][string]$Workspace, [Parameter(Mandatory=$true)][string]$BackupDir)
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'DSH_OPS_CONSTRAINED_LANGUAGE: workspace ACL preparation requires PowerShell FullLanguage; no ACL preparation was completed. Keep the host security policy enabled and ask its administrator for a supported preparation path.'
}
. (Join-Path $PSScriptRoot 'workspace-acl.ps1')
# \\wsl.localhost\<distro> and \\wsl$\<distro> are the WSL 9P redirector (#669):
# the filesystem behind them exposes no NTFS security descriptor, so Get-Acl
# cannot produce one and no DACL preparation has an object to write. Authority
# there is the distribution's own uid/gid mapping. This is a prefix decision,
# not a catch: every other path keeps its existing behaviour below, and a real
# ACL error on those paths still fails closed.
if ((Get-DshOpsWorkspaceNtfsState -Path $Workspace) -eq 'wsl-redirector') { Write-Output 'ready'; exit 0 }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$item = Get-Item -LiteralPath $Workspace -Force
if (!$item.PSIsContainer) { throw 'Workspace is not a directory' }
# No reparse walk here: a folder that is already ready answers without any
# tag inspection, so an OneDrive placeholder root is not refused merely for
# being a reparse point (#744). The tag check lives on the one branch below
# that actually writes.
$acl = Get-Acl -LiteralPath $item.FullName
$decision = Get-DshOpsWorkspaceDecision -Acl $acl -Identity $identity -Principal $principal
if ($decision.State -eq 'denied') { throw $decision.Reason }
if ($decision.State -eq 'ready') { Write-Output 'ready'; exit 0 }
if ($decision.State -eq 'foreign-owner') { throw $decision.Reason }
# Everything below is the preparation branch: the only code that writes, and
# therefore the only place a reparse tag is allowed to matter (#744).
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
public static class DshOpsReparseTag {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DeviceIoControl(SafeFileHandle handle, uint control, IntPtr inBuffer, uint inSize, byte[] outBuffer, uint outSize, out uint returned, IntPtr overlapped);
    public static uint Get(string path) {
        // Zero access, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT:
        // the query opens the point itself, never its target (#744).
        using (SafeFileHandle handle = CreateFileW(path, 0u, 7u, IntPtr.Zero, 3u, 0x02000000u | 0x00200000u, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            // FSCTL_GET_REPARSE_POINT needs a full REPARSE_DATA_BUFFER-sized output:
            // a four-byte slice is rejected with ERROR_INSUFFICIENT_BUFFER.
            byte[] buffer = new byte[16384];
            // The first dword of the returned buffer is the tag.
            // Windows PowerShell 5.1 compiles with C# 5, which has no inline out declarations.
            uint returned;
            if (!DeviceIoControl(handle, 0x900A8u, IntPtr.Zero, 0, buffer, (uint)buffer.Length, out returned, IntPtr.Zero) || returned < 4)
                throw new Win32Exception(Marshal.GetLastWin32Error() != 0 ? Marshal.GetLastWin32Error() : unchecked((int)0x80070057));
            return BitConverter.ToUInt32(buffer, 0);
        }
    }
}
'@
# Cloud placeholders keep a real directory entry behind the point, so the cloud family
# is allowed through; every other tag redirects the view and fails closed with the tag
# named, and a point whose tag cannot even be read fails closed too (#744).
$cursor = $item
while ($null -ne $cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        try { $tag = [DshOpsReparseTag]::Get($cursor.FullName) } catch {
            throw "Workspace ancestry contains a reparse point at $($cursor.FullName) whose tag cannot be read ($($_.Exception.Message)); refusing ACL preparation. Cloud placeholders are allowed through; an unreadable point is not."
        }
        $family = Get-DshOpsReparseTagDecision -Tag $tag
        if ($family.State -ne 'cloud') {
            throw "Workspace ancestry contains an unsupported reparse point (tag 0x$($tag.ToString('X8'))) at $($cursor.FullName); refusing ACL preparation. Cloud placeholders pass; every other reparse tag fails closed."
        }
    }
    $cursor = $cursor.Parent
}
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
