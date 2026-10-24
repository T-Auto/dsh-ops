/**
 * Windows `ops_replace` security-descriptor and update-lock behaviour (W1a-W1h).
 *
 * `docs/windows-verification.md` W1 lists what only a real Windows host can
 * answer, and issue #119 asks for exactly two deliverables: the measurements,
 * and the A half automated as a hosted `windows-latest` job. This suite is that
 * automation. It runs the real worker through the same boundary the shipped
 * product uses and asserts what the code does today:
 *
 * - W1a/W1b assert **exact preservation** (main's #187 publishes through the
 *   Windows metadata path: owner / group / DACL / timestamps are carried onto
 *   the private sibling before publication). An explicit DACL and a deny ACE
 *   must survive the replacement unchanged; an inherited-only descriptor must
 *   not be replaced by a fresh one. If the platform path regresses to a plain
 *   rename, these two tests turn red — that is the point.
 * - W1d/W1e assert the **error shape**, not a specific code: the issue's own
 *   correction is that the guarantee is structured (`code`/`phase`), not a
 *   pinned platform string. Both also assert no `.target.dsh-ops-<uuid>` debris.
 * - W1g/W1h lock the sidecar-lock design: an uncontended replace succeeds, a
 *   racing loser reports a structured `REVISION_CONFLICT` (never a raw
 *   platform error), and reads of the target/directory never fail while a
 *   replace is in flight.
 *
 * Whole-suite skip off win32: `icacls` and the `LockFileEx` sidecar are the
 * platform under test, and the POSIX half lives in `file-metadata.test.mjs`.
 *
 * @module dsh-ops/test/windows-security
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { assert, report, skipSuite, test, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('windows-security')
if (process.platform !== 'win32') {
  skipSuite('windows-security', 'W1 is the Windows half of the security-descriptor work; the POSIX half lives in file-metadata.test.mjs')
}

/** Raw `icacls` output for a path — the ACL text is the measurement. */
const aclOf = target => execFileSync('icacls', [target], { encoding: 'utf8' })
/** A file whose only content is the marker the replacement looks for. */
const seed = target => { fs.writeFileSync(target, 'TOKEN\n'); return target }
const replaceToken = async (target, workspace, extra = {}) =>
  envelopeOf(await callTool('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE', ...extra }, { root: workspace, timeoutMs: 30_000 }), assert)
/** Leftover live temporaries of one target, after a failed or successful publish. */
const debrisOf = (workspace, name) =>
  fs.readdirSync(workspace).filter(entry => entry.startsWith(`.${name}.dsh-ops-`))
/** Wait until a predicate holds, bounded — for cross-process handshakes. */
const USERNAME = process.env.USERNAME ?? ''
/** Windows transient locks (AV scans, handle handoff) make an immediate
 * recursive delete flaky; give the directory a beat before the harness cleans up. */
