/**
 * The credential fence, and the two write-surface narrowings that come with it.
 *
 * Ported from PR #40 (WTStarMark): `lib/credential-policy.js`, `lib/session-temp.js`, the
 * `deny_roots` traversal skip in the native worker and the "a binary file does not fail the whole
 * `replace`" fix are that PR's work. The assertions here are this branch's, because this branch does
 * not add #40's `dsh-ops-linux` component: the same behaviour is driven through the file bridge and
 * the native worker this branch actually ships, so what is asserted is the code that ships here.
 *
 * What this locks in:
 *
 * - A read of a credential location is refused **before the worker is spawned**, for a single path
 *   and for a batch root, and the refusal names the fence and the way out.
 * - A traversal skips credential directories by identity: `glob` never reports a file below one and
 *   `grep` never matches inside one. The case runs the same call with and without `deny_roots`, so
 *   the skip is what makes the difference rather than an unrelated walker rule.
 * - `DSH_OPS_DENY_READ` only ever *widens* the fence, which is what lets these cases run without
 *   touching the operator's real `~/.ssh`.
 * - A directory holding one binary file is no longer an impossible `replace`: the text around it is
 *   edited, the binary is reported as skipped, and the report names it.
 * - The shared system temp is no longer endorsed as a write root: the session's own directory is,
 *   and its name is derived from the session id so two sessions cannot address each other's.
 *
 * Not asserted, and why: the kernel's own grant (`/tmp` for workspace-write under Landlock) is
 * wider than this fence, so a *confined command* run through `ops_bash` can still reach another
 * session's temp files. That is the host sandbox's decision, not this plugin's; what the plugin
 * controls — which paths its own tools endorse — is what is asserted here.
 *
 * @module dsh-ops/test/credential-fence
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { callWorker, envelopeOf, request, requireWorker } from './lib/boundary.mjs'
import { credentialPath, credentialRoots, credentialRefusal, DENY_ENV } from '../lib/credential-policy.js'
import { invoke } from '../lib/file/worker.js'
import { sessionTempDir, SESSION_TEMP_PREFIX } from '../lib/session-temp.js'

requireWorker('credential-fence')

/** Run one case with `DSH_OPS_DENY_READ` naming extra denied paths, then restore the environment. */
async function withDenyEnv(entries, body) {
  const previous = process.env[DENY_ENV]
  process.env[DENY_ENV] = entries.join(path.delimiter)
  try { return await body() } finally {
    if (previous === undefined) delete process.env[DENY_ENV]
    else process.env[DENY_ENV] = previous
  }
}

/** Run one case with `HOME` pointing at a fixture, then restore it. */
async function withFakeHome(home, body) {
  const previous = process.env.HOME
  process.env.HOME = home
  try { return await body() } finally { process.env.HOME = previous }
}

await test('the policy denies credential directories below the home by whole component', async () => {
  await withTempDir('credential-policy-home', async home => {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE')
    const deny = candidate => credentialPath(candidate, { home, env: {} })
    assert.equal(deny(path.join(home, '.ssh', 'id_ed25519')).denied, true)
    assert.equal(deny(path.join(home, '.ssh')).denied, true)
    assert.equal(deny(path.join(home, '.aws', 'credentials')).denied, true)
    // Whole components only: a file whose name merely mentions ssh is not a credential store.
    fs.writeFileSync(path.join(home, 'ssh-notes.txt'), 'notes')
    assert.equal(deny(path.join(home, 'ssh-notes.txt')).denied, false)
    assert.equal(deny(path.join(home, 'work', 'main.rs')).denied, false)
    // Credential directory names are matched case-insensitively on every host so
    // casing cannot be used to walk around the fence.
    const cased = deny(path.join(home, '.SSH', 'config'))
    assert.equal(cased.denied, true, 'credential directory names are case-insensitive')
  })
})

