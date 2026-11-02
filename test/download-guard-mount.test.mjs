/**
 * The download-guard row as the composition root actually mounts it.
 *
 * The sibling `download-guard-row` suite drives the component directly; this one
 * goes through `apply()` with a real cordis context, so it fails if the row is
 * dropped from the composition root, if the `download-guard` config section
 * stops resolving, or if the enabled/disabled switch stops being honoured.
 *
 * Cost note: cordis only. No worker, no DSH host, no subprocess.
 */
import { Context } from '@deepseek-ai/cordis'
import { assert, test, report } from './lib/harness.mjs'
import { apply } from '../lib/index.js'

const TEMPLATE = 'aria2c -x16 -s16 -o {file} {url}'
const CMD = 'curl -o out.iso https://example.test/a.iso'

/**
 * Boot the composition root with one row config and return a dispatcher for
 * the pre-execute waterfall.
 */
async function boot(rowConfig) {
  const ctx = new Context()
  await apply(ctx, rowConfig)
  return async (name, args) => ctx.waterfall(
    'tools/pre-execute',
    { name, arguments: args },
    () => Promise.resolve({ kind: 'allow' }),
  )
}

await test('the shipped defaults mount no refusing behaviour', async () => {
  // `download-guard.enabled: false` is what the bundle patch ships; a default
  // install must never refuse a download it was not told to police.
  const call = await boot({})
  const decision = await call('ops_bash', { command: CMD })
  assert.equal(decision.kind, 'allow')
})

await test('an enabled row with a template refuses, through the whole root', async () => {
  const call = await boot({
    'download-guard': { enabled: true, downloadGuard: { template: TEMPLATE } },
  })
  const decision = await call('ops_bash', { command: CMD })
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('aria2c -x16 -s16 -o out.iso'))
})

await test('enabled but with an empty template stays inert', async () => {
  // Enabling the row is not the same as configuring a downloader. The shipped
  // patch spells "not set" as an empty string, and that must not refuse.
  const call = await boot({
    'download-guard': { enabled: true, downloadGuard: { template: '' } },
  })
  const decision = await call('ops_bash', { command: CMD })
  assert.equal(decision.kind, 'allow')
})

await test('a disabled row ignores a template that is present', async () => {
  // An operator who filled the template and then switched the row off expects
  // it off; the config value must not keep the listener alive.
  const call = await boot({
    'download-guard': { enabled: false, downloadGuard: { template: TEMPLATE } },
  })
  const decision = await call('ops_bash', { command: CMD })
  assert.equal(decision.kind, 'allow')
})

await test('ordinary commands pass through the enabled row', async () => {
  const call = await boot({
    'download-guard': { enabled: true, downloadGuard: { template: TEMPLATE } },
  })
  for (const command of ['ls -la', 'git status', 'curl https://example.test/api']) {
    const decision = await call('ops_bash', { command })
    assert.equal(decision.kind, 'allow', `must allow ${JSON.stringify(command)}`)
  }
})

await report('download-guard row via the composition root')