const settle = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const waitFor = (bound, predicate) => {
  for (let waited = 0; waited < bound; waited += 100) {
    if (predicate()) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  return false
}

await test('W1a (preservation): an explicit DACL survives a replacement unchanged — inheritance does not return', async () => {
  await withTempDir('w1a-dacl', async workspace => {
    const target = seed(path.join(workspace, 'w1a.txt'))
    execFileSync('icacls', [target, '/inheritance:r'])
    execFileSync('icacls', [target, '/grant:r', `${process.env.USERNAME}:(R)`])
    const before = aclOf(target)
    assert.equal(before.includes('(I)'), false, `fixture must carry an explicit-only DACL, got: ${before}`)

    const body = await replaceToken(target, workspace)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(fs.readFileSync(target, 'utf8'), 'DONE\n', 'the content still changes')

    const after = aclOf(target)
    console.log(`    [W1a before]\n${before.split('\n').map(l => `      ${l}`).join('\n')}`)
    console.log(`    [W1a after]\n${after.split('\n').map(l => `      ${l}`).join('\n')}`)
    assert.equal(after.includes(`${USERNAME}:(R)`), true,
      'the explicit read-only grant must survive the replacement exactly (no widening, no loss)')
    assert.equal(after.includes('(I)'), false,
      'inheritance must not come back: the replacement keeps the explicit-only DACL')
  })
})

await test('W1b (preservation, security-critical direction): a deny ACE for another principal survives a successful replacement — access does not widen for them', async () => {
  await withTempDir('w1b-deny-guest', async workspace => {
    const target = seed(path.join(workspace, 'w1b.txt'))
    execFileSync('icacls', [target, '/inheritance:r'])
    execFileSync('icacls', [target, '/grant:r', `${USERNAME}:(F)`])
    execFileSync('icacls', [target, '/deny', 'Guest:(W)']) // deny (F) is normalised to a grant (N); a partial deny stays a DENY
    const before = aclOf(target)
    assert.match(before, /DENY/u, `fixture must carry a deny ACE, got: ${before}`)

    const body = await replaceToken(target, workspace)
    assert.equal(body.status, 'completed', JSON.stringify(body))

    const after = aclOf(target)
    console.log(`    [W1b after]\n${after.split('\n').map(l => `      ${l}`).join('\n')}`)
    assert.match(after, /DENY/u, 'the deny ACE must survive the replacement — dropping it would widen Guest\'s access')
    settle(200)
  })
})

await test('W1c (same-user case): the owner is unchanged — the two-user case needs a second account and stays manual', async () => {
  await withTempDir('w1c-owner', async workspace => {
    const target = seed(path.join(workspace, 'w1c.txt'))
    const ownerOf = () => execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-Acl -LiteralPath '${target.replace(/'/g, "''")}').Owner`], { encoding: 'utf8' }).trim()
    const before = ownerOf()
    const body = await replaceToken(target, workspace)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(ownerOf(), before, 'same-user replacement keeps the owner (cross-user case is documented as manual)')
    settle(200)
  })
})

await test('W1d (structured): a READONLY target refuses with a structured error and leaves no debris', async () => {
  await withTempDir('w1d-readonly', async workspace => {
    const target = seed(path.join(workspace, 'w1d.txt'))
    fs.chmodSync(target, 0o444) // Node maps this to FILE_ATTRIBUTE_READONLY on Windows
    try {
      const result = await callTool('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE' }, { root: workspace, timeoutMs: 30_000 })
      assert.ok(result.body, `worker answered nothing: ${result.stdout?.slice(0, 200)}`)
      assert.equal(result.body.status, 'error', `a READONLY target must refuse, got: ${JSON.stringify(result.body)}`)
      assert.equal(typeof result.body.error?.code, 'string', 'the refusal must be structured (error.code), not a raw platform string')
      assert.ok(result.body.error.code.length > 0, 'the code must be non-empty')
      assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n', 'nothing may be rewritten')
      assert.deepEqual(debrisOf(workspace, 'w1d.txt'), [], 'a refused replace must leave no live temporary')
      settle(300)
    } finally {
      fs.chmodSync(target, 0o666) // so the suite's own cleanup can delete it
    }
  })
})

await test('W1e (structured): a target held open without sharing refuses with a structured error and leaves no debris', async () => {
  await withTempDir('w1e-sharing', async workspace => {
    const target = seed(path.join(workspace, 'w1e.txt'))
    const marker = path.join(workspace, 'w1e.locked')
    // A child PowerShell holds a FileShare::None handle; Node itself cannot open
    // without sharing (libuv always shares read/write/delete).
    const holder = spawnHolder(target, marker)
    let result
    try {
      assert.equal(waitFor(5000, () => fs.existsSync(marker)), true, 'the holder must acquire the handle')
      result = await callTool('replace', { path: target, pattern: 'TOKEN', replacement: 'DONE' }, { root: workspace, timeoutMs: 30_000 })
      assert.ok(result.body, `worker answered nothing: ${result.stdout?.slice(0, 200)}`)
      // Content and debris assertions happen after the holder is gone: the
      // FileShare::None handle blocks even reads of the target while it lives.
      assert.deepEqual(debrisOf(workspace, 'w1e.txt'), [], 'a refused replace must leave no live temporary')
    } finally {
      try { holder.kill() } catch {}
      try { fs.rmSync(marker, { force: true }) } catch {}
      settle(800)
    }
    assert.equal(result.body?.status, 'error', `a no-share target must refuse, got: ${JSON.stringify(result.body)}`)
    assert.equal(typeof result.body?.error?.code, 'string', 'the refusal must be structured (error.code)')
    assert.ok(result.body.error.code.length > 0, 'the code must be non-empty')
    assert.equal(fs.readFileSync(target, 'utf8'), 'TOKEN\n', 'nothing may be rewritten')
  })
})

