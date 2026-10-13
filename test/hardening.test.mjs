import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveWorker, workerName } from '../lib/ptc/runtime.js'
import { mountBundledPwsh } from '../lib/session-pwsh.js'
import { FastCtxTools } from '../lib/tools.js'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'

const CLI = path.join(PACKAGE_ROOT, 'bin', 'dsh-ops.mjs')

function stageWorker(root) {
  const target = `${process.platform}-${process.arch}`
  const runtimeDir = path.join(root, 'runtime', target)
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }))
  const worker = path.join(runtimeDir, workerName(process.platform))
  fs.writeFileSync(worker, 'worker-bytes')
  return { target, runtimeDir, worker, receipt: path.join(runtimeDir, 'provenance.json') }
}

function captureWorker(root) {
  try { return { value: resolveWorker({}, { packageRoot: root }) } } catch (error) { return { error } }
}

await test('a missing provenance receipt is reported as provenance, not as a filesystem error', async () => {
  await withTempDir('hardening-provenance-missing', (dir) => {
    const fixture = stageWorker(dir)
    const { error } = captureWorker(dir)
    assert.ok(error, 'a runtime without a receipt must not resolve')
    assert.match(error.message, /provenance is unavailable or unreadable \(ENOENT\)/)
    assert.ok(!error.message.includes(dir), `the message leaked the machine path: ${error.message}`)
    assert.ok(!error.message.includes(fixture.receipt), 'the message must not name the receipt file')
  })
})

await test('a malformed provenance receipt is reported as provenance, not as a parse failure', async () => {
  await withTempDir('hardening-provenance-malformed', (dir) => {
    const fixture = stageWorker(dir)
    fs.writeFileSync(fixture.receipt, '{ not json')
    const { error } = captureWorker(dir)
    assert.ok(error, 'a malformed receipt must not resolve')
    assert.match(error.message, /provenance is unavailable or unreadable \(SyntaxError\)/)
    assert.ok(!error.message.includes(dir), `the message leaked the machine path: ${error.message}`)
  })
})

await test('a receipt that does not describe the executable still fails as a mismatch', async () => {
  await withTempDir('hardening-provenance-mismatch', (dir) => {
    const fixture = stageWorker(dir)
    fs.writeFileSync(fixture.receipt, JSON.stringify({
      target: fixture.target, version: '9.9.9', executable: workerName(process.platform), sha256: '0'.repeat(64),
    }))
    const { error } = captureWorker(dir)
    assert.ok(error, 'a mismatched receipt must not resolve')
    assert.match(error.message, /provenance mismatch/)
  })
})

await test('a receipt that matches still resolves to the worker', async () => {
  await withTempDir('hardening-provenance-valid', (dir) => {
    const fixture = stageWorker(dir)
    fs.writeFileSync(fixture.receipt, JSON.stringify({
      target: fixture.target, version: '9.9.9', executable: workerName(process.platform),
      sha256: createHash('sha256').update('worker-bytes').digest('hex'),
    }))
    const { value, error } = captureWorker(dir)
    assert.equal(error, undefined, `an intact runtime must resolve: ${error?.message}`)
    assert.equal(value, fixture.worker)
  })
})

await test('one pwsh row that refuses the update does not strand the rows behind it', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    const updates = []
    const warnings = []
    const row = (name, update) => ({ options: { id: 'pwsh-sandbox', name, config: { pwshPath: 'original', retained: true } }, fiber: { state: 2, update } })
    const refusing = row('@deepseek-ai/dsh-pwsh-sandbox', () => { throw new Error('row refuses') })
    const following = row('@deepseek-ai/dsh-pwsh-sandbox', (raw, noSave) => updates.push({ raw, noSave }))
    const fixture = { inject(_deps, body) { body({
      get: () => ({ entries: () => [refusing, following] }),
      on: () => () => {},
      effect: (callback) => { callback() },
      logger: { warn: (message) => warnings.push(message) },
    }) } }
    mountBundledPwsh(fixture, { pwsh: { available: true, file: 'C:/pwsh.exe' } })
    assert.deepEqual(updates, [{ raw: { pwshPath: 'original', retained: true }, noSave: true }])
    assert.equal(warnings.length, 1, 'the refusal is reported once')
    assert.match(warnings[0], /rejected the update: row refuses/)
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})

await test('an exit during shutdown still kills the jobs this session owns', async () => {
  const killed = []
  const surface = new FastCtxTools({
    ctx: { get: () => undefined },
    config: { enableShellTools: true, toolCallTimeoutMs: 1000 },
    runtime: { file: 'fastctx', source: 'fixture', version: '0' },
    fileTools: false, commandTools: [], shared: true, report: () => {},
  })
  surface.bashAvailable = true
  surface.authorityAvailable = true
  surface.ownedJobs.set('sess-1', new Set(['j-aaaaaa', 'j-bbbbbb']))
  surface.client = { callTool: async (name, args) => { killed.push(`${name}:${args.job_id}`); return { isError: false } } }
  surface.pendingCalls.add(new Promise(resolve => setImmediate(() => {
    surface.client = undefined
    surface.ownedJobs.clear()
    resolve()
  })))
  await surface.stop()
  assert.deepEqual(killed, ['job_kill:j-aaaaaa', 'job_kill:j-bbbbbb'])
})

await test('provision leaves no copy that cannot run on the managed path', async () => {
  await withTempDir('hardening-provision', (dir) => {
    const home = path.join(dir, 'home')
    const source = path.join(dir, 'source', process.platform === 'win32' ? 'candidate.cmd' : 'candidate')
    fs.mkdirSync(path.dirname(source), { recursive: true })
    if (process.platform === 'win32') {
      fs.writeFileSync(source, '@echo off\r\nexit /b 7\r\n')
    } else {
      fs.writeFileSync(source, '#!/bin/sh\ncase "$(dirname "$0")" in\n  */source) echo "fastctx 9.9.9"; exit 0 ;;\nesac\nexit 7\n')
      fs.chmodSync(source, 0o755)
    }
    const managed = path.join(home, 'dsh-ops', 'bin', process.platform === 'win32' ? 'fastctx.exe' : 'fastctx')
    const result = spawnSync(process.execPath, [CLI, 'provision', '--from', source], {
      cwd: PACKAGE_ROOT, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 60000,
    })
    assert.equal(result.status, 1, `provision must refuse and exit 1, got ${result.status}: ${result.stderr}`)
    assert.equal(fs.existsSync(managed), false, 'a copy that cannot run must not stay where resolution finds it first')
  })
})

report('hardening')
