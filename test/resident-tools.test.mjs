/** The actual assembled file/discovery lane, with the full catalogue measured separately. */
import fs from 'node:fs'
import path from 'node:path'
import { getEncoding } from 'js-tiktoken'
import { startupAssessment } from '../bench/gates/integrity.mjs'
import * as fileModule from '../lib/components/file/index.js'
import { publicToolName } from '../lib/policy.js'
import { NativeFileTools } from '../lib/file/runtime.js'
import { NATIVE_TOOLS } from '../lib/capabilities/registry.js'
import { DISCOVERABLE_TOOLS } from '../lib/discovery/config.js'
import { bashToolDefinition } from '../lib/shells/tool.js'
import { hostBashDefinition } from '../lib/shells/host-tool.js'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
import { bootDiscoveryHost, mintDiscoveryAgent, discoveryNextStep } from './lib/discovery.mjs'
import { shutdown, scopedToolNames, registryNames, callTool } from './lib/host.mjs'
import { legacyComponent } from './lib/legacy-component.mjs'
const file = legacyComponent(fileModule)

const READ = publicToolName('read_files'), DISCOVER = publicToolName('discover_tools')
const DIRECTORY = '# On-demand Native tool directory'
function assertDeferredDirectory(ctx, agent, assembly, eligible) {
  const directories = assembly.sections.filter(section => section.text.includes(DIRECTORY))
  assert.equal(directories.length, eligible.length ? 1 : 0)
  const directory = directories[0]?.text.split(DIRECTORY)[1] ?? ''
  const guidance = assembly.sections.map(section => section.text.split(DIRECTORY)[0]).join('\n')
  const listed = [...directory.matchAll(/^- (ops_\w+): /gm)].map(match => match[1])
  assert.deepEqual(listed.sort(), eligible.map(publicToolName).sort(), 'only the eligible deferred pool is advertised')
  for (const raw of DISCOVERABLE_TOOLS) {
    const name = publicToolName(raw)
    assert.equal(assembly.tools.some(tool => tool.name === name), false, `${name} is not in the callable schema`)
    assert.equal(scopedToolNames(ctx, agent).includes(name), false, `${name} is not callable`)
    assert.equal(guidance.includes(name), false, `${name} is not action guidance`)
  }
  if (eligible.length) {
    assert.match(directory, /resident\/callable tools first/)
    assert.ok(directory.includes(DISCOVER))
    assert.match(directory, /select:exact_tool_name/)
    assert.match(directory, /NOT callable or authorized/)
    assert.match(directory, /Selection executes no action/)
    assert.match(directory, /next model step, after their schema appears/)
    assert.match(directory, /Execution authorization is checked on invocation/)
  }
}
const measure = tools => {
  const wire = JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })))
  return { tokens: getEncoding('cl100k_base').encode(wire).length, bytes: Buffer.byteLength(wire) }
}
async function mount(config) {
  const host = await bootDiscoveryHost(config)
  const fileFiber = await host.ctx.plugin(file, { required: true })
  await waitFor(() => registryNames(host.ctx).includes(READ))
  return { ...host, fileFiber }
}
await test('the resident file row publishes one bounded reader even with the discovery entry disabled', () => withTempDir('resident', async dir => {
  const { ctx } = await mount({ enabled: false })
  try {
    const agent = await mintDiscoveryAgent(ctx, 'resident-disabled', dir)
    assert.deepEqual(registryNames(ctx), [READ])
    assert.deepEqual(scopedToolNames(ctx, agent), [READ])
    fs.writeFileSync(path.join(dir, 'read.txt'), 'bounded reader')
    fs.writeFileSync(path.join(dir, 'second.txt'), 'second file')
    const read = await callTool(ctx, READ, { files: [{ path: 'read.txt' }, { path: 'second.txt' }] }, undefined, agent)
    assert.equal(read.value.status, 'completed')
    assert.match(read.text, /1\|bounded reader/); assert.match(read.text, /1\|second file/)
    const absent = await ctx.get('tools').execute({ agent, name: publicToolName('stat'), arguments: { path: 'read.txt' }, callId: 'absent', signal: new AbortController().signal })
    assert.equal(absent.isError, true)
  } finally { await shutdown(ctx) }
}))
await test('gate the approved file/discovery budget and separately retain full startup Bash cost', () => withTempDir('resident', async dir => {
  const { ctx } = await mount()
  try {
    const agent = await mintDiscoveryAgent(ctx, 'resident-budget', dir)
    const assembly = await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [READ, DISCOVER].sort())
    const core = measure(assembly.tools)
    const discovery = assembly.tools.find(tool => tool.name === DISCOVER)
    const full = measure([...NATIVE_TOOLS.map(raw => new NativeFileTools({ctx:{},config:{}}).definition(raw)), discovery])
    const base = bashToolDefinition({ file: 'fixture', source: 'test', subprocess: {} })
    const shell = hostBashDefinition({ get: () => undefined }, base,
      () => { throw new Error('Schema measurement must not execute a command') }, () => dir, {})
    assert.deepEqual(shell.parameters.required, ['description'])
    assert.ok(shell.parameters.properties.run_in_background)
    const withShell = measure([...assembly.tools, shell])
    console.log('  cl100k_base/js-tiktoken1.0.21 compact host-schema JSON:', JSON.stringify({ core, fullFileCatalogue: full, hostBash: measure([shell]), corePlusBash: withShell }))
    assert.equal(core.tokens, 261, JSON.stringify(core))
    assert.ok(full.tokens > 400 && full.tokens > core.tokens, 'retain honest full-surface measurement')
    assert.ok(withShell.tokens > 400, 'the complete startup surface remains separately reported')
    const assessed = startupAssessment([...assembly.tools, shell], 'win32')
    assert.equal(assessed.status, 'passed')
    assert.equal(assessed.gatedMeasurement.tokens, core.tokens)
    assert.equal(assessed.measurement.tokens, withShell.tokens)
    assert.equal(startupAssessment(assembly.tools, 'win32').status, 'blocked', 'missing Bash cannot pass a narrower budget')
    assertDeferredDirectory(ctx, agent, assembly, DISCOVERABLE_TOOLS)
    const selected = await callTool(ctx, DISCOVER, { query: 'select:ops_stat' }, undefined, agent)
    assert.deepEqual(selected.value.activated, [publicToolName('stat')])
    assert.equal(scopedToolNames(ctx, agent).includes(publicToolName('stat')), false)
    await discoveryNextStep(ctx, agent)
    const active = await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.ok(active.tools.some(tool => tool.name === publicToolName('stat')))
    assert.ok(active.sections.some(section => section.text.split(DIRECTORY)[0].includes(publicToolName('stat'))))
    assert.equal(active.sections.some(section => section.text.split(DIRECTORY)[1]?.includes(publicToolName('stat'))), false)
  } finally { await shutdown(ctx) }
}))
await test('the assembled directory excludes disallowed, unavailable and read-only mutation capabilities', () => withTempDir('resident-directory', async dir => {
  const { ctx } = await mount({ allowedTools: ['stat', 'write_file'] })
  try {
    const writer = await mintDiscoveryAgent(ctx, 'directory-writer', dir)
    assertDeferredDirectory(ctx, writer, await ctx.get('systemPrompt').assemble({ scope: writer }), ['stat', 'write_file'])
    const reader = await mintDiscoveryAgent(ctx, 'directory-reader', dir, undefined, 'read-only')
    assertDeferredDirectory(ctx, reader, await ctx.get('systemPrompt').assemble({ scope: reader }), ['stat'])
    reader.session.mode = 'unavailable'
    await ctx.serial('session/event', reader.session, { type: 'sandbox/mode' })
    const unavailable = await ctx.get('systemPrompt').assemble({ scope: reader })
    assertDeferredDirectory(ctx, reader, unavailable, [])
    assert.equal(unavailable.tools.some(tool => tool.name === DISCOVER), false)
  } finally { await shutdown(ctx) }
}))
await test('always-loaded choices explicitly expand the initial budget and survive file-row unload', () => withTempDir('resident', async dir => {
  const { ctx, fileFiber } = await mount({ allowedTools: ['glob', 'grep'], alwaysLoaded: ['glob', 'grep'] })
  try {
    const agent = await mintDiscoveryAgent(ctx, 'resident-expanded', dir)
    const assembly = await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [READ, DISCOVER, publicToolName('glob'), publicToolName('grep')].sort())
    assert.ok(measure(assembly.tools).tokens > 400)
    await fileFiber.dispose()
    assert.deepEqual(scopedToolNames(ctx, agent), [DISCOVER, publicToolName('glob'), publicToolName('grep')].sort())
  } finally { await shutdown(ctx) }
}))
report('resident-tools')
