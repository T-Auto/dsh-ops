# Trusted bootstrap for DSH workspace-write. Never accepts model-selected roots.
param([Parameter(Mandatory=$true)][string]$Workspace, [Parameter(Mandatory=$true)][string]$BackupDir)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$item = Get-Item -LiteralPath $Workspace -Force
if (!$item.PSIsContainer) { throw 'Workspace is not a directory' }
$cursor = $item
while ($null -ne $cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Workspace ancestry contains a reparse point; refusing ACL preparation' }
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
    [IO.Directory]::SetAccessControl($item.FullName, $updated)
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
    [IO.Directory]::SetAccessControl($item.FullName, $restore)
    throw $failure
}
