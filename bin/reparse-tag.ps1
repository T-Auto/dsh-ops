# Which reparse points may sit above a workspace root.
#
# IO_REPARSE_TAG_CLOUD .. IO_REPARSE_TAG_CLOUD_F (0x9000001A, 0x9000101A .. 0x9000F01A) are the
# sync engine's placeholder tags (OneDrive Files On-Demand, fn-sync and friends). A placeholder
# directory is the object the path names, so a DACL written to that path lands on the right object
# and the ACL prerequisite still holds. A junction (0xA0000003) or a symlink (0xA000000C) redirects
# the path somewhere else, which is what the refusal in prepare-workspace.ps1 exists for.
#
# Split into two small masks: Windows PowerShell 5.1 reads a literal above Int32.MaxValue such as
# 0xFFFF0FFF as a negative Int32, so the natural single mask cannot be written here.
function Test-DshOpsCloudReparseTag([uint32]$Tag) {
    return (($Tag -shr 16) -eq 0x9000) -and (($Tag -band 0xFF) -eq 0x1A)
}
