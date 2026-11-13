import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
/** Real registries, prompt assembly and Bash execution; only the preset roster is a fixture. */
import fs from 'node:fs'
import path from 'node:path'
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as Bundle from '../lib/index.js'
import { integration, residentKernel } from '../lib/integration/index.js'
import { resolveIntegrationConfig } from '../lib/consumer/options.js'
import { gateConsumer } from '../lib/consumer/gates.js'
import { mountIntegration } from '../lib/integration/index.js'
import { BASH_TOOL, modeSectionName } from '../lib/policy.js'
import { BASH_PROMPT_SECTION, bashOperationDescription, renderBashGuidance } from '../lib/shells/prompt.js'
import { readRowValues, changedFields } from '../lib/client/row-schema.js'
import { mountDshOpsBridge } from './fixtures/shell-slot-pwsh7/dsh-ops-bridge.mjs'
import { bootHost, shutdown, scopedToolNames } from './lib/host.mjs'
import { assert, report, test, withTempDir, waitFor } from './lib/harness.mjs'

const off = { enabled: false }
const minimalOnly = { standard: off, ptc: off, cordis: off, discovery: off }
const pwshDescription = 'Execute a command in a fresh pwsh -Command process using native Windows paths and $env:NAME syntax.'
const pwshText = 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on.'
const definition = name => ({ name, description: pwshDescription, parameters: { type: 'object', properties: { command: { type: 'string' } } },
  output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })

async function scope(parent, key, parentKey) {
  let context
  await parent.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) {
    context = createScope(inner, key, parentKey ? { parent: parentKey } : undefined).ctx
  } })
  return context
}
async function boot(cwd) {
  const { ctx } = await bootHost()
  ctx.get('systemPrompt').variable('os', () => process.platform)
  await ctx.plugin(Subprocess)
  const live = [], presets = new Map()
  ctx.provide('agents', { list: () => [...live] })
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => session.mode === 'unavailable' ? undefined : ({ mode: session.mode, workspaceRoot: cwd }) })
  ctx.provide('agentPresets', { composedPreset: context => presets.get(scopeParentOf(scopeOf(context))) })
  const mint = async (id, { preset = 'minimal', pwsh = true, mode = 'danger-full-access' } = {}) => {
    const parent = await scope(ctx, { preset: id })
    presets.set(scopeOf(parent), preset)
    if (pwsh) {
      parent.tools.register(definition('pwsh'))
      parent.tools.register(definition('pwsh_persistent'))
      parent.systemPrompt.section({ name: 'tool:pwsh', order: 1010, text: pwshText })
    }
    const agent = { id, session: { id, mode, header: { cwd } } }
    agent.ctx = await scope(parent, agent, scopeOf(parent))
    live.push(agent)
    await ctx.serial('agent/created', { agent, source: 'startup' })
    return agent
  }
  return { ctx, mint, names: agent => scopedToolNames(ctx, agent),
    assemble: async agent => { const step = await prepareStep(ctx, agent); try { return step.assembly } finally { step.dispose() } } }
}
const bashSections = assembly => assembly.sections.filter(section => section.name.startsWith(BASH_PROMPT_SECTION + ':') && section.text.trim())

