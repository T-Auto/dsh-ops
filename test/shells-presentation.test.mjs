import { bashToolDefinition } from '../lib/shells.js'
import { hostBashDefinition } from '../lib/shells/host-tool.js'
import { hostForeground, hostFailure } from '../lib/shells/host-contract.js'
import { assert, report, test } from './lib/harness.mjs'

const base = bashToolDefinition({ file: process.execPath, source: 'config' })
const definition = hostBashDefinition({}, base, () => { throw Error('presentation must not execute') }, () => undefined)
const args = { command: 'printf first\nprintf second', description: 'Print two separate output lines', workdir: 'project' }
const present = value => definition.presentResult(args, JSON.parse(JSON.stringify({
  content: definition.output.render(args, value), isError: false,
  meta: definition.output.presentationMeta(args, value),
})))

await test('published shell definition presents multiline commands and session-relative cwd', () => {
  assert.deepEqual(definition.presentCall(args), { card: 'terminal', title: args.command, description: args.description, cwd: 'project' })
  assert.deepEqual(definition.presentCall({ script_path: 'two words.sh' }), { card: 'terminal', title: 'two words.sh' })
  assert.equal(Object.hasOwn(definition.presentCall({ command: 'pwd', workdir: ' ' }), 'cwd'), false)
  for (const value of [null, [], {}, { command: 3 }, { command: 'x', script_path: 'y' }]) assert.equal(definition.presentCall(value), undefined)
})

await test('durable shell cards preserve captured output and a genuine zero exit', () => {
  const value = hostForeground({ exitCode: 0, timeoutMs: 10, timedOut: false,
    stdout: { text: 'first\nsecond', truncated: false }, stderr: { text: 'notice', truncated: false } })
  const view = present(value)
  assert.equal(view.card, 'terminal'); assert.equal(view.exitCode, 0)
  assert.equal(view.output, definition.output.render(args, value)[0].text)
  assert.match(view.output, /\[stderr\]\nnotice/)
  assert.deepEqual(definition.output.presentationMeta(args, value), { opsShell: { exitCode: 0 } })
})

await test('signals and infrastructure failures never invent a successful exit', () => {
  const killed = hostForeground({ signal: 'SIGTERM', cancelled: true, timeoutMs: 10, timedOut: false,
    stdout: { text: 'tail', truncated: true, spillPath: '/private/full.log' }, stderr: { text: '', truncated: false } })
  const view = present(killed)
  assert.equal(view.signal, 'SIGTERM'); assert.equal(Object.hasOwn(view, 'exitCode'), false)
  assert.match(view.output, /full output: \/private\/full.log/)
  const failed = present(hostFailure('EXECUTOR_UNAVAILABLE: unavailable'))
  assert.equal(Object.hasOwn(failed, 'exitCode'), false)
  assert.match(failed.output, /EXECUTOR_UNAVAILABLE/)
})

await test('background and promoted cards retain job guidance without claiming completion', () => {
  for (const value of [{ kind: 'background', jobId: 'job-1', label: 'Build project' },
    { kind: 'promoted', jobId: 'job-1', label: 'Build project', timeoutMs: 10, output: 'still working' }]) {
    const view = present(value)
    assert.match(view.output, /job-1/)
    assert.equal(Object.hasOwn(view, 'exitCode'), false)
    assert.equal(Object.hasOwn(view, 'signal'), false)
    assert.deepEqual(definition.output.presentationMeta(args, value), {})
  }
})

await test('replay without metadata never infers process status from output', () => {
  const view = definition.presentResult({}, { content: [{ type: 'text', text: '[exit code: 0]' }], isError: true })
  assert.deepEqual(view, { card: 'terminal', output: '[exit code: 0]' })
})

report('shells-presentation')
