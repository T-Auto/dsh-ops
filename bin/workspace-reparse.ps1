# Pure reparse-point decisions for the workspace ancestry in prepare-workspace.ps1 (#937).
# Dot-source only after the caller's language-mode guard: this file performs no
# I/O; the caller reads the tags and this file decides whether they are allowed.
function Test-DshOpsAllowedReparseTag {
    param([Parameter(Mandatory = $true)][uint32]$Tag)
    # IO_REPARSE_TAG_CLOUD (0x9000001A) and the per-provider variants 0x9000N01A:
    # cloud storage placeholders such as OneDrive tag a directory in place with
    # these. They carry provider state, not a path redirection, so the ACL write
    # still lands on the directory the caller named.
    # PS 5.1 parses a hex literal above Int32.MaxValue as a negative Int32, so the
    # mask and the cloud tag are parsed as unsigned values before they are ANDed.
    $mask = [uint64]::Parse('FFFF0FFF', [Globalization.NumberStyles]::HexNumber)
    $cloud = [uint64]::Parse('9000001A', [Globalization.NumberStyles]::HexNumber)
    return (([uint64]$Tag -band $mask) -eq $cloud)
}

<#
Name the first ancestor reparse point that is not an allowed cloud placeholder.

The caller walks the ancestry nearest first and passes one entry per ancestor:
Path is its full path, and Tag is the reparse tag when the directory carries the
reparse attribute, or $null otherwise. A junction, symlink or any other tag is
returned so the caller can refuse before touching an ACL; $null means every
reparse point on the ancestry is accounted for.
#>
function Find-DshOpsUnaccountedReparsePoint {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Entries)
    foreach ($entry in $Entries) {
        if ($null -eq $entry.Tag) { continue }
        if (-not (Test-DshOpsAllowedReparseTag -Tag ([uint32]$entry.Tag))) { return $entry }
    }
    return $null
}
