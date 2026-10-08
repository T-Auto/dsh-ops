/**
 * The injected policy text: the ladder it renders, what it must say, and when
 * it must say nothing.
 *
 * These are model-facing contracts. The assertions pin the exact claims the
 * policy makes — which rung exists, which tool each rung is reached through,
 * which host mechanism it replaces, and that a failed call is corrected rather
 * than routed to another shell — because that is the whole mechanism by which
 * the plugin changes model behavior. They also pin the other half of the
 * contract: every rung the deployment cannot run disappears from the text, and
 * no wording promises a fallback, a retry, or a switch the plugin does not
 * perform.
 */

import {
  BASH_TOOL,
  FILE_TOOLS,
  HOST_SHELL_SECTION,
  SHELL_TOOLS,
  TOOLING_SECTION,
  TOOL_PREFIX,
  hostShellEnforcement,
  hostShellRefusal,
  ladderLevels,
  publicToolName,
  renderHostShellPolicy,
  renderToolingPolicy,
} from '../lib/policy.js'
import { assert, report, test } from './lib/harness.mjs'

/** A deployment that resolved every rung. */
const ALL_RUNGS = { fastctx: true, bash: true, pwsh: true }
/** The render inputs a fully equipped deployment produces. */
const NAMED = { enableShellTools: true, levels: ALL_RUNGS }
const full = renderToolingPolicy(NAMED)

/** One rung heading, matched as the model sees it. */
const RUNG = (number, title) => new RegExp(`^## Rung ${number} — ${title}$`, 'mu')

await test('the tooling section is empty until the FastCtx rung is live', () => {
  assert.equal(renderToolingPolicy({ ...NAMED, levels: { ...ALL_RUNGS, fastctx: false } }), '')
  // The single-rung form older callers use answers for FastCtx alone.
  assert.equal(renderToolingPolicy({ enableShellTools: true, mounted: false }), '')
  assert.notEqual(full, '')
})

await test('every file tool is named by its public name', () => {
  for (const tool of FILE_TOOLS) {
    assert.ok(full.includes(publicToolName(tool)), `policy should name ${tool}`)
  }
})

await test('the shell tools appear only when they are published', () => {
  for (const tool of SHELL_TOOLS) {
    assert.ok(full.includes(publicToolName(tool)), `policy should name ${tool}`)
  }
  const withoutShell = renderToolingPolicy({ ...NAMED, enableShellTools: false })
  for (const tool of SHELL_TOOLS) {
    assert.equal(withoutShell.includes(publicToolName(tool)), false)
  }
  for (const tool of FILE_TOOLS) {
    assert.ok(withoutShell.includes(publicToolName(tool)))
  }
})

await test('the policy names the host mechanisms it replaces', () => {
  for (const forbidden of ['PowerShell', 'Select-String', 'Get-ChildItem', 'findstr']) {
    assert.ok(full.includes(forbidden), `policy should name ${forbidden}`)
  }
})

await test('the policy forbids shell-based repository work in imperative terms', () => {
  assert.match(full, /never by building a PowerShell or bash command line/)
})

await test('a failed FastCtx call is corrected, not routed to a shell', () => {
  assert.match(full, /correct its arguments and call it again/)
  assert.match(full, /Do not switch to a shell command to work around the error/)
})

await test('the ladder lists the rungs in the order they are to be used', () => {
  assert.match(full, RUNG(1, 'FastCtx \\(`ops_\\*`\\): repository reading, searching, listing, replacing, and commands'))
  assert.match(full, RUNG(2, '`ops_bash`: the bundled bash, for POSIX pipelines and scripts'))
  assert.match(full, RUNG(3, 'PowerShell 7: Windows-native work'))
  assert.match(full, RUNG(4, 'the host\'s own shell tools: last resort'))
  const order = [1, 2, 3, 4].map((number) => full.indexOf(`## Rung ${number} —`))
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'rung headings must appear in ladder order')
  assert.match(full, /in the order they are given/)
  assert.match(full, /choosing between them is your decision/)
})

