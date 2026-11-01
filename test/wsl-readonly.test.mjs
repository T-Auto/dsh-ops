/** Public cursor/path/coverage contracts, independent of an installed WSL distribution. */
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { invoke } from '../lib/execution/files.js'
import { wslPath, linuxPath, cursorIdentity, wrapCursor, unwrapCursor, windowsResult, inlineWslResult } from '../lib/execution/wsl-paths.js'
import { tryWslRead } from '../lib/execution/wsl-worker.js'
import { workerEnvelope } from '../lib/execution/protocol.js'

await test('both WSL UNC aliases retain case-sensitive filenames and reject other authorities', () => {
  for (const server of ['wsl.localhost', 'wsl$']) {
    const value = wslPath(`\\\\${server}\\Ubuntu\\home\\pc\\Case.txt`)
    assert.equal(value.distro, 'Ubuntu'); assert.equal(value.file, '/home/pc/Case.txt')
    assert.equal(linuxPath(`\\\\${server}\\Ubuntu\\home\\pc\\Case.txt`, 'Ubuntu', new Map()), '/home/pc/Case.txt')
  }
  assert.equal(wslPath('\\\\server\\share\\file'), undefined)
  assert.equal(linuxPath('\\\\wsl.localhost\\Debian\\home\\pc', 'Ubuntu', new Map()), undefined)
  assert.equal(linuxPath('C:\\Users\\pc\\.ssh', 'Ubuntu', new Map([['C:', '/windows/c']])), '/windows/c/Users/pc/.ssh')
  assert.equal(linuxPath('D:\\private', 'Ubuntu', new Map([['C:', '/mnt/c']])), undefined)
  assert.equal(wslPath('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\tmp').file, '/tmp')
})

await test('opaque cursors retain native validation bytes and bind distro, payload and path policy', () => {
  const identity = cursorIdentity('Ubuntu', 'a'.repeat(64))
  const native = `s1:${'b'.repeat(64)}:${'c'.repeat(64)}:${'9'.repeat(20)}:${'d'.repeat(64)}`
  const wrapped = wrapCursor(native, identity)
  assert.equal(wrapped.length, 254); assert.equal(unwrapCursor(wrapped, identity), native)
  assert.equal(cursorIdentity('ubuntu', 'a'.repeat(64)), identity)
  assert.equal(unwrapCursor(wrapped, cursorIdentity('Debian', 'a'.repeat(64))), undefined)
  assert.equal(unwrapCursor(wrapped, cursorIdentity('Ubuntu', 'e'.repeat(64))), undefined)
  assert.equal(unwrapCursor(`${wrapped}0`, identity), undefined)
  assert.equal(unwrapCursor(native, identity), undefined)
  assert.throws(() => wrapCursor('s1:invalid', identity))
})

await test('path mapping preserves file contents and nested read ranges without rewriting arbitrary strings', () => {
  const value = { status: 'partial', path: '/project/a', items: [{ path: '/project/a', items: [{ path: '/project/a', text: '/project/a is source text' }] }] }
  const before = structuredClone(value), root = '\\\\wsl.localhost\\Ubuntu'
  const mapped = windowsResult(value, root, 'read_files')
  assert.equal(mapped.items[0].items[0].path, `${root}\\project\\a`)
  assert.equal(mapped.items[0].items[0].text, '/project/a is source text')
  assert.deepEqual(value, before)
  assert.deepEqual(windowsResult({ items: ['/project/a'] }, root, 'glob').items, [`${root}\\project\\a`])
  assert.throws(() => windowsResult({ items: ['relative'] }, root, 'glob'))
})

await test('bounded ranges and search pages stay inline; clipping and enlarged UNC output require storage', () => {
  const read = { status: 'partial', complete: false, truncated: false, pending: 0, nextIndex: 1, total: 1,
    items: [{ complete: false, truncated: false, nextOffset: 201, path: '/a', items: [{ text: 'a', line: 1 }] }] }
  assert.equal(inlineWslResult(read, 'read_files', 131072), true)
  for (const value of [{ ...read, pending: 1 }, { ...read, truncated: true }, { ...read, reference: {} },
    { ...read, storageError: {} }, { ...read, items: [{ truncatedInLine: true }] }]) assert.equal(inlineWslResult(value, 'read_files', 131072), false)
  const search = { status: 'completed', complete: false, truncated: true, pageComplete: true, truncatedBy: 'row-limit', items: ['/a'] }
  assert.equal(inlineWslResult(search, 'glob', 131072), true)
  assert.equal(inlineWslResult({ ...search, truncatedBy: 'output-budget' }, 'glob', 131072), false)
  const raw = { ...search, items: Array.from({ length: 80 }, () => '/a') }
  const mapped = windowsResult(raw, '\\\\wsl.localhost\\Ubuntu', 'glob')
  assert.equal(inlineWslResult(raw, 'glob', 1000), true)
  assert.equal(inlineWslResult(mapped, 'glob', 1000), false)
})

await test('Windows cursors, mutations and explicit worker selections never start an optional WSL process', async () => {
  const subprocess = { spawn: () => { throw new Error('unexpected spawn') } }
  const call = (tool, args, config) => tryWslRead(subprocess, '/explicit-worker',
    workerEnvelope('file', { tool, args, root: '\\\\wsl.localhost\\Ubuntu\\project' }), 'C:\\', new AbortController().signal, () => true, config, { platform: 'win32', env: { DSH_OPS_WSL_READS: '1' } })
  assert.equal((await call('glob', { continuation: 's1:windows' })).handled, false)
  assert.equal((await call('write_file', { path: 'a', content: 'x' })).handled, false)
  assert.equal((await call('read_files', { files: [{ path: 'a' }] }, { binaryPath: '/explicit-worker' })).handled, false)
  const pinned = await call('glob', { continuation: `w1:${'a'.repeat(32)}:missing` })
  assert.equal(pinned.handled, true); assert.equal(pinned.value.error.code, 'EXECUTOR_UNAVAILABLE')
  const disabled = await tryWslRead(subprocess, '/unused', workerEnvelope('file', { tool: 'glob', args: { continuation: 'w1:old' } }),
    'C:\\', new AbortController().signal, () => true, undefined, { platform: 'win32', env: {} })
  assert.equal(disabled.value.error.code, 'EXECUTOR_UNAVAILABLE')
})
await test('disabled delegation cannot open an await gap after the final Windows authority check', async () => {
  await withTempDir('wsl-fallback-revocation', async root => {
    for (const cancel of [false, true]) {
      const { ctx } = await bootHost(); const controller = new AbortController()
      let mode = 'danger-full-access', resolutions = 0, spawned = 0
      try {
        await ctx.plugin(inner => {
          inner.provide('sandboxPolicy', { resolve: () => {
            if (++resolutions === 2) queueMicrotask(() => { if (cancel) controller.abort(); else mode = 'read-only' })
            return { mode, workspaceRoot: root }
          } })
          inner.provide('subprocess', { spawn: () => { spawned++; throw new Error('revoked spawn') } })
        })
        const exec = { agent: { session: { id: `wsl-revoke-${cancel}`, header: { cwd: root } } } }
        const value = await invoke(ctx, '/unused', 'write_file', { path: 'a.txt', content: 'x', expectedRevision: 'absent' }, exec, controller.signal, { denyCredentialReads: false })
        assert.equal(spawned, 0)
        assert.equal(value.error.effectState, 'none')
        if (!cancel) assert.equal(value.error.code, 'POLICY_DENIED')
      } finally { await shutdown(ctx) }
    }
  })
})
report('wsl-readonly')
