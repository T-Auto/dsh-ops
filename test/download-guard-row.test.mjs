/**
 * The download-guard row, driven through a real cordis context.
 *
 * This suite mounts the built component and fires the actual
 * `tools/pre-execute` waterfall, so it fails if the listener is not registered,
 * if the decision shape drifts from what the host expects, or if the row
 * starts refusing before an operator configures a downloader.
 *
 * Cost note: it boots cordis only. No worker, no DSH host, no subprocess.
 */
import { Context } from '@deepseek-ai/cordis'
import { assert, test, report } from './lib/harness.mjs'
import { apply } from '../lib/components/download-guard/index.js'

const TEMPLATE = 'aria2c -x16 -s16 -o {file} {url}'
const CMD = 'curl -o out.iso https://example.test/a.iso'

/**
 * Mount the row on a fresh context and return a function that dispatches one
 * pre-execute call through the real waterfall.
 */
async function mount(config) {
  const ctx = new Context()
  apply(ctx, config)
  return async (name, args) => ctx.waterfall(
    'tools/pre-execute',
    { name, arguments: args },
    () => Promise.resolve({ kind: 'allow' }),
  )
}

await test('an unconfigured row registers no refusing behaviour', async () => {
  const call = await mount({})
  // Every download shape must pass straight through: an install that never set
  // a template has not opted into a download policy.
  for (const command of [CMD, 'wget https://example.test/a.iso', 'curl -o x https://example.test/x']) {
    const decision = await call('ops_bash', { command })
    assert.equal(decision.kind, 'allow', `unconfigured row must allow ${JSON.stringify(command)}`)
  }
})

await test('a configured row refuses a download and names the forwarder', async () => {
  const call = await mount({ downloadGuard: { template: TEMPLATE } })
  const decision = await call('ops_bash', { command: CMD })
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('aria2c -x16 -s16 -o out.iso https://example.test/a.iso'),
    'the refusal must carry a runnable command')
  assert.equal(decision.info.code, 'DOWNLOAD_TO_FILE')
})

await test('an ordinary command is allowed even when configured', async () => {
  const call = await mount({ downloadGuard: { template: TEMPLATE } })
  for (const command of [
    'ls -la',
    'git status',
    'npm run build',
    'curl https://example.test/api',
    'node download.cjs --help',
    'grep -rn wget docs/',
  ]) {
    const decision = await call('ops_bash', { command })
    assert.equal(decision.kind, 'allow', `must allow ${JSON.stringify(command)}`)
  }
})

await test('a non-shell tool is never inspected', async () => {
  const call = await mount({ downloadGuard: { template: TEMPLATE } })
  const decision = await call('ops_read_files', { command: CMD })
  assert.equal(decision.kind, 'allow', 'file tools carry no shell command')
})

await test('script_path is not guessed at', async () => {
  const call = await mount({ downloadGuard: { template: TEMPLATE } })
  // The file's contents are not in this call; treating the path as a command
  // would be a false positive.
  const decision = await call('ops_bash', { script_path: 'scripts/fetch.sh' })
  assert.equal(decision.kind, 'allow')
})

await test('a malformed call cannot turn a refusal into a crash', async () => {
  const call = await mount({ downloadGuard: { template: TEMPLATE } })
  for (const args of [undefined, null, {}, { command: 42 }, { command: '' }]) {
    const decision = await call('ops_bash', args)
    assert.equal(decision.kind, 'allow', `must not refuse ${JSON.stringify(args)}`)
  }
})

await test('a template without {url} is rejected at load time', async () => {
  const ctx = new Context()
  assert.throws(
    () => apply(ctx, { downloadGuard: { template: 'aria2c {file}' } }),
    /must contain \{url\}/,
    'a template that cannot name the URL would produce an unactionable refusal',
  )
})

await report('download-guard row')
