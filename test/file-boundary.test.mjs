/** The workspace boundary the four native file tools share, plus the temporary-root admission under it (#75/#76). */
import fs from 'node:fs'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { authorizedRoots } from '../lib/file/worker.js'
import { FILE_TOOLS, publicToolName } from '../lib/policy.js'
import { assert, report, TEST_HOME, test, withTempDir } from './lib/harness.mjs'
import { bootHost, callTool, mountPlugin, shutdown } from './lib/host.mjs'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'

const SENTINEL = 'boundarysecret6c1f'
// Absent paths keep their literal form through `canonical()`, so admission needs no fixture on disk.
const WORKSPACE = path.join(tmpdir(), 'file-boundary-workspace')
const TEMPORARY = path.join(tmpdir(), 'file-boundary-tmp')
const HOME = path.join(tmpdir(), 'file-boundary-home')
/** The host temporary area this suite owns; see {@link withTemporaryEnv}. */
const HOST_TEMP = path.join(TEST_HOME, 'host-tmp')

await test('a temporary directory under the platform root is authorized beside the workspace', () => {
  assert.deepEqual(authorizedRoots({ workspaceRoot: WORKSPACE }, { platform: 'win32', tmpdir: TEMPORARY, homedir: HOME }),
    [WORKSPACE, TEMPORARY])
  // `/tmp` is the POSIX-only member of 0.3.0's set, and it is a symlink on some
  // hosts, so the portable fact is that the set grows by one there.
  assert.equal(authorizedRoots({ workspaceRoot: WORKSPACE }, { platform: 'linux', tmpdir: TEMPORARY, homedir: HOME }).length, 3)
})

await test('a temporary root as wide as the home directory or a volume root is never authorized', () => {
  assert.deepEqual(authorizedRoots({ workspaceRoot: WORKSPACE }, { platform: 'win32', tmpdir: HOME, homedir: HOME }), [WORKSPACE])
  // An ancestor of the home directory widens just as far, a volume root further.
  assert.deepEqual(authorizedRoots({ workspaceRoot: WORKSPACE }, { platform: 'win32', tmpdir: path.dirname(HOME), homedir: HOME }), [WORKSPACE])
  assert.deepEqual(authorizedRoots({ workspaceRoot: WORKSPACE }, { platform: 'win32', tmpdir: path.parse(tmpdir()).root, homedir: HOME }), [WORKSPACE])
})

await test('an unusable home directory drops every temporary root', () => {
  // os.homedir() answers '' when it cannot name the home directory, and a
  // relative answer cannot be compared at all.
  for (const unusable of ['', path.join('relative', 'home')]) {
    assert.deepEqual(authorizedRoots({ workspaceRoot: WORKSPACE }, { platform: 'win32', tmpdir: TEMPORARY, homedir: unusable }),
      [WORKSPACE], `homedir=${JSON.stringify(unusable)}`)
  }
})

