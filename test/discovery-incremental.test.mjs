/** Stable registrations, per-resolve admission and next-step discovery selection. */
import fs from 'node:fs'
import path from 'node:path'
import { fixture } from './lib/discovery-admission.mjs'
import { selectExecutor } from './lib/executor.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { shutdown } from './lib/host.mjs'
const DISCOVER = 'ops_discover_tools'
await test('creation and disposal do not assemble unrelated agents', () => withTempDir('incremental', async root => {
  const { ctx, mint, probes, names } = await fixture(root)
  try {
    const old = []
    for (let i = 0; i < 12; i++) old.push(await mint())
    const identities = old.map(a => ctx.tools.get(DISCOVER, a))
    probes.clear()
    const added = await mint()
    assert.equal(probes.size, 0)
    assert.ok((await names(added)).includes(DISCOVER))
    assert.equal(probes.size, 1, 'only the requesting agent pays admission')
    for (let i = 0; i < old.length; i++) assert.equal(ctx.tools.get(DISCOVER, old[i]), identities[i])
    probes.clear()
    await ctx.serial('agent/disposed', { agent: added })
    assert.equal(probes.size, 0)
    assert.equal((await names(added)).includes(DISCOVER), false)
  } finally { await shutdown(ctx) }
}))
await test('selection commits only at step end without changing definition identity or sibling admission', () => withTempDir('incremental', async root => {
  const { ctx, mint, capture, names, call, commit } = await fixture(root)
  try {
    fs.writeFileSync(path.join(root, 'note'), 'sample')
    const owner = await mint(), other = await mint()
    const definition = ctx.tools.get('ops_stat', owner)
    const held = await capture(owner)
    try {
      const selected = await call(owner, DISCOVER, { query: 'select:ops_stat' }, held.toolSet)
      assert.deepEqual(selected.value.activated, ['ops_stat'])
      assert.equal((await names(owner)).includes('ops_stat'), false)
      await commit(owner)
      assert.equal(ctx.tools.get('ops_stat', owner).name, definition.name, 'selection preserves the canonical capability')
      assert.equal(ctx.tools.executable('ops_stat', owner, held.toolSet), undefined, 'held step cannot expand')
      assert.equal((await names(other)).includes('ops_stat'), false)
      const result = await call(owner, 'ops_stat', { path: 'note' })
      assert.equal(result.isError, false); assert.equal(result.value.data.bytes, 6)
    } finally { held.dispose() }
  } finally { await shutdown(ctx) }
}))
await test('real executor changes and child overrides affect admission, never invent presentation from text', () => withTempDir('incremental', async root => {
  const { ctx, mint, names } = await fixture(root)
  try {
    ctx.provide('ptcRuntime', { language: 'typescript' })
    const parent = await mint(), child = await mint(parent), sibling = await mint()
    const before = ctx.tools.get(DISCOVER, parent)
    const lift = selectExecutor(parent.ctx, 'ptc')
    assert.equal((await names(parent)).includes(DISCOVER), false)
    assert.equal((await names(child)).includes(DISCOVER), false)
    assert.equal((await names(sibling)).includes(DISCOVER), true)
    const native = selectExecutor(child.ctx, 'native')
    assert.equal((await names(child)).includes(DISCOVER), true)
    native(); lift(); selectExecutor(parent.ctx, 'native')
    assert.equal((await names(parent)).includes(DISCOVER), true)
    assert.equal(ctx.tools.get(DISCOVER, parent), before)
  } finally { await shutdown(ctx) }
}))
await test('live cwd and policy refresh on resolve, and revoked held authority cannot mutate', () => withTempDir('incremental', async root => {
  const { ctx, mint, capture, names, call } = await fixture(root, { alwaysLoaded: ['stat', 'write_file'] })
  try {
    const owner = await mint(), other = await mint()
    const changed = path.join(root, 'changed'); fs.mkdirSync(changed)
    fs.writeFileSync(path.join(changed, 'sample'), 'different')
    const held = await capture(owner)
    try {
      owner.session.header.cwd = changed; owner.session.mode = 'read-only'
      assert.equal((await names(owner)).includes('ops_write_file'), false)
      assert.equal((await names(other)).includes('ops_write_file'), true)
      assert.equal((await call(owner, 'ops_stat', { path: 'sample' })).value.data.bytes, 9)
      const denied = await call(owner, 'ops_write_file', { path: 'new', content: 'denied', expectedRevision: 'absent' }, held.toolSet)
      assert.equal(denied.value.status, 'rejected', JSON.stringify(denied))
      assert.equal(fs.existsSync(path.join(changed, 'new')), false)
    } finally { held.dispose() }
  } finally { await shutdown(ctx) }
}))
await test('unload revokes retained callbacks and leaves no executable registrations', () => withTempDir('incremental', async root => {
  const { ctx, fiber, mint, names, probes } = await fixture(root)
  try {
    const owner = await mint(), cached = ctx.tools.get(DISCOVER, owner)
    await fiber.dispose()
    assert.equal((await names(owner)).includes(DISCOVER), false)
    assert.equal((await cached.execute({ query: 'stat' }, { agent: owner, signal: new AbortController().signal })).status, 'rejected')
    probes.clear(); await ctx.serial('tools/change'); await ctx.serial('system-prompt/change')
    assert.equal(probes.size, 0)
  } finally { await shutdown(ctx) }
}))
report('discovery-incremental')