await test('a rung the deployment cannot run is not mentioned at all', () => {
  const withoutBash = renderToolingPolicy({ ...NAMED, levels: { ...ALL_RUNGS, bash: false } })
  assert.equal(withoutBash.includes(BASH_TOOL), false, 'the bash rung must disappear with its rung')
  assert.equal(withoutBash.includes('bundled bash'), false)
  assert.match(withoutBash, RUNG(2, 'PowerShell 7: Windows-native work'))
  assert.match(withoutBash, RUNG(3, 'the host\'s own shell tools: last resort'))

  const withoutPwsh = renderToolingPolicy({ ...NAMED, levels: { ...ALL_RUNGS, pwsh: false } })
  assert.equal(withoutPwsh.includes('PowerShell 7'), false, 'the pwsh rung must disappear with its rung')
  assert.match(withoutPwsh, RUNG(2, '`ops_bash`: the bundled bash, for POSIX pipelines and scripts'))
  assert.match(withoutPwsh, RUNG(3, 'the host\'s own shell tools: last resort'))

  const bare = renderToolingPolicy({ ...NAMED, levels: { ...ALL_RUNGS, bash: false, pwsh: false } })
  assert.equal(bare.includes(BASH_TOOL), false)
  assert.equal(bare.includes('PowerShell 7'), false)
  assert.match(bare, RUNG(2, 'the host\'s own shell tools: last resort'))
  // The host shell is still named last, and FastCtx is still first.
  assert.match(bare, RUNG(1, 'FastCtx \\(`ops_\\*`\\): repository reading, searching, listing, replacing, and commands'))
  assert.equal(bare.includes('## Rung 3 —'), false, 'the ladder must not leave a gap')
})

await test('a level is a published tool, not a resolved executable', () => {
  const fastctxTool = publicToolName('glob')
  // A resolved bash whose tool never got published — no `subprocess` service, a
  // registration conflict — is a rung the model cannot reach, so the text must
  // not name it.
  const withoutBashTool = renderToolingPolicy({
    enableShellTools: true,
    levels: ladderLevels({ published: [fastctxTool], pwsh: false }),
  })
  assert.equal(withoutBashTool.includes(BASH_TOOL), false)
  assert.equal(withoutBashTool.includes('bundled bash'), false)
  assert.match(withoutBashTool, RUNG(2, 'the host\'s own shell tools: last resort'))

  // The published tool is what turns the rung on, and the rungs after it are
  // numbered without a gap.
  const withBashTool = renderToolingPolicy({
    enableShellTools: true,
    levels: ladderLevels({ published: [fastctxTool, BASH_TOOL], pwsh: true }),
  })
  assert.match(withBashTool, RUNG(2, '`ops_bash`: the bundled bash, for POSIX pipelines and scripts'))
  assert.match(withBashTool, RUNG(3, 'PowerShell 7: Windows-native work'))
  assert.match(withBashTool, RUNG(4, 'the host\'s own shell tools: last resort'))
})

await test('an in-process tool is not evidence that the FastCtx rung is live', () => {
  assert.deepEqual(ladderLevels({ published: [], pwsh: false }), { fastctx: false, bash: false, pwsh: false })
  assert.deepEqual(
    ladderLevels({ published: [BASH_TOOL], pwsh: false }),
    { fastctx: false, bash: true, pwsh: false },
    'the bash rung alone must not render a FastCtx rung the model cannot call',
  )
  assert.equal(
    renderToolingPolicy({ enableShellTools: true, levels: ladderLevels({ published: [BASH_TOOL], pwsh: false }) }),
    '',
    'without the FastCtx rung there is no ladder to render',
  )
  assert.deepEqual(
    ladderLevels({ published: [publicToolName('grep'), BASH_TOOL], pwsh: true }),
    { fastctx: true, bash: true, pwsh: true },
  )
})

await test('the wording never promises a fallback the plugin does not perform', () => {
  for (const promise of [/automatical/i, /\bfalls? back\b/i, /fallback/i, /switch rungs/i,
    /try another (?:shell|tool)/i, /retry with/i, /if one (?:shell|tool) fails/i]) {
    assert.equal(promise.test(full), false, `the policy must not promise ${promise}`)
  }
})