const covers = (root, target) => {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

await test('a temporary root that resolves to a volume root or above the home directory is never authorized', async () => {
  await withTempDir('file-boundary-alias', async dir => {
    // A link's name carries no volume or home information; only what it resolves to does.
    const alias = target => { const at = path.join(dir, `alias-${path.basename(target) || 'volume'}`)
      fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return at }
    for (const [label, target] of [['the volume root', path.parse(tmpdir()).root], ['the home directory parent', path.dirname(HOME)]]) {
      const roots = authorizedRoots({ workspaceRoot: WORKSPACE }, { platform: 'win32', tmpdir: alias(target), homedir: HOME })
      assert.equal(roots.includes(target), false, `${label} must not be authorized`)
      assert.equal(roots.some(root => covers(root, HOME)), false, `${label} must not cover the home directory`)
    }
  })
})

const { ctx } = await bootHost()
if (!ctx.get('subprocess')) await ctx.plugin(Subprocess)
if (!ctx.get('sandbox')) await ctx.plugin(Sandbox, {})
await ctx.plugin(inner => inner.provide('sandboxPolicy', {
  resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
}))
await mountPlugin({ ctx, config: { toolCallTimeoutMs: 5000 }, expectTools: FILE_TOOLS.length })
fs.mkdirSync(HOST_TEMP, { recursive: true })

async function agentForCall(cwd, mode = 'danger-full-access') {
  const result = { id: 'file-call', session: { id: 'file-call', mode, header: { cwd } } }
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  result.ctx = createScope(ctx, result).ctx
  return result
}

/**
 * Point the host temporary areas at `value` for the duration of `body`.
 *
 * `test/run.mjs` puts DSH_HOME inside the platform temporary directory, so a
 * fixture beside the workspace would itself be an authorized temporary area and
 * "outside every root" could not be stated at all. The workspace stays authorized
 * by the policy, not by TEMP, so the fence is not softened here.
 */
async function withTemporaryEnv(value, body) {
  const keys = ['TEMP', 'TMP', 'TMPDIR']
  const previous = keys.map(key => [key, process.env[key]])
  for (const key of keys) process.env[key] = value
  try { return await body() } finally {
    for (const [key, old] of previous) { if (old === undefined) delete process.env[key]; else process.env[key] = old }
  }
}

await test('the file tools reject a path outside the workspace and the temporary area', async () => {
  await withTempDir('file-boundary-inside', async inside => {
    await withTempDir('file-boundary-outside', async outside => {
      await withTemporaryEnv(HOST_TEMP, async () => {
        const secret = path.join(outside, 'secret.txt')
        fs.writeFileSync(secret, `${SENTINEL}\n`)
        const agent = await agentForCall(inside, 'workspace-write')
        const calls = [
          ['inspect_local_file', { path: secret }],
          ['inspect_local_file', { path: path.join('..', path.basename(outside), 'secret.txt') }],
          ['grep', { path: outside, pattern: SENTINEL }],
          ['glob', { path: outside, pattern: ['**/*.txt'] }],
          ['replace', { path: secret, pattern: SENTINEL, replacement: 'changed' }],
        ]
        for (const [tool, args] of calls) {
          const result = await callTool(ctx, publicToolName(tool), args, undefined, agent)
          const where = `${tool} ${args.path}`
          assert.equal(result.value.status, 'rejected', where)
          assert.equal(result.value.error?.code, 'POLICY_DENIED', where)
          // Rejected before the worker runs, so no byte may reach the model.
          assert.equal(result.text.includes(SENTINEL), false, where)
        }
        assert.equal(fs.readFileSync(secret, 'utf8'), `${SENTINEL}\n`)
      })
    })
  })
})

await test('paths inside the workspace and inside the temporary area keep working', async () => {
  await withTempDir('file-boundary-workspace', async dir => {
    await withTemporaryEnv(HOST_TEMP, async () => {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n')
      fs.writeFileSync(path.join(HOST_TEMP, 'probe.txt'), 'temparea\n')
      const agent = await agentForCall(dir, 'workspace-write')
      const calls = [
        ['inspect_local_file', { path: path.join(dir, 'a.txt') }, 'alpha'],
        ['inspect_local_file', { path: 'a.txt' }, 'alpha'],
        ['glob', { path: dir, pattern: ['**/*.txt'] }, 'a.txt'],
        // Reads share the write fence's roots: an accepted temporary area stays readable.
        ['inspect_local_file', { path: path.join(HOST_TEMP, 'probe.txt') }, 'temparea'],
      ]
      for (const [tool, args, expected] of calls) {
        const result = await callTool(ctx, publicToolName(tool), args, undefined, agent)
        const where = `${tool} ${args.path}`
        assert.equal(result.value.status, 'completed', where)
        assert.equal(result.text.includes(expected), true, where)
      }
      // The same filtered roots travel to the worker as write_roots.
      const victim = path.join(HOST_TEMP, 'dsh-ops-probe', 'victim.txt')
      fs.mkdirSync(path.dirname(victim), { recursive: true })
      fs.writeFileSync(victim, 'before\n')
      const written = await callTool(ctx, publicToolName('replace'), { path: victim, pattern: 'before', replacement: 'after' }, undefined, agent)
      assert.equal(written.value.status, 'completed')
      assert.equal(written.value.changed, 1)
      assert.equal(fs.readFileSync(victim, 'utf8'), 'after\n')
    })
  })
})

await test('a missing path inside the workspace stays reachable, while an escape link does not hide one', async () => {
  await withTempDir('file-boundary-typo', async dir => {
    await withTempDir('file-boundary-escape', async outside => {
      await withTemporaryEnv(HOST_TEMP, async () => {
        // The fence weighs a target against resolved roots, so a target that does not exist
        // yet has to resolve through its deepest existing ancestor to be comparable at all.
        fs.symlinkSync(outside, path.join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
        const agent = await agentForCall(dir, 'workspace-write')
        const missing = await callTool(ctx, publicToolName('inspect_local_file'), { path: 'typo.txt' }, undefined, agent)
        assert.equal(missing.value.error?.code, 'NOT_FOUND', 'a missing file inside the workspace is a not-found, not a denial')
        const escaped = await callTool(ctx, publicToolName('inspect_local_file'), { path: path.join('escape', 'ghost.txt') }, undefined, agent)
        assert.equal(escaped.value.error?.code, 'POLICY_DENIED', 'a missing path behind a link out of the workspace stays denied')
      })
    })
  })
})

await test('a temporary root at the home directory or a filesystem root authorizes nothing', async () => {
  await withTempDir('file-boundary-wide-root', async dir => {
    const agent = await agentForCall(dir, 'workspace-write')
    // The two misconfigurations #76 reports: TMPDIR=$HOME loses the whole home
    // directory, TMPDIR=C:\ loses the whole volume.
    for (const wide of [homedir(), path.parse(tmpdir()).root]) {
      const victim = path.join(wide, 'dsh-ops-boundary-victim.txt')
      await withTemporaryEnv(wide, async () => {
        const result = await callTool(ctx, publicToolName('replace'), { path: victim, pattern: 'before', replacement: 'after' }, undefined, agent)
        assert.equal(result.value.error?.code, 'POLICY_DENIED', `TEMP=${wide}`)
        assert.equal(fs.existsSync(victim), false, `TEMP=${wide}`)
      })
    }
  })
})

await test('danger-full-access still reads outside the workspace', async () => {
  await withTempDir('file-boundary-fullaccess', async dir => {
    await withTempDir('file-boundary-elsewhere', async elsewhere => {
      await withTemporaryEnv(HOST_TEMP, async () => {
        const secret = path.join(elsewhere, 'secret.txt')
        fs.writeFileSync(secret, `${SENTINEL}\n`)
        const agent = await agentForCall(dir, 'danger-full-access')
        const result = await callTool(ctx, publicToolName('inspect_local_file'), { path: secret }, undefined, agent)
        assert.equal(result.value.status, 'completed')
        assert.equal(result.text.includes(SENTINEL), true)
      })
    })
  })
})

await shutdown(ctx)

report('file-boundary')
