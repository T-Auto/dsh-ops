import { Context, Service } from '@deepseek-ai/cordis'
import * as sidebarModule from '../lib/components/tui/index.js'
import { legacyComponent } from './lib/legacy-component.mjs'
const sidebar = legacyComponent(sidebarModule)
import { createActivityStore } from '../lib/tui/activity.js'
import { activityLines } from '../lib/tui/panel.js'
import { call, result, dispatch } from './lib/activity-events.mjs'
import { assert, report, test, tick } from './lib/harness.mjs'

class Panels extends Service {
  constructor(ctx, { decline = false } = {}) { super(ctx, 'tuiPanels'); this.entries = new Map(); this.badges = new Map(); this.decline = decline }
  register(descriptor) {
    if (this.decline) return undefined
    this.entries.set(descriptor.id, descriptor)
    return () => { this.entries.delete(descriptor.id); this.badges.delete('test-owner:' + descriptor.id) }
  }
  list() { return [...this.entries.keys()].map(id => ({ id: 'test-owner:' + id, title: 'OPS', source: 'plugin' })) }
  badge(id, value) {
    if (this.throwBadge) throw new Error('fixture host badge failure')
    if (!this.list().some(panel => panel.id === id)) throw new Error('badge must use the returned host-prefixed id')
    if (value) this.badges.set(id, value)
    else this.badges.delete(id)
  }
}
const newRoot = () => { const ctx = new Context(); ctx.logger.level = 0; return ctx }
const readPanel = (descriptor, sessionId = 'one', lang = 'en') => {
  let snapshot
  const React = { useState: value => [value, () => {}], useEffect() {}, useSyncExternalStore(_subscribe, get) { const value = get(); if ('total' in value) snapshot = value; return value }, createElement() { return null } }
  descriptor.component({ React, ui: { Box: () => null, Text: () => null }, host: { snapshot: () => ({ sessionId, lang }) }, width: 28, height: 16 })
  return snapshot
}

await test('optional injection stays pending without TUI and activates when the service appears', async () => {
  const ctx = newRoot()
  try {
    const fiber = ctx.plugin(sidebar, {})
    await tick(); assert.equal(ctx.get('tuiPanels', false), undefined)
    await ctx.plugin(Panels)
    await tick()
    const panels = ctx.get('tuiPanels')
    assert.equal(panels.entries.size, 1)
    const descriptor = panels.entries.get('overview')
    assert.equal(descriptor.apiVersion, 1); assert.equal(descriptor.title, 'OPS')
    ctx.emit('session/event', { id: 'one' }, call(1))
    ctx.emit('session/event', { id: 'one' }, result(2))
    assert.equal(readPanel(descriptor).total, 1)
    assert.equal(readPanel(descriptor, 'two').total, 0)
    assert.equal(ctx.get('tools', false), undefined)
    assert.equal(ctx.get('systemPrompt', false), undefined)
    await fiber.dispose(); await tick()
    assert.equal(panels.entries.size, 0)
    assert.equal(readPanel(descriptor).total, 0)
    ctx.emit('session/event', { id: 'one' }, call(3))
    assert.equal(readPanel(descriptor).total, 0)
  } finally { await ctx.fiber.dispose() }
})
await test('declined panel registration does not start an observer or affect other services', async () => {
  const ctx = newRoot()
  try {
    await ctx.plugin(Panels, { decline: true })
    await ctx.plugin(sidebar, {}); await tick()
    assert.equal(ctx.get('tuiPanels').entries.size, 0)
    ctx.emit('session/event', { id: 'one' }, call(1))
    assert.equal(ctx.get('tools', false), undefined)
  } finally { await ctx.fiber.dispose() }
})
await test('repeated UI reads do not execute, consume, reset, or expose another session', () => {
  const store = createActivityStore()
  store.observe('one', call(1)); store.observe('one', result(2))
  const a = store.snapshot('one')
  const english = activityLines(a, 'en', 12)
  const chinese = activityLines(a, 'zh-CN', 12)
  assert.ok(english.includes('Calls 1 · Running 0'))
  assert.ok(chinese.includes('调用 1 · 运行中 0'))
  assert.equal(store.snapshot('one'), a)
  assert.equal(activityLines(a, 'en', 2).length, 2)
  assert.equal(activityLines(a, 'en', 0).length, 0)
  assert.equal(store.snapshot('two').total, 0)
})
await test('retention options are independently validated, with no shell configuration leakage', () => {
  assert.equal(sidebar.resolveTuiConfig({ recentLimit: 3 }).recentLimit, 3)
  for (const config of [null, [], { required: false }, { maxSessions: 0 }, { recentLimit: 65 }]) {
    assert.throws(() => sidebar.resolveTuiConfig(config))
  }
})
await test('the component admission manifest is separate and grants no operation capability', async () => {
  const { readFile } = await import('node:fs/promises')
  const { parseManifest } = await import('@dsh-std/manifest')
  const manifest = parseManifest(await readFile(new URL('../lib/components/tui/dsh-plugin.json', import.meta.url), 'utf8'))
  assert.equal(manifest.id, 'dsh-ops-tui')
  assert.deepEqual(manifest.requires.contracts, [])
  assert.deepEqual(manifest.permissions, [])
  assert.deepEqual(manifest.subscriptions, [])
})
await test('badges aggregate accepted settlements across sessions, survive eviction, and never affect tools', async () => {
  const ctx = newRoot()
  try {
    await ctx.plugin(Panels)
    const fiber = ctx.plugin(sidebar, { maxSessions: 1 }); await tick()
    const panels = ctx.get('tuiPanels'), descriptor = panels.entries.get('overview')
    ctx.emit('session/event', { id: 'one' }, call(1, 'a', 'ops_replace'))
    const denied = result(2, 'a', { status: 'rejected' })
    ctx.emit('session/event', { id: 'one' }, denied)
    ctx.emit('session/event', { id: 'one' }, denied)
    assert.deepEqual(panels.badges.get('test-owner:overview'), { level: 'warning', unread: 1 })
    ctx.emit('session/event', { id: 'two' }, dispatch(1, 'b', 'ops_batch'))
    ctx.emit('session/event', { id: 'two' }, dispatch(2, 'b', 'ops_batch', { status: 'partial', unknown: 1 }))
    assert.deepEqual(panels.badges.get('test-owner:overview'), { level: 'error', unread: 2 })
    assert.equal(readPanel(descriptor, 'one').total, 0, 'session retention is independent of aggregate notification count')
    panels.throwBadge = true
    ctx.emit('session/event', { id: 'two' }, call(3, 'c'))
    ctx.emit('session/event', { id: 'two' }, result(4, 'c', {}, 'PRIVATE_ERROR'))
    assert.equal(readPanel(descriptor, 'two').errors, 1, 'badge failure must not block observation')
    assert.equal(ctx.get('tools', false), undefined)
    await fiber.dispose(); assert.equal(panels.badges.size, 0)
    ctx.emit('session/event', { id: 'two' }, call(5))
    assert.equal(readPanel(descriptor, 'two').total, 0)
  } finally { await ctx.fiber.dispose() }
})
report('TUI panel')
