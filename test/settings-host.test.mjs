/** Real pinned settings/profile writer: persistence, validation and component reload. */
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { profileFixture } from './lib/settings-profile.mjs'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Hiding from '../lib/components/hide-official/index.js'
import { Config as DiscoveryConfig } from '../lib/components/discovery/index.js'
import * as Shell from '../lib/components/shell/index.js'
const ShellConfig = Shell.Config
import { publicToolName } from '../lib/policy.js'
import { registerNativeProvider } from '../lib/file/result-provider.js'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, test, report, TEST_HOME } from './lib/harness.mjs'


const set = (key, value) => ({ op: 'set', path: [key], value })
const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })

await test('real settings save persists selection and changes the active official-tool mask', async () => {
  const fixture = await profileFixture('ops-replacements', Hiding, { replaceTools: [], strict: true })
  const { ctx, patchPath, snapshot, mutate } = fixture
  try {
    for (const name of ['read', 'glob']) ctx.tools.register(tool(name))
    const stop = await registerNativeProvider(ctx, [tool(publicToolName('inspect_local_file'))], definition => ctx.tools.register(definition))
    ctx.effect(() => stop)
    const agent = { id: 'settings-agent', session: { id: 'settings-agent', header: { cwd: TEST_HOME } } }
    await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
    await ctx.plugin(inner => inner.provide('agents', { list: () => [agent] }))
    await ctx.serial('agent/created', { agent })
    assert.ok(scopedToolNames(ctx, agent).includes('read'))
    const before = snapshot()
    assert.deepEqual(before.value, { replaceTools: [] })
    await mutate([set('replaceTools', ['read'])], before.revision)
    await ctx.loader.await()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
    assert.ok(scopedToolNames(ctx, agent).includes('glob'))
    const saved = fs.readFileSync(patchPath, 'utf8')
    assert.match(saved, /replaceTools:/)
    assert.match(saved, /- read/)
    assert.match(saved, /strict: true/)
    const current = snapshot()
    assert.deepEqual(current.value, { replaceTools: ['read'] })
    await assert.rejects(mutate([set('replaceTools', ['glob'])], before.revision), /revision|conflict|changed/i)
    await assert.rejects(mutate([set('replaceTools', ['write'])], current.revision), /unsupported tool/)
    assert.equal(fs.readFileSync(patchPath, 'utf8'), saved)
    assert.equal(scopedToolNames(ctx, agent).includes('read'), false)
    await mutate([set('replaceTools', [])], current.revision)
    await ctx.loader.await()
    assert.ok(scopedToolNames(ctx, agent).includes('read'))
    const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'ops-replacements')
    await entry.update({ disabled: true })
    await ctx.loader.await()
    assert.equal(snapshot(), undefined)
  } finally { await shutdown(ctx) }
})

await test('real discovery form validates pool/always-loaded atomically and reloads accepted config', async () => {
  let observed, mounts = 0
  const { ctx, patchPath, snapshot, mutate } = await profileFixture('ops-discovery', {
    Config: DiscoveryConfig, apply(_ctx, config) { observed = config; mounts++ },
  }, { allowedTools: ['glob', 'grep'], alwaysLoaded: [], binaryPath: '/preserved/worker' })
  try {
    const before = snapshot(), count = mounts
    assert.deepEqual(Object.keys(before.value).sort(), ['allowedTools', 'alwaysLoaded', 'binaryPath', 'denyCredentialReads', 'enabled', 'maxResults', 'required'])
    await mutate([set('allowedTools', ['glob']), set('alwaysLoaded', ['glob']), set('required', true), set('denyCredentialReads', false)], before.revision)
    assert.deepEqual(observed.allowedTools, ['glob'])
    assert.deepEqual(observed.alwaysLoaded, ['glob'])
    assert.equal(mounts, count + 1)
    assert.equal(observed.binaryPath, '/preserved/worker')
    assert.equal(observed.required, true)
    assert.equal(observed.denyCredentialReads, false)
    const saved = fs.readFileSync(patchPath, 'utf8'), current = snapshot()
    await assert.rejects(mutate([set('alwaysLoaded', ['grep'])], current.revision), /must be in allowedTools/)
    await assert.rejects(mutate([set('allowedTools', ['pdf'])], current.revision), /unavailable capability/)
    await assert.rejects(mutate([set('maxResults', 6)], current.revision), /from 1 to 5/)
    assert.equal(fs.readFileSync(patchPath, 'utf8'), saved)
    assert.equal(mounts, count + 1)
    assert.ok(parse(saved))
  } finally { await shutdown(ctx) }
})

