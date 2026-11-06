# Pure workspace-prerequisite decisions for prepare-workspace.ps1 (#651).
# Dot-source only after the caller's language-mode guard: this file performs no
# I/O and never changes an ACL; it only reads the DACL it is handed.
function Get-DshOpsWorkspaceRights {
    param(
        [Parameter(Mandatory = $true)][Security.AccessControl.DirectorySecurity]$Acl,
        [Parameter(Mandatory = $true)][Security.Principal.WindowsIdentity]$Identity,
        [Parameter(Mandatory = $true)][Security.Principal.WindowsPrincipal]$Principal
    )
    $allow = 0L
    $deny = 0L
    foreach ($rule in $Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        $active = $rule.IdentityReference.Value -eq $Identity.User.Value -or $Principal.IsInRole($rule.IdentityReference)
        if (!$active) { continue }
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) {
            $deny = $deny -bor [long]$rule.FileSystemRights
        } else {
            $allow = $allow -bor [long]$rule.FileSystemRights
        }
    }
    [pscustomobject]@{ Allow = $allow; Deny = $deny }
}

<#
Decide what preparation must do, without touching anything.

Order matters and is the fix for #651: an explicit denial ends the decision, an
already effective WRITE_OWNER is accepted as-is (ownership is irrelevant because
this path writes nothing), and only a folder that still needs the ACE requires
the caller to own it. A folder owned by another account is therefore usable
when it already grants the prerequisite.
#>
function Get-DshOpsWorkspaceDecision {
    param(
        [Parameter(Mandatory = $true)][Security.AccessControl.DirectorySecurity]$Acl,
        [Parameter(Mandatory = $true)][Security.Principal.WindowsIdentity]$Identity,
        [Parameter(Mandatory = $true)][Security.Principal.WindowsPrincipal]$Principal
    )
    $needed = [long][Security.AccessControl.FileSystemRights]::TakeOwnership
    $rights = Get-DshOpsWorkspaceRights -Acl $Acl -Identity $Identity -Principal $Principal
    if (($rights.Deny -band $needed) -ne 0) {
        return [pscustomobject]@{
            State = 'denied'
            Reason = 'Explicit effective denial of WRITE_OWNER; refusing to override user policy'
        }
    }
    if (($rights.Allow -band $needed) -ne 0) {
        return [pscustomobject]@{ State = 'ready' }
    }
    $owner = $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $Identity.User.Value) {
        return [pscustomobject]@{
            State = 'foreign-owner'
            Owner = $owner
            Reason = "Workspace is not owned by the current user (owner $owner, caller $($Identity.User.Value)) and does not already grant WRITE_OWNER; automatic ACL preparation only adds that ACE to a directory the current user owns. Grant WRITE_OWNER on this directory, take ownership of it, or use danger-full-access."
        }
    }
    # A NULL DACL owned by the caller also lands here: it lets every caller do
    # everything, but the enumerated mask is empty, so this path writes an
    # explicit ACE that narrows it. A NULL DACL owned by another account lands in
    # foreign-owner instead. Both are the pre-existing behaviour, kept unchanged.
    [pscustomobject]@{ State = 'needs-preparation' }
}