await test('the host shell is stated as the last resort, whatever resolved', () => {
  assert.match(full, /host's own shell tools only for an operation none of the rungs above can run/)
  const bare = renderToolingPolicy({ ...NAMED, levels: { ...ALL_RUNGS, bash: false, pwsh: false } })
  assert.match(bare, /are the last resort, for an operation FastCtx cannot express/)
})

await test('every named tool carries the plugin prefix, and no transport vocabulary leaks', () => {
  for (const tool of [...FILE_TOOLS, ...SHELL_TOOLS]) {
    assert.ok(
      renderHostShellPolicy().includes(publicToolName(tool)) || full.includes(publicToolName(tool)),
      `expected ${publicToolName(tool)} somewhere in the policy`,
    )
    assert.equal(full.includes(`mcp__${tool}`), false)
  }
  assert.equal(full.includes('mcp__'), false)
  assert.equal(renderHostShellPolicy().includes('mcp__'), false)
  assert.equal(TOOL_PREFIX, 'ops_')
  assert.equal(BASH_TOOL, publicToolName('bash'))
})

await test('deployment guidance is appended verbatim', () => {
  const extended = renderToolingPolicy({ ...NAMED, extraGuidance: 'Never edit vendor/.' })
  assert.ok(extended.endsWith('Never edit vendor/.'))
  assert.equal(renderToolingPolicy(NAMED).includes('Never edit vendor/.'), false)
})

await test('the host-shell section always names the four file tools', () => {
  const text = renderHostShellPolicy()
  for (const tool of FILE_TOOLS) {
    assert.ok(text.includes(publicToolName(tool)))
  }
  assert.match(text, /Do not construct a PowerShell command/)
})

await test('the fence refuses the configured names and delegates everything else', () => {
  const denied = new Set(['pwsh', 'bash'])
  const refusal = hostShellRefusal({ toolName: 'pwsh', denied })
  assert.equal(refusal.kind, 'deny')
  assert.match(refusal.reason, /ops_grep/)
  assert.match(refusal.reason, /Retry the operation/)
  assert.equal(hostShellRefusal({ toolName: 'bash', denied }).kind, 'deny')
  assert.equal(hostShellRefusal({ toolName: publicToolName('run'), denied }), undefined)
  assert.equal(hostShellRefusal({ toolName: 'read', denied }), undefined)
})

await test('advise hides nothing, whatever the ladder says', () => {
  for (const levels of [
    { fastctx: true, bash: false, pwsh: false },
    { fastctx: false, bash: true, pwsh: false },
    { fastctx: true, bash: true, pwsh: true },
  ]) {
    assert.deepEqual(
      hostShellEnforcement({ shellPolicy: 'advise', levels }),
      { hide: false, reason: undefined },
    )
  }
})

await test('deny-host-shell may hide once a rung of its own is live', () => {
  for (const ladder of [
    { fastctx: true, bash: true, pwsh: false },
    { fastctx: true, bash: false, pwsh: true },
    { fastctx: false, bash: true, pwsh: false },
  ]) {
    assert.deepEqual(
      hostShellEnforcement({ shellPolicy: 'deny-host-shell', levels: ladder }),
      { hide: true, reason: undefined },
    )
  }
})

await test('deny-host-shell leaves the host shells visible when no rung of its own is live', () => {
  // Whether a rung is live is a registry fact: a resolved bash whose tool never
  // got published is not one, and the FastCtx rung does not make hiding legal.
  for (const levels of [
    { fastctx: true, bash: false, pwsh: false },
    { fastctx: false, bash: false, pwsh: false },
  ]) {
    const decision = hostShellEnforcement({ shellPolicy: 'deny-host-shell', levels })
    assert.equal(decision.hide, false, 'hiding the last shell would leave no way to run a command')
    assert.match(decision.reason, /stay visible/)
    assert.match(decision.reason, /fence is still in force/)
  }
})

await test('the section names and orders are stable', () => {
  assert.equal(HOST_SHELL_SECTION, 'dsh-ops:host-shell-policy')
  assert.equal(TOOLING_SECTION, 'dsh-ops:repository-tooling')
  assert.ok(HOST_SHELL_SECTION !== TOOLING_SECTION)
})

report('policy')