await test('the policy denies a private key or credential store wherever it lives', async () => {
  await withTempDir('credential-policy-names', async workspace => {
    const deny = candidate => credentialPath(candidate, { home: workspace, env: {} })
    for (const name of ['id_rsa', 'id_ed25519.pub', 'service-account-prod.json', 'app-credentials.yaml', '.env', '.env.local'])
      assert.equal(deny(path.join(workspace, 'src', name)).denied, true, `${name} must be denied by name`)
    // The name patterns are deliberately over-inclusive around keys: anything that starts with
    // `id_<algo>.` is denied, including a text file beside the key. Over-denial of a key's
    // neighbours is the safe direction; the cost is a refusal the operator can see by name.
    assert.equal(deny(path.join(workspace, 'src', 'id_rsa.pub.txt')).denied, true)
    for (const name of ['credentials-notes.md', 'environment.ts', 'identity.ts'])
      assert.equal(deny(path.join(workspace, 'src', name)).denied, false, `${name} must not be denied`)
  })
})

await test('the environment variable widens the fence and cannot narrow it', async () => {
  await withTempDir('credential-policy-env', async workspace => {
    const secret = path.join(workspace, 'vault', 'token.txt')
    fs.mkdirSync(path.dirname(secret), { recursive: true })
    fs.writeFileSync(secret, 'token')
    assert.equal(credentialPath(secret, { home: workspace, env: {} }).denied, false)
    // An absolute entry is used as written — the refusal message prints an absolute path, so
    // pasting it back has to work — and it needs no home at all.
    const widened = credentialPath(secret, { home: workspace, env: { [DENY_ENV]: path.join(workspace, 'vault') } })
    assert.equal(widened.denied, true)
    assert.equal(widened.matched, path.join(workspace, 'vault'))
    assert.equal(credentialPath(secret, { env: { [DENY_ENV]: path.join(workspace, 'vault') } }).denied, true, 'an absolute entry must not need a home')
    // A relative entry stays relative to the home.
    assert.equal(credentialPath(path.join(workspace, '.mysecrets', 'token'), { home: workspace, env: { [DENY_ENV]: '.mysecrets' } }).denied, true)
    // A fence can be widened from here, never removed: the home suffixes stay denied.
    const ssh = credentialPath(path.join(workspace, '.ssh', 'config'), { home: workspace, env: { [DENY_ENV]: path.join(workspace, 'vault') } })
    assert.equal(ssh.denied, true)
    const roots = credentialRoots({ home: workspace, env: { [DENY_ENV]: path.join(workspace, 'vault') } })
    assert.ok(roots.includes(path.join(workspace, '.ssh').split(path.sep).join('/')), `expected .ssh among ${roots.join(', ')}`)
    assert.ok(roots.some(root => root.endsWith('/vault')), 'the environment entry is a traversal root too')
    // A file-shaped suffix is not a traversal root: skipping its parent would hide the whole home.
    assert.ok(roots.some(root => root.endsWith('/.npmrc')), 'a denied file is a narrow traversal root, not its parent')
  })
})

await test('a symlink into a credential directory is denied by its target', async () => {
  await withTempDir('credential-policy-link', async workspace => {
    const home = path.join(workspace, 'home')
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE')
    const link = path.join(workspace, 'innocent')
    fs.symlinkSync(path.join(home, '.ssh'), link, process.platform === 'win32' ? 'junction' : 'dir')
    const verdict = credentialPath(path.join(link, 'id_ed25519'), { home, env: {} })
    assert.equal(verdict.denied, true, 'a link must not be a way around the fence')
    assert.match(credentialRefusal(link, verdict.matched).message, /credential location/)
  })
})

await test('the session temporary directory is per session, stable and never the shared temp root', async () => {
  const first = sessionTempDir('session-a', '/tmp')
  assert.equal(first, sessionTempDir('session-a', '/tmp'), 'the same session keeps its directory')
  assert.notEqual(first, sessionTempDir('session-b', '/tmp'), 'two sessions must not share one directory')
  assert.ok(path.basename(first).startsWith(SESSION_TEMP_PREFIX), `unexpected name ${path.basename(first)}`)
  assert.equal(path.dirname(first), path.normalize('/tmp'))
  assert.ok(!first.includes('session-a'), 'the name is derived, not the raw session id')
})

