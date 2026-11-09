/**
 * A Bash slot whose executor never resolved must say so.
 *
 * Before this notice the guidance renderer returned an empty string whenever the tool was absent,
 * so "this deployment has no Bash" was indistinguishable from "Bash guidance does not apply here",
 * and the model silently fell back to whatever shell the host still published. The resolution layer
 * (source + detail, which already ends with the remedy) is quoted instead of a second vocabulary.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import { mountConsumer } from '../lib/consumer/mount.js'
import { resolveConfig } from '../lib/config.js'
import { resolveShells } from '../lib/shells.js'
import { BASH_TOOL } from '../lib/policy.js'
import { BASH_PROMPT_SECTION } from '../lib/shells/prompt.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

// A configured-but-absent executable is a resolution failure a fixture can force on every platform:
// resolve.ts treats a configured path as authoritative and never falls through to another shell.
const MISSING_BASH = process.platform === 'win32' ? 'C:/definitely-not-here/niu.exe' : '/definitely-not-here/bash'

await test('a slot whose executor never resolved reports the failed resolution', () => withTempDir('bash-unavailable-notice', async root => {
  const { ctx } = await bootHost()
  const live = []
  let allowed = true
  try {
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox)
    ctx.provide('agents', { list: () => live })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) })
    const core = resolveConfig({ promptPolicy: true, publishBashTool: true, bashPath: MISSING_BASH })
    // The same resolution the mount performs, so the assertion tracks the real detail text rather
    // than a copy of it that could drift.
    const bash = resolveShells(core).bash
    assert.equal(bash.available, false, 'the fixture must fail resolution')
    assert.equal(bash.source, 'config')
    const mint = async id => {
      const agent = { id, session: { id, header: { cwd: root } } }
      agent.ctx = createScope(ctx, agent).ctx
      live.push(agent)
      await ctx.serial('agent/created', { agent, source: 'startup' })
      return agent
    }
    const mount = (promptPolicy, allows = () => allowed) => ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
      mountConsumer(inner, { id: 'unavailable-fixture', gate: { allows }, shell: true,
        core: { ...core, promptPolicy },
        presentation: 'native', files: false, residentTools: false, discovery: false,
        native: { alwaysLoaded: [] }, external: { allowed: [] }, replaceOfficial: false })
    } })
    const bashText = async agent => (await ctx.get('systemPrompt').assemble({ scope: agent })).sections
      .filter(section => section.name.startsWith(BASH_PROMPT_SECTION + ':') && section.text.trim())
      .map(section => section.text)

    const owner = await mount(true)
    const agent = await mint('unavailable-1')
    assert.equal(ctx.get('tools').get(BASH_TOOL, agent), undefined, 'no Bash tool is published for a resolution failure')
    const texts = await bashText(agent)
    assert.equal(texts.length, 1, 'the slot still owns one non-empty section')
    const text = texts[0]
    assert.match(text, /unavailable in this session/)
    assert.match(text, /resolution source: config/, 'the notice names the rung that failed')
    assert.ok(text.includes(bash.detail), 'the resolution detail is quoted verbatim: ' + bash.detail)
    assert.doesNotMatch(text, /foreground includes status, exitCode/, 'the operating guidance is not claimed')

    allowed = false
    assert.deepEqual(await bashText(agent), [], 'an agent the gate rejects learns nothing about this slot')
    allowed = true
    assert.equal((await bashText(agent)).length, 1)

    await owner.dispose()
    assert.deepEqual(await bashText(agent), [], 'disposal removes the section, not only its text')

    const quiet = await mount(false)
    assert.deepEqual(await bashText(agent), [], 'promptPolicy false registers no section at all')
    await quiet.dispose()
  } finally { await shutdown(ctx) }
}))

report('bash-unavailable-notice')
