import { mountFakeResident } from './lib/resident.mjs'
/** Empty operator guidance needs no prompt construction merely to choose its owner (#792). */
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountNative } from '../lib/publication/native.js'
import { resolveConfig } from '../lib/config.js'
import { selectExecutor, prepareStep } from './lib/executor.mjs'
import { mountConsumer } from '../lib/consumer/mount.js'
import { resolveDiscoveryConfig, resolvePtcConfig } from '../lib/config.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

for (const extraGuidance of ['', 'Keep this operator guidance.']) {
  await test(`Native ownership skips empty guidance before consulting another owner (${Boolean(extraGuidance)})`, () => withTempDir('prompt-owner', async root => {
    const { ctx } = await bootHost()
    let checks = 0, owns
    try {
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) })
      ctx.provide('subprocess', { spawn() { throw new Error('ownership must not spawn') } })
      await mountFakeResident(ctx, { file: process.execPath })
      await ctx.plugin({ apply(inner) {
        owns = mountNative(inner, { ...resolveConfig({ binaryPath: process.execPath }), extraGuidance }, {
          id: 'ownership-test', tools: ['inspect_local_file'], section: 'mode-standard', gate: { allows: () => true },
          extraGuidanceOwner() { ++checks; return false },
        })
      } })
      await new Promise(resolve => setImmediate(resolve))
      const agent = { id: 'guidance-owner', session: { id: 'guidance-owner', header: { cwd: root } } }
      const scope = createScope(ctx, agent); agent.ctx = scope.ctx
      try {
        await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'native') } })
        await ctx.serial('agent/created', { agent })
        checks = 0
        assert.equal(owns(agent), Boolean(extraGuidance))
        assert.equal(checks > 0, Boolean(extraGuidance), 'empty guidance must not ask other owners or render text')
      } finally { await scope.dispose() }
    } finally { await shutdown(ctx) }
  }))
}
for (const extraGuidance of ['', 'Keep this operator guidance.']) {
  await test(`consumer discovery does not render the Bash prompt to own empty guidance (${Boolean(extraGuidance)})`, () => withTempDir('shell-prompt-owner', async root => {
    const { ctx, prompt, tools } = await bootHost()
    const sections = [], originalSection = prompt.section
    prompt.section = function (section) { sections.push(section); return originalSection.call(this, section) }
    try {
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) })
      ctx.provide('subprocess', { spawn() { throw new Error('ownership must not spawn') } })
      await mountFakeResident(ctx, { file: process.execPath })
      await ctx.plugin({ apply(inner) {
        mountConsumer(inner, { id: 'ownership-test', gate: { allows: () => true },
          core: { ...resolveConfig({ binaryPath: process.execPath, bashPath: process.execPath }), extraGuidance },
          files: false, shell: true, presentation: 'native', residentTools: false, discovery: true,
          native: resolveDiscoveryConfig({ binaryPath: process.execPath, allowedTools: ['stat'] }), ptc: resolvePtcConfig(),
          replaceOfficial: false, replacementTargets: new Map(), section: null,
          external: { allowed: [], alwaysLoaded: [], disabled: [] },
        })
      } })
      await new Promise(resolve => setImmediate(resolve))
      const agent = { id: 'shell-guidance-owner', session: { id: 'shell-guidance-owner', header: { cwd: root } } }
      const scope = createScope(ctx, agent); agent.ctx = scope.ctx
      try {
        await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'native') } })
        await ctx.serial('agent/created', { agent })
        const prepared = await prepareStep(ctx, agent)
        let reads = 0
        const originalGet = tools.get
        tools.get = function (name, ...args) { if (name === 'ops_bash') ++reads; return originalGet.call(this, name, ...args) }
        try {
          const section = sections.find(row => row.name.startsWith('dsh-ops:discovery-tools'))
          assert.ok(section)
          const text = await section.text({ scope: agent, toolSet: prepared.toolSet })
          assert.match(text, /ops_discover_tools/)
          assert.equal(reads > 0, Boolean(extraGuidance), 'empty guidance must not read the shell definition to generate unused text')
        } finally { tools.get = originalGet; prepared.dispose() }
      } finally { await scope.dispose() }
    } finally { prompt.section = originalSection; await shutdown(ctx) }
  }))
}
report('prompt-ownership')
