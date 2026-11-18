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

<#
Classify one reparse tag for the preparation branch (#744). This is pure: it
never opens the point, it only judges the tag value the caller read.

Only the proven cloud-files family is allowed through: the placeholders
(IO_REPARSE_TAG_CLOUD 0x9000001A, CLOUD_ROOT 0x9000101A, CLOUD_ON_DEMAND
0x9000201A, and family members sharing the exact 0x9000?01A shape) keep a
real directory entry behind the point, so a directory-only WRITE_OWNER write
still targets a real object. A high nibble of 9 alone is NOT enough: the rest
of Microsoft's reserved 0x90000000-0x9FFFFFFF band is unproven here and stays
out, exactly like every other tag (mount point, symlink, dedup, ...) that
redirects or transforms the view and fails closed with the tag named. A tag
that cannot be read at all is the caller's error to surface, not a decision
to soften.
#>
function Get-DshOpsReparseTagDecision {
    param(
        [Parameter(Mandatory = $true)][uint32]$Tag
    )
    # Decimal constants on purpose: Windows PowerShell 5.1 folds in-band hex
    # literals into a negative Int32, and a sign-extended Int64 mask never
    # matches. 4294905855 is 0xFFFF0FFF (family mask); 2415919130 is
    # 0x9000001A (IO_REPARSE_TAG_CLOUD).
    if (($Tag -band 4294905855) -eq 2415919130) { return [pscustomobject]@{ State = 'cloud' } }
    return [pscustomobject]@{ State = 'unsupported' }
}

<#
Classify one workspace spelling for NTFS ACL evaluation (#669). Pure.

\\wsl.localhost\<distro> and \\wsl$\<distro> are the WSL 9P redirector: the
filesystem behind it exposes no NTFS security descriptor, so Get-Acl cannot
produce one and no DACL write has an object. Authority there is the
distribution's own uid/gid mapping, so those prefixes must not be treated
as a failed preparation. This is a prefix decision, not a catch swallowing
ACL errors: everything else is evaluated as NTFS, where a real Get-Acl
failure still fails closed.
#>
function Get-DshOpsWorkspaceNtfsState {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )
    if ($Path -match '^(\\\\(\?\\UNC\\)?wsl(\.localhost|\$)\\)') { return 'wsl-redirector' }
    return 'ntfs'
}