await test('real shell form persists executor selection without erasing ordinary policy', async () => {
  let observed
  const { ctx, snapshot, mutate, patchPath } = await profileFixture('ops-shell', {
    Config: ShellConfig, apply(_ctx, config) { observed = config },
  }, { shellPolicy: 'deny-host-shell', allowSystemShellFallback: false })
  try {
    const selected = path.join(TEST_HOME, 'selected', 'bash.exe')
    await mutate([set('bashPath', selected), set('publishBashTool', false)], snapshot().revision)
    assert.equal(observed.bashPath, selected)
    assert.equal(observed.publishBashTool, false)
    assert.equal(observed.shellPolicy, 'deny-host-shell')
    assert.equal(observed.allowSystemShellFallback, false)
    await mutate([set('allowSystemShellFallback', true), set('extraGuidance', 'Use the configured executor.')], snapshot().revision)
    assert.equal(observed.allowSystemShellFallback, true)
    assert.equal(observed.extraGuidance, 'Use the configured executor.')
    const saved = fs.readFileSync(patchPath, 'utf8')
    await assert.rejects(mutate([set('bashPath', '')], snapshot().revision), /non-empty string/)
    assert.equal(fs.readFileSync(patchPath, 'utf8'), saved)
  } finally { await shutdown(ctx) }
})

await test('the actual shell component starts and reloads through the profile adapter without normalizing twice', async () => {
  const { ctx, snapshot, mutate, patchPath } = await profileFixture('actual-shell', Shell, { promptPolicy: false, publishBashTool: false })
  try {
    assert.equal(snapshot().value.publishBashTool, false)
    await mutate([set('publishBashTool', true)], snapshot().revision)
    await ctx.loader.await()
    assert.equal(snapshot().value.publishBashTool, true)
    assert.match(fs.readFileSync(patchPath, 'utf8'), /publishBashTool: true/)
    assert.equal(ShellConfig['~standard'].validate({ extraGuidance: '' }).issues.length, 1)
  } finally { await shutdown(ctx) }
})

await test('host descriptor projections cannot remove metadata from later descriptions', () => {
  for (const Config of [Hiding.Config, DiscoveryConfig, ShellConfig]) {
    assert.equal(Config['~standard'].vendor, 'dsh-ops')
    const copy = Config.toJSON()
    for (const key of Object.keys(copy.dict)) {
      delete copy.dict[key].meta.volatile
      assert.equal(Config.dict[key].meta.volatile, true)
      assert.equal(Config.toJSON().dict[key].meta.volatile, true)
    }
  }
})
for (const [label, modulePath, config, change, invalid] of [
  ['file', '../lib/components/file/index.js', { extraGuidance: 'preserve ordinary config', promptPolicy: true }, ['promptPolicy', false], ['required', 'yes']],
  ['ptc', '../lib/components/ptc/index.js', { required: false, allowedTools: ['glob', 'grep'], alwaysLoaded: [] }, ['alwaysLoaded', ['glob']], ['allowedTools', ['pdf']]],
  ['tui', '../lib/components/tui/index.js', { maxSessions: 32, recentLimit: 8 }, ['recentLimit', 4], ['recentLimit', 100]],
]) await test(`builtin ${label} descriptor persists validated changes and reloads the owning configuration`, async () => {
  const module = await import(modulePath)
  let observed, mounts = 0
  const { ctx, snapshot, mutate, patchPath } = await profileFixture(`builtin-${label}`, {
    Config: module.Config, apply(_ctx, config) { observed = config; mounts++ },
  }, config)
  try {
    const before = snapshot(), count = mounts
    assert.ok(before && Object.hasOwn(before.value, change[0]))
    await mutate([set(...change)], before.revision)
    assert.equal(mounts, count + 1)
    assert.deepEqual(observed[change[0]], change[1])
    if (label === 'file') assert.equal(observed.extraGuidance, 'preserve ordinary config')
    const saved = fs.readFileSync(patchPath, 'utf8')
    await assert.rejects(mutate([set(...invalid)], snapshot().revision))
    assert.equal(fs.readFileSync(patchPath, 'utf8'), saved)
    assert.equal(mounts, count + 1)
  } finally { await shutdown(ctx) }
})

await test('real Cordis adapters preserve legacy null file/root/shell configuration defaults', async () => {
  for (const modulePath of ['../lib/index.js', '../lib/components/file/index.js', '../lib/components/shell/index.js']) {
    const { Config } = await import(modulePath)
    const { ctx } = await bootHost()
    let observed
    try {
      await ctx.plugin({ Config, apply(_ctx, config) { observed = config } }, null)
      assert.ok(observed && typeof observed === 'object', modulePath)
      assert.equal(Config['~standard'].validate([]).issues.length, 1)
    } finally { await shutdown(ctx) }
  }
})
report('settings-host')
