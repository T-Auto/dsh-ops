/**
 * A file created by `ops_write_file` must inherit its directory's ACEs (#420).
 *
 * Staging is deliberately private: `create_private` builds a protected
 * `D:P(A;;FA;;;<caller>)` descriptor before a byte exists, and publication is a hard
 * link of that inode. Without a second step the published file keeps that single
 * explicit ACE, so the directory's inheritable grants — including the sandbox write
 * capability the host granted the workspace — never reach it. The consequences are
 * not cosmetic: the same session cannot delete the file it just created, and other
 * tools or accounts that the directory grants lose access.
 *
 * What this suite locks in, through the real worker:
 *
 * - Every entry the directory would inherit into a file is present on the created
 *   file and marked inherited, so a reverted adoption fails here.
 * - The calling process keeps one explicit full-control entry, so the file is never
 *   created less usable than before.
 * - The published DACL is not protected, so later directory changes keep propagating.
 * - The same session can delete the file it created.
 *
 * The directory fixture is used as it is: adding a grant of our own would need
 * WRITE_DAC on a directory the test did not create, and the temporary home already
 * carries inheritable entries that a private descriptor can never have.
 *
 * Windows-only by construction (security descriptors), so it reports and exits on
 * every other platform instead of pretending to pass.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('file-inherited-dacl')
if (process.platform === 'win32') {
  /** The DACL in SDDL form; `Get-Acl` renders every SID numerically. */
  const sddl = target => execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${target.replaceAll("'", "''")}').Sddl`],
    { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } },
  ).trim()

  /**
   * DACL entries as comparable facts. Order, inheritance flags and SID spelling all
   * change between a container and a file, so only type/mask/SID are compared, and
   * the inherited marker is asserted separately.
   */
  const entries = text => {
    const dacl = text.split('D:')[1] ?? ''
    return [...dacl.matchAll(/\(([^()]*)\)/g)].map(match => match[1].split(';')).map(parts => ({
      type: parts[0], flags: parts[1] ?? '', rights: parts[2] ?? '', sid: parts[5] ?? '',
    }))
  }
  const inheritable = list => list.filter(entry => entry.flags.includes('OI'))
  const callerSid = () => execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-5-[0-9-]+/)?.[0]

  /**
   * SDDL access masks, file namespace. `WD`/`RD`/`AD` are the file rights here, not
   * the standard-rights aliases of the same spelling.
   */
  const ALIASES = {
    FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
    GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000,
    SD: 0x10000, RC: 0x20000, WD: 0x2, RD: 0x1, AD: 0x4, X: 0x20, DC: 0x40,
    REA: 0x8, WEA: 0x10, RA: 0x80, WA: 0x100, DT: 0x40,
  }
  const GENERIC = { GA: 0x10000000, GR: 0x80000000, GW: 0x40000000, GX: 0x20000000 }
  const FILE_ALL_ACCESS = 0x1f01ff, FILE_GENERIC_READ = 0x120089, FILE_GENERIC_WRITE = 0x120116, FILE_GENERIC_EXECUTE = 0x1200a0

  /** Parse an SDDL rights string into bits, failing loudly on an unknown alias. */
  const rightsBits = rights => {
    if (/^0x[0-9a-f]+$/i.test(rights)) return Number.parseInt(rights, 16)
    let bits = 0, rest = rights
    while (rest.length > 0) {
      const alias = Object.keys(ALIASES).sort((a, b) => b.length - a.length).find(name => rest.startsWith(name))
      if (alias === undefined) throw new Error(`Unparsed SDDL access alias in ${JSON.stringify(rights)} at ${JSON.stringify(rest)}`)
      bits |= ALIASES[alias]
      rest = rest.slice(alias.length)
    }
    return bits
  }

  /**
   * Windows maps generic rights to the object type's specific rights while it
   * propagates an inheritable entry: a directory `GA` reaches a file as `FA`, and
   * `SDGXGWGR` as `0x1301bf`. Both sides are reduced through the file mapping first,
   * so a correctly inherited generic entry is not read as a missing one.
   */
  const specific = bits => {
    let value = bits & ~(GENERIC.GA | GENERIC.GR | GENERIC.GW | GENERIC.GX)
    if (bits & GENERIC.GA) value |= FILE_ALL_ACCESS
    if (bits & GENERIC.GR) value |= FILE_GENERIC_READ
    if (bits & GENERIC.GW) value |= FILE_GENERIC_WRITE
    if (bits & GENERIC.GX) value |= FILE_GENERIC_EXECUTE
    return value
  }
  const maskOf = entry => specific(rightsBits(entry.rights))

  await test('a created file inherits its directory grants and stays deletable in the same session', async () => {
    await withTempDir('file-inherited-dacl', async root => {
      const target = path.join(root, 'created.txt')
      const created = envelopeOf(await callTool('write_file', { path: target, content: 'created\n', expectedRevision: 'absent' }, { root }), assert)
      assert.equal(created.status, 'completed', JSON.stringify(created))
      const directory = sddl(root), file = sddl(target)
      const grants = inheritable(entries(directory))
      assert.ok(grants.length > 0, `the fixture directory carries no inheritable entry: ${directory}`)
      const published = entries(file)
      for (const grant of grants) {
        assert.ok(
          published.some(entry => entry.type === grant.type && maskOf(entry) === maskOf(grant) && entry.sid === grant.sid && entry.flags.includes('ID')),
          `the created file must inherit ${grant.type}/${grant.rights}/${grant.sid}: ${file}`,
        )
      }
      // Before the fix the file carried exactly one explicit ACE and nothing inherited.
      assert.ok(published.some(entry => entry.flags.includes('ID')), `the created DACL holds no inherited entry: ${file}`)
      const caller = callerSid()
      assert.ok(caller, 'the fixture owner SID must be readable')
      assert.ok(
        published.some(entry => entry.sid === caller && !entry.flags.includes('ID') && maskOf(entry) === FILE_ALL_ACCESS),
        `the caller keeps one explicit full-control entry: ${file}`,
      )
      assert.doesNotMatch(file, /D:P/, `the created DACL must not be protected: ${file}`)
      const removed = envelopeOf(await callTool('remove', { path: target, expectedRevision: created.revision }, { root }), assert)
      assert.equal(removed.status, 'completed', JSON.stringify(removed))
      assert.equal(fs.existsSync(target), false, 'the same session must be able to delete the file it created')
    })
  })
  report('file-inherited-dacl')
  process.exit(process.exitCode ?? 0)
}