for (const bash of [false, true]) for (const pwsh of [false, true]) {
  await test(`Bash=${bash}, host pwsh=${pwsh}: independent schemas and prompt slots`, () => withTempDir('shell-slot-matrix', async cwd => {
    const { ctx, mint, names, assemble } = await boot(cwd)
    try {
      const row = await ctx.plugin(Bundle, { ...minimalOnly, global: { bash, hidePwsh: false }, other: { pwsh7Link: false } })
      const agent = await mint('matrix', { pwsh })
      const assembly = await assemble(agent)
      assert.equal(assembly.variables.os, process.platform, 'Bash never rewrites the host OS variable')
      assert.equal(names(agent).includes(BASH_TOOL), bash && process.platform === 'win32')
      assert.equal(names(agent).includes('pwsh'), pwsh)
      assert.equal(assembly.tools.some(tool => tool.name === 'pwsh'), pwsh)
      assert.equal(assembly.tools.some(tool => tool.name === BASH_TOOL), bash && process.platform === 'win32')
      assert.equal(assembly.sections.find(section => section.name === 'tool:pwsh')?.text, pwsh ? pwshText : undefined)
      assert.equal(bashSections(assembly).length, bash && process.platform === 'win32' ? 1 : 0)
      if (bash && process.platform === 'win32') {
        const schema = assembly.tools.find(tool => tool.name === BASH_TOOL)
        assert.match(schema.description, /Bash.*fresh non-login shell/)
        assert.match(schema.description, /MSYS.*not Linux, WSL or PowerShell/)
        assert.deepEqual(schema.parameters.required, ['description'])
        assert.equal(schema.parameters.properties.run_in_background, undefined)
        const text = bashSections(assembly)[0].text
        assert.match(text, /D:\/repo or \/d\/repo/)
        assert.doesNotMatch(text, /foreground includes status, exitCode/, 'result fields are in the tool contract')
        assert.match(text, /missing exitCode or failed status is not success/)
        assert.match(text, /Host jobs are unavailable/)
        assert.doesNotMatch(text, /Check the \[exit code: N\] marker|→ host PowerShell/)
        assert.equal(bashSections(await assemble(agent)).length, 1)
      }
      if (pwsh) assert.equal(assembly.tools.find(tool => tool.name === 'pwsh').description, pwshDescription)
      assert.equal(Object.hasOwn(ctx.get('tools'), 'register'), false)
      await row.dispose(); await new Promise(resolve => setImmediate(resolve))
      assert.equal(names(agent).includes(BASH_TOOL), false)
      assert.equal(bashSections(await assemble(agent)).length, 0)
      assert.equal((await assemble(agent)).sections.some(section => section.name.startsWith(BASH_PROMPT_SECTION + ':')), false, 'disposal removes the registered section, not only its text')
      assert.equal(names(agent).includes('pwsh'), pwsh)
    } finally { await shutdown(ctx) }
  }))
}