await test('the file bridge refuses a credential path before the worker is spawned', async () => {
  await withTempDir('credential-bridge', async workspace => {
    const home = path.join(workspace, 'home')
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    const key = path.join(home, '.ssh', 'id_ed25519')
    fs.writeFileSync(key, 'PRIVATE')
    let spawned = false
    const ctx = { get: name => ({
      workingDirectory: { ensure: async agent => agent.session.header.cwd },
      sandboxPolicy: { resolve: () => ({ mode: 'read-only', workspaceRoot: workspace }) },
      subprocess: { spawn: () => { spawned = true; throw new Error('the fence must refuse before spawning') } },
      opsKernel: { file: path.join(workspace, 'worker'), available: true,
        invoke() { spawned = true; throw new Error('the fence must refuse before kernel admission') } },
    })[name] }
    const exec = { agent: { session: { id: 's-fence', header: { cwd: workspace } } } }
    await withFakeHome(home, async () => {
      const refused = await invoke(ctx, path.join(workspace, 'worker'), 'inspect_local_file', { path: key }, exec, undefined, { denyCredentialReads: true })
      assert.equal(refused.status, 'rejected', JSON.stringify(refused))
      assert.match(JSON.stringify(refused), /credential location/)
      assert.equal(refused.error.code, 'CREDENTIAL_DENIED')
      assert.equal(refused.error.permission, undefined)
      assert.match(refused.error.nextAction, /credential fence|operator/i)
      assert.equal(spawned, false, 'the refusal must happen before the worker is spawned')

      // The row-level opt-out reaches the call: with the fence off the refusal is not what stops it.
      let reached = 'none'
      try { reached = JSON.stringify(await invoke(ctx, path.join(workspace, 'worker'), 'inspect_local_file', { path: key }, exec, undefined, { denyCredentialReads: false })) }
      catch (error) { reached = String(error?.message ?? error) }
      assert.ok(!/credential location/.test(reached), `the opt-out must bypass the fence, got: ${reached}`)
      assert.equal(spawned, true, 'with the fence off the call proceeds to the spawn step')
    })
  })
})

await test('a traversal skips a denied root, and reports it when the root is not denied', async () => {
  await withTempDir('credential-traversal', async workspace => {
    const denied = path.join(workspace, 'vault')
    fs.mkdirSync(denied, { recursive: true })
    fs.writeFileSync(path.join(workspace, 'ok.txt'), 'PLAIN\n')
    fs.writeFileSync(path.join(denied, 'secret.txt'), 'SECRET\n')

    const requestFor = (tool, args) => JSON.stringify({ ...request(tool, args, { root: workspace }), deny_roots: [denied] })
    const globbed = envelopeOf(await callWorker(requestFor('glob', { path: workspace, pattern: ['**/*.txt'] })), assert)
    assert.equal(globbed.matched, 1, `only the file outside the denied root may match: ${JSON.stringify(globbed)}`)
    assert.ok(!JSON.stringify(globbed).includes('secret.txt'), `the denied root leaked into the glob: ${JSON.stringify(globbed)}`)

    const grepped = envelopeOf(await callWorker(requestFor('grep', { path: workspace, pattern: 'SECRET' })), assert)
    assert.equal(grepped.matched, 0, `denied content leaked: ${JSON.stringify(grepped)}`)
    assert.ok(!JSON.stringify(grepped).includes('SECRET'), 'no match text may come back from a denied root')

    // The same call without `deny_roots` does find it: the skip is what makes the difference.
    const open = envelopeOf(await callWorker(JSON.stringify(request('grep', { path: workspace, pattern: 'SECRET' }, { root: workspace }))), assert)
    assert.equal(open.matched, 1, `the control case must match: ${JSON.stringify(open)}`)
  })
})

