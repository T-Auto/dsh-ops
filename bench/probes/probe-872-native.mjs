/** Native fd-7/dispatch feasibility only. Build with:
 * cargo build --locked --manifest-path native/Cargo.toml --example resident_probe
 * No production tools use this probe; request cancellation remains unsupported.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { channel, within } from './872/channel.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const binary = path.resolve(process.argv[2] ?? path.join(root, 'native/target/debug/examples',
  process.platform === 'win32' ? 'resident_probe.exe' : 'resident_probe'))
assert.ok(fs.statSync(binary).isFile(), 'build the native probe first')
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-native-872-')))
const file = path.join(fixture, 'note.txt')
fs.writeFileSync(file, 'resident-native-fixture\n')
const ctx = new Context()
ctx.logger.level = 0
const checks = []
await ctx.plugin(Subprocess)
let spawns = 0
function launch() {
  const handle = ctx.get('subprocess').spawn({ argv: [binary], cwd: fixture,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 }, control: 'pipe' }, graceMs: 100 })
  spawns++
  assert.ok(handle.control, 'public host supplies native control descriptor')
  handle.done.catch(() => {})
  return { handle, wire: channel(handle.control) }
}
const envelope = (id, extra = {}) => ({ version: 1, requestId: id, component: 'file',
  budget: { timeoutMs: 30000, maxBytes: 8192 },
  request: { tool: 'inspect_local_file', root: fixture, scope: 'probe', read_only: true,
    args: { path: file, view: 'text', offset: 1, limit: 5 }, ...extra } })
try {
  const { handle, wire } = launch()
  const hello = await within(wire.next(), 15000, 'native handshake')
  assert.equal(hello.type, 'hello')
  assert.ok(Number.isSafeInteger(hello.pid))
  for (let index = 0; index < 25; index++) {
    await wire.send(envelope(`read-${index}`))
    const response = await within(wire.next(), 10000, 'native dispatch')
    assert.equal(response.type, 'completed')
    assert.equal(response.requestId, `read-${index}`)
    assert.notEqual(response.result.status, 'error', JSON.stringify(response.result))
    assert.match(JSON.stringify(response.result), /resident-native-fixture/)
  }
  assert.equal(spawns, 1)
  assert.equal(handle.collected.stdout.readFrom(0).text, 'resident probe stdout is separate\n', 'ordinary stdout cannot become a control reply')
  checks.push({ name: '25 existing read dispatches on one native process', status: 'pass', pid: hello.pid })
  await wire.send(envelope('write-refused', { read_only: false }))
  const refused = await within(wire.next(), 10000, 'probe scope refusal')
  assert.equal(refused.requestId, 'write-refused')
  assert.equal(refused.result.status, 'error')
  checks.push({ name: 'probe refuses writable execution', status: 'pass' })
  // Half-close tests the native reader's EOF handling; a host terminate callback
  // would mask an absent native EOF watcher, so this driver has none.
  handle.control.end()
  await within(handle.done, 10000, 'native EOF exit')
  assert.equal(await handle.waitForExit(AbortSignal.timeout(10000)), true)
  checks.push({ name: 'native control EOF exits without host terminate', status: 'pass' })
  for (const [name, bytes] of [['malformed', Buffer.from('not-json\n')], ['oversized', Buffer.alloc(65537, 97)]]) {
    const next = launch()
    await within(next.wire.next(), 15000, `${name} handshake`)
    await new Promise((resolve, reject) => next.handle.control.write(bytes, error => error ? reject(error) : resolve()))
    await within(next.handle.done, 10000, `${name} rejection`)
    assert.equal(await next.handle.waitForExit(AbortSignal.timeout(10000)), true)
    checks.push({ name: `${name} control input ends the native probe`, status: 'pass' })
  }
  const missing = ctx.get('subprocess').spawn({ argv: [binary], cwd: fixture,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 100 })
  assert.equal(missing.control, undefined)
  const rejected = await within(missing.done, 10000, 'missing control startup rejection')
  assert.equal(rejected.exitCode, 1)
  assert.equal(await missing.waitForExit(AbortSignal.timeout(10000)), true)
  assert.equal(missing.collected.stdout.readFrom(0).text, '')
  assert.match(missing.collected.stderr.readFrom(0).text, /control pipe was not inherited/)
  checks.push({ name: 'missing inherited control fails startup cleanly', status: 'pass' })
  process.stdout.write(`${JSON.stringify({ platform: process.platform, node: process.version, binary,
    status: 'pass', checks, scope: 'Native inherited-channel and read-dispatch probe; no production transport, request cancellation, persistent shell or performance claim.' }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
  // This exact mkdtemp directory belongs solely to the probe.
  fs.rmSync(fixture, { recursive: true, force: true })
}
