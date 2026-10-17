/** Current component routing: advertise only tools actually visible to the model. */
import * as policy from '../lib/policy.js'
import { BASH_TOOL, FILE_TOOLS, TOOLING_SECTION, HOST_SHELL_SECTION,
  TOOL_PREFIX, publicToolName, renderToolingPolicy, renderHostShellPolicy,
  ladderLevels, hostShellRefusal, hostShellEnforcement } from '../lib/policy.js'
import { assert, report, test } from './lib/harness.mjs'
const files = FILE_TOOLS.map(publicToolName)
// The tools the removed FastCtx background component used to publish.
const removed = ['ops_run', 'ops_run_background', 'ops_job_output', 'ops_job_list', 'ops_job_kill']
await test('an empty registry produces no tooling guidance', () => {
  assert.equal(renderToolingPolicy({ published: [] }), '')
})
await test('file guidance names exactly the available file tools', () => {
  const text = renderToolingPolicy({ published: files, shellComponent: false })
  assert.match(text, /^# Repository file tools/)
  for (const name of files) assert.ok(text.includes(name))
  for (const name of [BASH_TOOL, ...removed, 'PowerShell 7']) assert.equal(text.includes(name), false)
  assert.match(text, /Every file tool has one `path`/)
  assert.equal(text.includes('Legacy ops_* file paths are absolute'), false)
  assert.equal(text.includes('FastCtx’s own session cwd'), false)
  assert.match(text, /do not switch to a shell workaround/)
  assert.match(text, /pass only declared fields/)
})
await test('the routing table keeps file-tool routing value, not duplicated syntax (#44)', () => {
  const text = renderToolingPolicy({ published: files, shellComponent: false })
  // Per-tool syntax (ops_glob `pattern` is an ARRAY; *.md top level only; ops_grep has no
  // `include`; ops_replace `pattern` is literal text) now lives in each tool's own description;
  // the table keeps only routing-unique guidance.
  assert.match(text, /Every file tool has one `path`/)
  assert.match(text, /ops file tools never throw: check `status` and `error\.code`/)
  assert.equal(text.includes('ops_bash resolves with'), false)
  const bash = renderToolingPolicy({ published: [BASH_TOOL] })
  assert.match(bash, /ops_bash resolves with `status` \(completed\/failed\).*throws only for invalid arguments or an unavailable executor/)
  assert.equal(bash.includes('never throw'), false, 'no file-tool contract without file tools')
  assert.equal(bash.includes('include'), false)
})
await test('partial tool availability never advertises missing tools', () => {
  const text = renderToolingPolicy({ published: [files[0]] })
  assert.ok(text.includes(files[0]))
  for (const name of files.slice(1)) assert.equal(text.includes(name), false)
})
await test('shell routing prefers bash and names bundled pwsh only when available', () => {
  const text = renderToolingPolicy({ published: [BASH_TOOL, 'pwsh'], pwsh7: true })
  assert.match(text, /^# Shell routing: bash → PowerShell 7/)
  assert.match(text, /bundled PowerShell 7 via host/)
  assert.match(text, /fix bash errors in bash, do not switch shells/)
  assert.match(text, /longer than about 1 KB.*script_path/)
  assert.equal(renderToolingPolicy({ published: ['pwsh'] }).includes('bundled PowerShell'), false)
  assert.equal(renderToolingPolicy({ published: ['pwsh'], shellComponent: false }), '')
})
await test('the removed background tools are never advertised, even if a registry still lists them', () => {
  assert.equal(renderToolingPolicy({ published: removed, shellComponent: false }), '')
  const mixed = renderToolingPolicy({ published: [...files, BASH_TOOL, ...removed] })
  for (const name of removed) assert.equal(mixed.includes(name), false, `${name} is not advertised`)
  assert.equal(mixed.includes('job IDs'), false)
  for (const name of ['BACKGROUND_TOOLS', 'SHELL_TOOLS']) assert.equal(name in policy, false, `${name} is no longer exported`)
})
await test('levels are registry facts, never just resolved executables', () => {
  assert.deepEqual(ladderLevels({ published: [], pwsh: true }), { files: false, bash: false, pwsh: false })
  assert.deepEqual(ladderLevels({ published: [files[0], BASH_TOOL, 'pwsh'], pwsh: true }),
    { files: true, bash: true, pwsh: true })
})
await test('deployment guidance is appended and transport vocabulary stays hidden', () => {
  const text = renderToolingPolicy({ published: files, extraGuidance: 'Never edit vendor/.' })
  assert.ok(text.endsWith('Never edit vendor/.'))
  assert.equal(text.includes('mcp__'), false)
  assert.equal(TOOL_PREFIX, 'ops_')
  assert.equal(BASH_TOOL, publicToolName('bash'))
})
await test('explicit deny refuses only configured names even without ops commands', () => {
  const denied = new Set(['pwsh', 'bash'])
  for (const toolName of denied) {
    const result = hostShellRefusal({ toolName, denied })
    assert.equal(result.kind, 'deny')
    assert.match(result.reason, /operator policy change/)
  }
  for (const toolName of ['read', 'edit', BASH_TOOL]) assert.equal(hostShellRefusal({ toolName, denied }), undefined)
  for (const levels of [{}, { bash: false }, { bash: true }]) {
    assert.deepEqual(hostShellEnforcement({ shellPolicy: 'deny-host-shell', levels }), { hide: true, reason: undefined })
    assert.deepEqual(hostShellEnforcement({ shellPolicy: 'advise', levels }), { hide: false, reason: undefined })
  }
})
await test('legacy second section is retired; component section prefix stays stable', () => {
  assert.equal(renderHostShellPolicy(), '')
  assert.equal(HOST_SHELL_SECTION, 'dsh-ops:host-shell-policy')
  assert.equal(TOOLING_SECTION, 'dsh-ops:repository-tooling')
})
report('policy')