await test('one binary file no longer fails a whole replace, and is reported as skipped', async () => {
  await withTempDir('credential-binary', async workspace => {
    fs.writeFileSync(path.join(workspace, 'text.txt'), 'OLD\n')
    fs.writeFileSync(path.join(workspace, 'icon.bin'), Buffer.from([0x00, 0xff, 0x10, 0x80]))
    const options = { root: workspace, writeRoots: [workspace] }

    const observed = envelopeOf(await callWorker(JSON.stringify({ ...request('replace', { path: workspace, pattern: 'OLD', replacement: 'NEW', dryRun: true }, options) })), assert)
    assert.equal(observed.status, 'completed', JSON.stringify(observed))
    assert.equal(observed.matched, 1)
    assert.equal(observed.skipped, 1, `the binary must be reported, got ${JSON.stringify(observed)}`)
    assert.deepEqual(observed.skippedPaths.map(file => path.basename(file)), ['icon.bin'], `skippedPaths must name it: ${JSON.stringify(observed.skippedPaths)}`)

    const applied = envelopeOf(await callWorker(JSON.stringify({ ...request('replace', { path: workspace, pattern: 'OLD', replacement: 'NEW' }, options) })), assert)
    assert.equal(applied.changed, 1, JSON.stringify(applied))
    assert.equal(fs.readFileSync(path.join(workspace, 'text.txt'), 'utf8'), 'NEW\n')
    assert.deepEqual([...fs.readFileSync(path.join(workspace, 'icon.bin'))], [0x00, 0xff, 0x10, 0x80], 'the binary is untouched')
  })
})

await test('recursive file requests and batch copies enforce credential policy on every child', async () => {
  await withTempDir('credential-recursive', async workspace => {
    fs.writeFileSync(path.join(workspace, 'service-account-prod.json'), 'SECRET_TOKEN\n')
    fs.writeFileSync(path.join(workspace, 'public.txt'), 'PUBLIC_TOKEN\n')
    const run = async (tool, args, policy = true) => envelopeOf(await callWorker(JSON.stringify({
      root: workspace, scope: 'recursive', tool, args,
      deny_credential_names: policy,
      deny_roots: [path.join(workspace, '.ssh')],
    })), assert)
    assert.equal((await run('inspect_local_file', { path: path.join(workspace, 'service-account-prod.json') })).error.code, 'CREDENTIAL_DENIED')
    const search = await run('grep', { path: workspace, pattern: 'SECRET_TOKEN' })
    assert.equal(search.matched, 0, JSON.stringify(search))
    assert.equal((await run('grep', { path: workspace, pattern: 'SECRET_TOKEN' }, false)).matched, 1)
    const copy = await run('batch', { action: 'plan', operations: [{ op: 'copy', path: 'service-account-prod.json', to: 'exposed.txt' }] })
    assert.equal(copy.error.code, 'CREDENTIAL_DENIED', JSON.stringify(copy))
    fs.mkdirSync(path.join(workspace, '.ssh')); fs.writeFileSync(path.join(workspace, '.ssh/config'), 'private')
    assert.equal((await run('batch', { action: 'plan', operations: [{ op: 'copy', path: '.ssh/config', to: 'exposed.txt' }] })).error.code, 'CREDENTIAL_DENIED')
    assert.equal(fs.existsSync(path.join(workspace, 'exposed.txt')), false)
  })
})

