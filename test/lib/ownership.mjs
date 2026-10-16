/**
 * Claim a directory for the current user before preparation is asked about it.
 *
 * A directory is owned by whoever created it — unless the process token's default owner is a group,
 * which is what an elevated administrator token carries. GitHub's hosted Windows runner runs that
 * way, as the built-in Administrator, so every directory its tests create is owned by
 * `BUILTIN\Administrators`; `bin/prepare-workspace.ps1` refuses such a root as "not owned by the
 * current user" and a suite that means to test preparation then reports that as a product failure.
 *
 * Reading the owner back is the point, not a formality: a refused owner change is a PowerShell
 * *non-terminating* error, so a helper that only checked the exit code would report success and the
 * suite would continue into exactly the misreading this function exists to prevent.
 *
 * @module dsh-ops/test/ownership
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { preparationEnvironment } from '../../lib/workspace-preparation.js'

/**
 * Make `target` owned by the current user, and prove it.
 * @param {string} target - the directory the suite is about to hand to preparation.
 * @returns {string} the current user's SID, for checks that compare against one.
 */
export function ownCurrentUser(target) {
  const quoted = target.replaceAll("'", "''")
  // The same scrubbed environment the preparation script gets: a pwsh 7 host publishes its own
  // module directories into the process-level `PSModulePath`, and 5.1 then fails to load
  // `Microsoft.PowerShell.Security` (no `Get-Acl`/`Set-Acl`).
  const code = `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=Get-Acl -LiteralPath '${quoted}'; $a.SetOwner($sid); Set-Acl -LiteralPath '${quoted}' -AclObject $a; "$((Get-Acl -LiteralPath '${quoted}').GetOwner([Security.Principal.SecurityIdentifier]).Value)|$($sid.Value)"`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', env: preparationEnvironment() })
  assert.equal(result.status, 0, result.stderr)
  const [owner, sid] = result.stdout.trim().split('|')
  assert.equal(owner, sid, `fixture root ${target} is owned by ${owner}, not by the current user; the preparation script refuses such a root, and the owner change that should have fixed it did not take`)
  return sid
}

/**
 * Resolve an SDDL trustee token to a SID.
 *
 * `GetSecurityDescriptorSddlForm` abbreviates well-known SIDs, so an ACE granted to the built-in
 * Administrator reads as `LA`, not as `S-1-5-…-500`. Comparing that token against a SID string is
 * false on any host whose user *is* a well-known account, which says nothing about the change under
 * test.
 *
 * @param {string} trustee - the trustee field of an SDDL ACE.
 * @returns {string} the numeric SID.
 */
export function resolveTrustee(trustee) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`[Security.Principal.SecurityIdentifier]::new('${trustee}').Value`, 'utf16le').toString('base64')], { encoding: 'utf8', env: preparationEnvironment() })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