for (const preset of ['standard', 'cordis']) {
  await test(`${preset} resident Native + Shell assembly keeps guidance single-owned across withdrawal and reload`, () => withTempDir('shell-slot-resident', async cwd => {
    const { ctx, mint, assemble } = await boot(cwd)
    const guidance = 'Preserve the resident assembly fixture boundary.'
    const textOf = assembly => assembly.sections.map(section => section.text).join('\n')
    const count = (assembly, value) => textOf(assembly).split(value).length - 1
    try {
      const config = { minimal: off, standard: off, ptc: off, cordis: off,
        [preset]: { enabled: true, extraGuidance: guidance }, other: { pwsh7Link: false } }
      let row = await ctx.plugin(Bundle, config)
      const agent = await mint('resident-' + preset, { preset, pwsh: false })
      const peer = await mint('peer-' + preset, { preset, pwsh: false })
      const assembly = await assemble(agent)
      for (const name of ['ops_glob', 'ops_grep', 'ops_inspect_local_file', 'ops_discover_tools']) {
        assert.ok(assembly.tools.some(tool => tool.name === name), `${name} is resident or the discovery entry`)
      }
      const fileText = assembly.sections.find(section => section.name === modeSectionName('mode-' + preset))?.text ?? ''
      assert.match(fileText, /^# Repository file tools/m)
      assert.doesNotMatch(fileText, /ops_bash|Bash command execution|host PowerShell|Windows-native shell/)
      assert.doesNotMatch(textOf(assembly), /# Repository tooling|# Repository tool routing/)
      assert.equal(count(assembly, guidance), 1, 'extraGuidance has exactly one owner')
      assert.equal(assembly.tools.filter(tool => tool.name === BASH_TOOL).length, process.platform === 'win32' ? 1 : 0)
      assert.equal(bashSections(assembly).length, process.platform === 'win32' ? 1 : 0)
      assert.equal((textOf(assembly).match(/^# .*Bash command execution/gm) ?? []).length, process.platform === 'win32' ? 1 : 0)
      assert.equal(assembly.tools.some(tool => tool.name === 'pwsh'), false)
      agent.session.mode = 'unavailable'
      await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' }); await new Promise(resolve => setImmediate(resolve))
      const withdrawn = await assemble(agent)
      assert.equal(bashSections(withdrawn).length, 0)
      assert.equal(count(withdrawn, guidance), 1, 'live Native section retains guidance after Bash withdrawal')
      assert.equal(count(await assemble(peer), guidance), 1, 'peer retains independent guidance')
      agent.session.mode = 'danger-full-access'
      await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' }); await new Promise(resolve => setImmediate(resolve))
      for (const [bash, residentTools, owner] of [[false, true, 'Native'], [true, false, 'Bash']]) {
        await row.dispose(); await new Promise(resolve => setImmediate(resolve))
        assert.equal(count(await assemble(agent), guidance), 0, 'disposal removes the old owner')
        row = await ctx.plugin(Bundle, { ...config, [preset]: { ...config[preset], bash, residentTools } })
        await new Promise(resolve => setImmediate(resolve))
        const current = await assemble(agent)
        const shellOwnsGuidance = bash && process.platform === 'win32'
        // Native suppresses its extra guidance when the Windows Bash section is live.
        const nativeOwnsGuidance = residentTools && !shellOwnsGuidance
        const discoveryOwnsGuidance = current.tools.some(tool => tool.name === 'ops_discover_tools') && !shellOwnsGuidance && !nativeOwnsGuidance
        const expectedOwners = Number(shellOwnsGuidance || nativeOwnsGuidance || discoveryOwnsGuidance)
        assert.equal(count(current, guidance), expectedOwners, `${owner} keeps the platform-eligible owner after reload: ${textOf(current)}`)
        assert.equal(current.tools.some(tool => tool.name === 'ops_inspect_local_file'), residentTools)
        assert.equal(current.tools.some(tool => tool.name === BASH_TOOL), shellOwnsGuidance)
        assert.equal(bashSections(current).length, shellOwnsGuidance ? 1 : 0)
        const nativeSection = current.sections.find(section => section.name === modeSectionName('mode-' + preset))
        if (!expectedOwners) {
          assert.equal(bashSections(current).length, 0, `${process.platform} has no Bash guidance owner`)
          assert.equal(nativeSection?.text.trim() ?? '', '', `${process.platform} has no Native guidance owner`)
        }
      }
      await row.dispose(); await new Promise(resolve => setImmediate(resolve))
      const otherGuidance = 'Keep the discovery-only consumer independent.'
      await ctx.plugin(residentKernel())
      const otherRow = await ctx.plugin(integration({ preset: 'directory-only', profile: 'discovery', extraGuidance: otherGuidance }))
      const other = await mint('directory-only', { preset: 'directory-only', pwsh: false })
      assert.equal(count(await assemble(other), otherGuidance), 1)
      assert.equal(count(await assemble(other), guidance), 0)
      assert.equal(count(await assemble(agent), otherGuidance), 0)
      await otherRow.dispose()
      assert.equal(count(await assemble(other), otherGuidance), 0)
    } finally { await shutdown(ctx) }
  }))
}

for (const [label, config, hidden] of [
  ['default intent', { global: { hidePwsh: true } }, true],
  ['explicit opt-out', { minimal: { hidePwsh: false } }, false],
  ['explicit intent', { global: { hidePwsh: true }, minimal: { hidePwsh: true } }, true],
  ['legacy explicit intent without global', { minimal: { hidePwsh: true } }, true],
  ['global veto', { global: { hidePwsh: false }, minimal: { hidePwsh: true } }, false],
  ['link on without companion', { minimal: { hidePwsh: true }, other: { pwsh7Link: true } }, false],
  ['link off without companion', { minimal: { hidePwsh: true }, other: { pwsh7Link: false } }, true],
  ['missing Bash', { minimal: { hidePwsh: true, bashPath: path.resolve('absent-shell-slot.exe') } }, false],
]) await test(`${label}: hide PowerShell only with enabled, ready, unlinked intent`, () => withTempDir('shell-slot-hide', async cwd => {
  const { ctx, mint, names, assemble } = await boot(cwd)
  try {
    await ctx.plugin(Bundle, { ...minimalOnly, ...config })
    const agent = await mint('hide')
    const stepNames = (await assemble(agent)).tools.map(tool => tool.name)
    if (config.minimal?.bashPath) assert.equal(stepNames.includes(BASH_TOOL), false)
    assert.equal(stepNames.includes('pwsh'), !(hidden && process.platform === 'win32'))
    assert.equal(stepNames.includes('pwsh_persistent'), !(hidden && process.platform === 'win32'))
  } finally { await shutdown(ctx) }
}))

await test('custom consumers keep file replacement intent separate from PowerShell hiding', () => withTempDir('shell-slot-custom', async cwd => {
  for (const link of [false, true]) {
    const { ctx, mint, names, assemble } = await boot(cwd)
    try {
      const saved = resolveIntegrationConfig({ preset: 'custom', profile: 'shell', replaceOfficial: true })
      assert.equal(saved.hidePwsh, false)
      const switches = { bash: true, hidePwsh: true, hideOfficialTools: true, dynamicTools: false }
      await ctx.plugin({ name: 'custom-slot', apply(inner) { return mountIntegration(inner, gateConsumer(saved, switches, link)) } })
      const agent = await mint('custom-' + link, { preset: 'custom' })
      await assemble(agent)
      assert.equal(names(agent).includes(BASH_TOOL), true)
      assert.equal(names(agent).includes('pwsh'), true)
      const draft = readRowValues({ presets: { custom: { profile: 'shell', replaceOfficial: true } } })
      assert.equal(draft['presets.custom.hidePwsh'], false)
      assert.deepEqual(changedFields(draft, { presets: { custom: { profile: 'shell', replaceOfficial: true } } }), [])
    } finally { await shutdown(ctx) }
  }
}))

await test('two agents, permission withdrawal, reload and dispose preserve the host slot', () => withTempDir('shell-slot-lifetime', async cwd => {
  const { ctx, mint, names, assemble } = await boot(cwd)
  try {
    let row = await ctx.plugin(integration({ preset: 'bash-only', profile: 'shell' }))
    const own = await mint('own', { preset: 'bash-only' }), sibling = await mint('sibling', { preset: 'other' })
    const peer = await mint('peer', { preset: 'bash-only' })
    assert.equal(bashSections(await assemble(peer)).length, 1)
    assert.notEqual(ctx.get('tools').get(BASH_TOOL, own), ctx.get('tools').get(BASH_TOOL, peer))
    assert.equal(bashSections(await assemble(own)).length, 1)
    assert.equal(bashSections(await assemble(sibling)).length, 0)
    assert.equal(names(sibling).includes(BASH_TOOL), false)
    own.session.mode = 'unavailable'
    await ctx.serial('session/event', own.session, { type: 'sandbox/mode' }); await new Promise(resolve => setImmediate(resolve))
    assert.equal(bashSections(await assemble(own)).length, 0)
    assert.equal(names(own).includes('pwsh'), true)
    assert.equal(bashSections(await assemble(peer)).length, 1, 'another session keeps its own authority and guidance')
    own.session.mode = 'danger-full-access'
    await ctx.serial('session/event', own.session, { type: 'sandbox/mode' }); await new Promise(resolve => setImmediate(resolve))
    assert.equal(bashSections(await assemble(own)).length, 1)
    await row.dispose(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(bashSections(await assemble(own)).length, 0)
    row = await ctx.plugin(integration({ preset: 'bash-only', profile: 'shell' }))
    await waitFor(() => ctx.get('tools').get(BASH_TOOL, own) !== undefined, { what: 'remounted Bash publication for the existing agent' })
    assert.equal(bashSections(await assemble(own)).length, 1)
    assert.equal(bashSections(await assemble(sibling)).length, 0)
    assert.equal((await assemble(own)).sections.find(section => section.name === 'tool:pwsh').text, pwshText)
    await row.dispose(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(names(own).includes(BASH_TOOL), false)
    assert.equal(names(own).includes('pwsh'), true)
  } finally { await shutdown(ctx) }
}))

await test('real Bash uses Bash syntax and honest result fields through the real host dispatcher', () => withTempDir('shell-slot-call', async cwd => {
  const { ctx, mint, assemble } = await boot(cwd)
  try {
    await ctx.plugin(integration({ preset: 'calls', profile: 'shell' }))
    const agent = await mint('calls', { preset: 'calls' })
    await assemble(agent)
    const call = (id, args) => executeCall(ctx, { name: BASH_TOOL, callId: id, agent, signal: new AbortController().signal, arguments: args })
    const success = await call('bash-syntax', { command: 'v=slot; printf "%s" "$(printf %s "$v")" | cat', description: 'Check Bash variables substitution and pipeline' })
    assert.equal(success.isError, false, JSON.stringify(success))
    assert.equal(success.value.status, 'completed', JSON.stringify(success))
    assert.equal(success.value.exitCode, 0)
    assert.equal(success.value.stdout.text, 'slot')
    fs.writeFileSync(path.join(cwd, 'slot.sh'), 'printf script-slot\n')
    const script = await call('bash-script', { script_path: 'slot.sh', description: 'Run the existing Bash script file' })
    assert.equal(script.value.status, 'completed', JSON.stringify(script))
    assert.equal(script.value.stdout.text, 'script-slot')
    const invalid = await call('bash-invalid', { command: 'true', description: 'Reject undeclared PowerShell replacement argument', pwsh: true })
    assert.equal(invalid.value.failure.code, 'INVALID_BASH_ARGUMENT')
    assert.equal(invalid.value.failure.effectState, 'none')
    assert.equal(invalid.value.exitCode, null)
    assert.ok(!invalid.content.some(block => block.type === 'text' && /\[exit code: 0\]/.test(block.text)))
  } finally { await shutdown(ctx) }
}))

await test('job schema and guidance change together on mount and disposal', () => withTempDir('shell-slot-jobs', async cwd => {
  const { ctx, mint, assemble } = await boot(cwd)
  try {
    await ctx.plugin(integration({ preset: 'jobs', profile: 'shell' }))
    const agent = await mint('jobs', { preset: 'jobs' })
    assert.match(bashSections(await assemble(agent))[0].text, /Host jobs are unavailable/)
    const jobs = await ctx.plugin(LocalJobs, {})
    await new Promise(resolve => setImmediate(resolve))
    const assembly = await assemble(agent)
    assert.equal(assembly.tools.find(tool => tool.name === BASH_TOOL).parameters.properties.run_in_background.type, 'boolean')
    assert.match(bashSections(assembly)[0].text, /Promotion is not command completion/)
    await jobs.dispose(); await new Promise(resolve => setImmediate(resolve))
    const after = await assemble(agent)
    assert.equal(after.tools.find(tool => tool.name === BASH_TOOL).parameters.properties.run_in_background, undefined)
    assert.match(bashSections(after)[0].text, /Host jobs are unavailable/)
  } finally { await shutdown(ctx) }
}))

await test('pinned third-party bridge compat on/off/reload/dispose leaves native pwsh callable', () => withTempDir('shell-slot-bridge', async cwd => {
  const { ctx, mint, names, assemble } = await boot(cwd)
  try {
    const linked = gateConsumer(resolveIntegrationConfig({ preset: 'linked', profile: 'shell', hidePwsh: true }),
      { bash: true, hidePwsh: true, hideOfficialTools: true, dynamicTools: false }, true)
    await ctx.plugin({ name: 'linked-shell', apply(inner) { return mountIntegration(inner, linked) } })
    const agent = await mint('linked', { preset: 'linked' })
    await assemble(agent)
    let enabled = true
    const bridge = () => ctx.plugin({ name: 'pinned-pwsh7-bridge', inject: ['tools', 'systemPrompt'], apply(inner) {
      inner.effect(() => mountDshOpsBridge(inner, () => ({ dshOpsCompat: enabled })))
    } })
    let row = await bridge()
    await assemble(agent)
    assert.equal(names(agent).includes('pwsh'), true)
    assert.equal(names(agent).includes('pwsh_persistent'), false)
    enabled = false
    ctx.emit('app-boot/config-reload')
    await assemble(agent)
    assert.equal(names(agent).includes('pwsh_persistent'), true)
    enabled = true
    ctx.emit('app-boot/config-reload')
    await assemble(agent)
    assert.equal(names(agent).includes('pwsh_persistent'), false)
    await row.dispose(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(names(agent).includes('pwsh_persistent'), true)
    row = await bridge()
    const assembled = await assemble(agent)
    assert.equal(names(agent).includes('pwsh'), true)
    assert.equal(bashSections(assembled).length, 1)
    assert.equal(assembled.sections.find(section => section.name === 'tool:pwsh').text, pwshText)
    const result = await executeCall(ctx, { name: 'pwsh', callId: 'native-pwsh', agent, signal: new AbortController().signal, arguments: { command: 'Get-Date' } })
    assert.equal(result.isError, false)
    await row.dispose(); await new Promise(resolve => setImmediate(resolve))
  } finally { await shutdown(ctx) }
}))

await test('a hidden PowerShell fallback returns when Bash authority is withdrawn', () => withTempDir('shell-slot-fallback', async cwd => {
  const { ctx, mint, names, assemble } = await boot(cwd)
  try {
    await ctx.plugin(Bundle, { ...minimalOnly, minimal: { hidePwsh: true }, other: { pwsh7Link: false } })
    const agent = await mint('fallback')
    const initial = await assemble(agent)
    assert.equal(initial.tools.some(tool => tool.name === 'pwsh'), process.platform !== 'win32')
    agent.session.mode = 'unavailable'
    await ctx.serial('session/event', agent.session, { type: 'sandbox/mode' }); await new Promise(resolve => setImmediate(resolve))
    await assemble(agent)
    assert.equal(names(agent).includes(BASH_TOOL), false)
    assert.equal(names(agent).includes('pwsh'), true)
    assert.equal(bashSections(await assemble(agent)).length, 0)
  } finally { await shutdown(ctx) }
}))

await test('Bash guidance keeps path and safety rules without repeating the tool contract', () => {
  assert.match(bashOperationDescription('linux'), /local host Bash/)
  const posix = renderBashGuidance(false, 'linux')
  assert.doesNotMatch(posix, /MSYS|D:\/repo|not Linux|fresh non-login|description is required|failure\.code/)
  const windows = renderBashGuidance(true, 'win32')
  assert.match(windows, /D:\/repo or \/d\/repo/)
  assert.match(windows, /drive-less \/tmp or \/ is not a Windows workdir/)
  assert.match(windows, /MSYS paths such as \/d\/repo/)
  assert.match(windows, /longer than about 1 KB.*script_path/)
  assert.match(windows, /exactly one of command or script_path/)
  assert.match(windows, /sandbox remains authoritative.*must not be bypassed/)
  assert.match(windows, /spill paths describe retained output, not completeness/)
  assert.match(windows, /Promotion is not command completion.*job_output.*job_kill/)
  assert.doesNotMatch(windows, /fresh non-login|foreground includes status|description is required|run_in_background returns/)
})
report('shell-slot')