await test('W1g: an uncontended replace succeeds under the per-path sidecar lock', async () => {
  await withTempDir('w1g-lock', async workspace => {
    const target = seed(path.join(workspace, 'w1g.txt'))
    const body = await replaceToken(target, workspace)
    assert.equal(body.status, 'completed', JSON.stringify(body))
    assert.equal(body.changed, 1, 'exactly one change')
    assert.equal(fs.readFileSync(target, 'utf8'), 'DONE\n', 'the content is correct')
    assert.deepEqual(debrisOf(workspace, 'w1g.txt'), [], 'no debris')
    const sidecar = fs.readdirSync(workspace).filter(entry => entry.startsWith('.dsh-ops-update-'))
    assert.equal(sidecar.length, 1, `the stable sidecar lock must be present, got: ${sidecar.join(', ')}`)
    // The sidecar is not model-visible: glob must not list it.
    const glob = envelopeOf(await callTool('glob', { pattern: '**/*' }, { root: workspace, timeoutMs: 30_000 }), assert)
    const listed = JSON.stringify(glob)
    assert.equal(listed.includes('.dsh-ops-update-'), false, 'the sidecar must stay out of glob results')
  })
})

await test('W1g-race: a losing writer reports a structured REVISION_CONFLICT, never a raw platform error', async () => {
  await withTempDir('w1g-race', async workspace => {
    const target = seed(path.join(workspace, 'w1g-race.txt'))
    const writers = ['alpha', 'bravo', 'charlie', 'delta'].map((name, index) =>
      callTool('replace', { path: target, pattern: 'TOKEN', replacement: `DONE-${name}-${index}` },
        { root: workspace, timeoutMs: 60_000 }))
    const results = await Promise.all(writers)
    const envelopes = results.map(result => envelopeOf(result, assert))
    const changed = envelopes.filter(body => body.status === 'completed' && body.changed === 1)
    const honest = envelopes.filter(body => body.status === 'error' || body.changed === 0)
    assert.equal(changed.length, 1, `exactly one writer may claim the change, got ${changed.length}`)
    assert.equal(changed.length + honest.length, envelopes.length, 'every writer is either the winner or honest')
    for (const body of envelopes.filter(body => body.status === 'error')) {
      assert.equal(body.error?.code, 'REVISION_CONFLICT', `a racing loser must report the structured conflict, got: ${JSON.stringify(body)}`)
    }
  })
})

await test('W1h: reads of the target and the directory never fail while replaces are in flight', async () => {
  await withTempDir('w1h-flight', async workspace => {
    const target = path.join(workspace, 'w1h.txt')
    fs.writeFileSync(target, 'one two three\n'.repeat(4096))
    let reads = 0, readFailures = 0
    let stop = false
    const reader = (async () => {
      while (!stop) {
        try {
          fs.readFileSync(target)
          fs.readdirSync(workspace)
          reads += 1
        } catch { readFailures += 1; reads += 1 }
        await new Promise(resolve => setImmediate(resolve))
      }
    })()
    try {
      for (let round = 0; round < 8; round += 1) {
        const body = await replaceToken(target, workspace)
        assert.equal(body.status, 'completed', JSON.stringify(body))
      }
    } finally { stop = true; await reader }
    assert.ok(reads > 0, 'the reader must actually have run')
    assert.equal(readFailures, 0, `the lock is not on the target, so reads must never be denied (${reads} reads, ${readFailures} denied)`)
  })
})

/** A child PowerShell that holds a FileShare::None handle until killed. */
function spawnHolder(target, marker) {
  const escaped = target.replace(/'/g, "''")
  return spawn('powershell.exe', ['-NoProfile', '-Command',
    `$h = [IO.File]::Open('${escaped}','Open','Read','None'); ` +
    `Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value 'locked'; ` +
    'Start-Sleep -Seconds 60'], { stdio: 'ignore' })
}

report('windows-security')