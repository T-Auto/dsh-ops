/** Terminal storage identity cannot change while bounded output is copied. */
import { collectShellOutput } from '../lib/execution/resident/shell-output.js'
import { assert, report, test } from './lib/harness.mjs'

await test('changed terminal spill metadata aborts and joins the pending sibling reader', async () => {
  const gate = Promise.withResolvers(), failures = []
  let stderrSettled = false, reads = 0
  const transport = {
    available: true, capabilities: ['shell-v1', 'shell-spill-v1'],
    abort(error) { failures.push(error); gate.resolve() },
    async read(requestId, stream, offset) {
      reads++
      if (stream === 'stderr') {
        await gate.promise; stderrSettled = true
        return { type: 'shell.output', requestId, stream, offset, nextOffset: 0, bytesBase64: '', lossy: false, eof: true }
      }
      return { type: 'shell.output', requestId, stream, offset, nextOffset: offset + 1,
        bytesBase64: Buffer.from('x').toString('base64'), lossy: false, eof: offset === 1,
        spillPath: `/owned/${offset === 0 ? 'first' : 'replacement'}`, spillOrigin: 'ops-native-v1', spillPid: 123, spillSealed: true }
    },
  }
  // The fixture's watchdog releases its own reader even if the consistency
  // guard is reverted; a broken test must fail instead of hanging.
  const watchdog = setTimeout(() => gate.resolve(), 1000)
  try {
    await assert.rejects(collectShellOutput(transport, { requestId: 'terminal', stdoutTotal: 2, stderrTotal: 0, cleanupConfirmed: true }), /metadata changed/)
    assert.equal(stderrSettled, true)
    assert.equal(failures.length, 1); assert.equal(reads, 3)
  } finally { clearTimeout(watchdog); gate.resolve() }
})

report('resident-shell-output')