await test('the fence refuses writes and copy destinations, and the wording names both directions', async () => {
  await withTempDir('credential-directions', async workspace => {
    const home = path.join(workspace, 'home')
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    const key = path.join(home, '.ssh', 'id_ed25519')
    fs.writeFileSync(key, 'PRIVATE\n')
    fs.writeFileSync(path.join(workspace, 'plain.txt'), 'PLAIN\n')
    let spawned = false
    const ctx = { get: name => ({
      workingDirectory: { ensure: async agent => agent.session.header.cwd },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
      subprocess: { spawn: () => { spawned = true; throw new Error('the fence must refuse before spawning') } },
    })[name] }
    const exec = { agent: { session: { id: 's-directions', header: { cwd: workspace } } } }
    const worker = path.join(workspace, 'worker')
    const config = { denyCredentialReads: true }
    await withFakeHome(home, async () => {
      const read = await invoke(ctx, worker, 'inspect_local_file', { path: key }, exec, undefined, config)
      const written = await invoke(ctx, worker, 'write', { path: key, content: 'OVERWRITTEN\n' }, exec, undefined, config)
      const copied = await invoke(ctx, worker, 'copy', { path: path.join(workspace, 'plain.txt'), to: key }, exec, undefined, config)
      for (const [label, refused] of [['a read', read], ['a write', written], ['a copy destination', copied]]) {
        assert.equal(refused.error?.code, 'CREDENTIAL_DENIED', label + ' must be refused: ' + JSON.stringify(refused))
        assert.match(refused.error.message, /credential location/)
      }
      assert.equal(spawned, false, 'every refusal must happen before the worker is spawned')
      assert.equal(fs.readFileSync(key, 'utf8'), 'PRIVATE\n', 'a refused write must not touch the file')
    })

    // The refusal is direction-neutral on purpose: a caller stopped from writing must not read the
    // wording as "reads are fenced, writes are fine" (#204 P4).
    const refusal = credentialRefusal(key, '~/.ssh')
    assert.match(refusal.message, /neither read nor write/)
    assert.ok(!/do not read credentials/.test(refusal.message))

    // And the configuration reference states the same reach the implementation has, so the two
    // cannot drift apart silently.
    const doc = fs.readFileSync(new URL('../docs/configuration-reference.md', import.meta.url), 'utf8')
    assert.match(doc, /The credential fence/)
    assert.match(doc, /as a write/)
  })
})

await test('the fence refuses every direction on a credential path, including writes', async () => {
  await withTempDir('credential-directions', async workspace => {
    const home = path.join(workspace, 'home')
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    const key = path.join(home, '.ssh', 'id_rsa')
    fs.writeFileSync(key, 'PRIVATE')
    const source = path.join(workspace, 'source.txt')
    fs.writeFileSync(source, 'payload')

    let spawned = 0
    // danger-full-access is the decisive case: the DSH permission mode allows the write, so a
    // refusal here can only come from this fence.
    const ctx = { get: name => ({
      workingDirectory: { ensure: async agent => agent.session.header.cwd },
      sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workspace }) },
      subprocess: { spawn: () => { spawned += 1; throw new Error('the fence must refuse before spawning') } },
    })[name] }
    const exec = { agent: { session: { id: 's-directions', header: { cwd: workspace } } } }
    const worker = path.join(workspace, 'worker')

    await withFakeHome(home, async () => {
      const cases = [
        ['inspect_local_file', { path: key }],
        ['write_file', { path: key, content: 'PWN', expectedRevision: 'absent' }],
        ['replace', { path: key, pattern: 'PRIVATE', replacement: 'PWN' }],
        ['copy', { path: source, to: key }],
        ['remove', { path: key, expectedRevision: 'whatever' }],
      ]
      for (const [tool, toolArgs] of cases) {
        const refused = await invoke(ctx, worker, tool, toolArgs, exec, undefined, { denyCredentialReads: true })
        assert.equal(refused.status, 'rejected', `${tool}: ${JSON.stringify(refused)}`)
        assert.equal(refused.error.code, 'CREDENTIAL_DENIED', `${tool} must be refused by the fence: ${JSON.stringify(refused)}`)
        assert.match(refused.error.message, /read|write|copy|replace|remov/i, `${tool} refusal must name the directions: ${refused.error.message}`)
      }
      assert.equal(spawned, 0, 'every direction must be refused before the worker is spawned')
      assert.equal(fs.readFileSync(key, 'utf8'), 'PRIVATE', 'the credential file is untouched')
    })
  })
})

report('credential-fence')
