/**
 * The batching guidance asset and the row switch that delivers it.
 *
 * The trigger itself lives in batching-trigger.test.mjs; this suite covers the shipped
 * Markdown, its loader contract, and the one row allowed to publish it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { BATCHING_GUIDANCE_ID, BATCHING_GUIDANCE_REVISION, LOAD_PROSE_ANCHOR, LOAD_SECTION_HEADING, LOAD_TABLE_ROW_PREFIX, SANDBOX_SECTION_HEADING, loadBatchingGuidance, renderBatchingGuidance } from '../lib/ptc/batching-guidance.js'

/** The editable guidance file shipped at the package root, outside the build output. */
const GUIDANCE_FILE = path.join(PACKAGE_ROOT, 'prompts', 'batching-guidance.md')

await test('the shipped guidance is English Markdown with its host-source identity', () => {
  // The wording is editable data, so pin its structure and the rules delivery relies on.
  const text = loadBatchingGuidance()
  for (const heading of ['# Batch tool calls', 'Core rules', 'Common mistakes', 'Promise.all', 'e.message']) {
    assert.ok(text.includes(heading), heading)
  }
  assert.equal(BATCHING_GUIDANCE_ID, 'batching-guidance')
  // A wording or format change is a product change and must bump the revision.
  assert.equal(BATCHING_GUIDANCE_REVISION, '9')
})

await test('the guidance loader returns exactly the shipped Markdown file', () => {
  assert.equal(loadBatchingGuidance(), fs.readFileSync(GUIDANCE_FILE, 'utf8').trim())
  // Repeated loads serve the cache instead of reading the file again.
  assert.equal(loadBatchingGuidance(), loadBatchingGuidance())
})

await test('an unreadable guidance file degrades to an empty string without throwing', () => {
  const missing = path.join(PACKAGE_ROOT, 'prompts', 'missing-guidance.md')
  let text
  assert.doesNotThrow(() => { text = loadBatchingGuidance(missing) })
  assert.equal(text, '')
  // The failure is cached as well, so later deliveries stay silent.
  assert.equal(loadBatchingGuidance(missing), '')
})

await test('the ops-ptc row is the one row configured to deliver the guidance', async () => {
  const { parse } = await import('yaml')
  const { resolveMergedConfig } = await import('../lib/settings/merged.js')
  const { resolveModeConfig } = await import('../lib/modes/config.js')
  const { modeGate } = await import('../lib/presets/builtin.js')
  // Only ops-ptc defaults on; the row-level switch remains an explicit override.
  const defaults = resolveMergedConfig()
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) assert.equal(defaults[mode].config.batchingGuidance, false, mode)
  // The preset keeps its defining guidance even when an older profile replaces the bundle config.
  // An explicit false still opts out; other modes remain quiet by default.
  assert.equal(defaults['ops-ptc'].config.batchingGuidance, true)
  assert.equal(resolveModeConfig({ batchingGuidance: false }, 'ops-ptc').batchingGuidance, false)
  assert.equal(resolveModeConfig({ batchingGuidance: true }, 'ops-ptc').batchingGuidance, true)
  assert.throws(() => resolveModeConfig({ batchingGuidance: 'yes' }, 'ops-ptc'), /batchingGuidance must be boolean/)
  // The switch rides the consumer gate; a row that drops it cannot deliver.
  assert.equal(modeGate({}, 'ops-ptc', true).batching, true)
  assert.equal(modeGate({}, 'ops-ptc', false).batching, false)
  // The shipped bundle enables it for ops-ptc alone (the comparison arm).
  const patch = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'))
  const config = patch.flatMap(entry => entry.insert ?? [])[0].config
  assert.equal(config['ops-ptc'].batchingGuidance, true)
  for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) assert.equal(Object.hasOwn(config[mode], 'batchingGuidance'), false, mode)
  assert.equal(resolveMergedConfig(config)['ops-ptc'].config.batchingGuidance, true)
  assert.equal(modeGate({}, 'ops-ptc', resolveMergedConfig(config)['ops-ptc'].config.batchingGuidance).batching, true)
  // The telemetry switch is diagnostics only: off by default, YAML-only, never context.
  assert.equal(resolveModeConfig({}).batchingTelemetry, false)
  assert.equal(resolveModeConfig({ batchingTelemetry: true }, 'ops-ptc').batchingTelemetry, true)
  assert.throws(() => resolveModeConfig({ batchingTelemetry: 'yes' }), /batchingTelemetry must be boolean/)
  assert.equal(modeGate({}, 'ops-ptc', true, true).telemetry, true)
  assert.equal(modeGate({}, 'ops-ptc', true).telemetry, false, 'an absent switch never turns observation on')
})

await test('a legacy whole-row profile override retains ops-ptc guidance without enabling telemetry', async () => {
  const { resolveMergedConfig } = await import('../lib/settings/merged.js')
  const { modeGate } = await import('../lib/presets/builtin.js')
  const legacy = { global: { bash: true, hidePwsh: true, hideOfficialTools: true, dynamicTools: true },
    ptc: { enabled: true, residentTools: true } }
  for (const config of [legacy, { ...legacy, 'ops-ptc': {} }, { ...legacy, 'ops-ptc': { enabled: true, residentTools: true } }]) {
    const resolved = resolveMergedConfig(config)
    const row = resolved['ops-ptc']
    assert.equal(row.enabled, true)
    assert.equal(row.config.batchingGuidance, true)
    assert.equal(row.config.batchingTelemetry, false)
    assert.equal(modeGate({}, 'ops-ptc', row.config.batchingGuidance).batching, true)
    for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) assert.equal(resolved[mode].config.batchingGuidance, false, mode)
  }
  assert.equal(resolveMergedConfig({ ...legacy, 'ops-ptc': { batchingGuidance: false } })['ops-ptc'].config.batchingGuidance, false)
})

await test('the teacher trajectory pins the first-line plan and a runnable load step', () => {
  // The plan line is the mechanism, not decoration: it must be the first line of the
  // program, and every trajectory must stay copyable against the shipped SDK.
  const text = loadBatchingGuidance()
  assert.ok(text.includes('// plan:'), 'the plan directive is present')
  assert.ok((text.split('// plan:').length - 1) >= 5, 'every trajectory carries a plan line')
  assert.match(text, /first line of the program/, 'the plan line is pinned to the first line')
  for (const name of ['ops_glob', 'ops_grep', 'ops_read_files', 'ops_inspect_local_file']) {
    assert.ok(text.includes(name), name + ' is used by a trajectory')
  }
  assert.ok(text.includes('ops_load_sdk'), 'the load step is taught')
  assert.ok(text.includes('NEXT program'), 'the load lands on the next program')
  assert.ok(text.includes('128'), 'the per-program dispatch ceiling is stated')
  assert.ok(text.includes('nextOffset'), 'paging advances by the cursor')
  // File work belongs to the OPS APIs; a shell example here would teach the bypass.
  for (const banned of ['find .', 'ls -la', 'grep -rn']) assert.ok(!text.includes(banned), banned)
  assert.ok(text.length > 2500 && text.length < 9000, 'guidance stays bounded: ' + text.length)
})

await test('the trim removed repeated prose and the anti-pattern demo', () => {
  // The first-round lesson enters message history, so it must not repeat itself: the
  // anti-pattern section and the trailing prose that restated Step 1 are gone, while
  // the four executable trajectories and their contracts stay byte-identical.
  const text = loadBatchingGuidance()
  assert.equal(text.includes('## Anti-pattern, and its rewrite'), false, 'the anti-pattern demo is gone')
  assert.equal(text.includes('The search is the dependency, so it is awaited first'), false)
  assert.equal(text.includes('The revision and the context are independent'), false)
  assert.equal(text.includes('A loop of dispatches is batched work'), false)
})

await test('the trimmed lesson keeps the four trajectories and restores the two rules', () => {
  const text = loadBatchingGuidance()
  for (const heading of [
    '## Trajectory 1 - reconnaissance', '## Trajectory 2 - search, then read the hits',
    '## Trajectory 3 - a verified edit', '## Trajectory 4 - paging',
  ]) assert.ok(text.includes(heading), heading)
  assert.ok(text.includes('**Load only missing APIs**'), 'load only what the SDK lacks is a core rule')
  assert.ok(text.includes('**Recheck the SDK after a mode change**'), 'the post-mode-change recheck is a core rule')
})

await test('the session scope rule reaches every surface that ships the lesson', () => {
  // The runtime keeps top-level declarations, so a second declaration discards the
  // program before its first line; the rule is not a loader lesson and must survive
  // the loader-less rendering that replaces the load section.
  const text = loadBatchingGuidance()
  assert.ok(text.includes('## One session, one scope'), 'the scope section keeps its heading')
  assert.ok(text.includes('compile-time SyntaxError'), 'a redeclaration is named as fatal')
  assert.ok(text.includes('The same top-level name in a second program'), 'the table names the trap')
  assert.ok(text.includes('Re-sending a failed program with new arguments'), 'the table names the retry trap')
  // The 0.5.6 sandbox lesson owns the same slot; a later trim must not drop either.
  assert.ok(text.includes('## Sandbox permissions'), 'the sandbox lesson keeps its heading')
  const rendered = renderBatchingGuidance(text, { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.ok(rendered.includes('## One session, one scope'), 'the rule is not dropped with the load section')
  assert.ok(rendered.includes('## Sandbox permissions'), 'the sandbox tier survives beside the scope rule')
})

await test('the shipped lesson measures its declared trimmed size', () => {
  // The trim record in the PR declares this size; a wording edit must bump the
  // revision and this number together. The 84 B delivery prefix is counted separately.
  assert.equal(Buffer.byteLength(loadBatchingGuidance(), 'utf8'), 8972)
})

await test('a scope with the loader receives the shipped file unchanged', () => {
  // The default path must not pay for a branch it never needs: byte identity is the contract.
  const text = loadBatchingGuidance()
  assert.equal(renderBatchingGuidance(text, { loader: true, resident: [] }), text)
  // An unreadable file stays empty, so delivery is skipped instead of failing a tool result.
  assert.equal(renderBatchingGuidance('', { loader: false, resident: ['ops_glob'], loadable: [] }), '')
})

await test('the sandbox lesson names both legal values and the full-access prohibition', () => {
  // #963: a full-access program that invents a wider tier is rejected before it runs,
  // so the lesson must state the closed vocabulary and forbid the request at the top.
  const text = loadBatchingGuidance()
  assert.match(text, /## Sandbox permissions/, 'the shipped lesson carries the sandbox rules')
  assert.match(text, /accepts only `workspace-write` or `danger-full-access`/, 'the vocabulary is closed')
  assert.match(text, /Never invent a tier name/, 'inventing a value is called out')
  assert.match(text, /\*\*danger-full-access\*\*: the widest tier\. Never send `sandbox_permissions` or/, 'full access forbids the request')
})

await test('a reported sandbox mode keeps only its own tier', () => {
  const text = loadBatchingGuidance()
  const full = renderBatchingGuidance(text, { loader: true, resident: [], sandbox: 'danger-full-access' })
  assert.match(full, /## Sandbox permissions - current mode: danger-full-access/)
  assert.match(full, /widest tier: never send `sandbox_permissions` or/)
  assert.equal(full.includes('**read-only**'), false, 'inactive tiers are not primed')
  const readOnly = renderBatchingGuidance(text, { loader: true, resident: [], sandbox: 'read-only' })
  assert.match(readOnly, /## Sandbox permissions - current mode: read-only/)
  assert.match(readOnly, /To write, send/)
  assert.equal(readOnly.includes('**danger-full-access**'), false, 'inactive tiers are gone here too')
  const workspace = renderBatchingGuidance(text, { loader: true, resident: [], sandbox: 'workspace-write' })
  assert.match(workspace, /## Sandbox permissions - current mode: workspace-write/)
  assert.match(workspace, /leave the workspace/)
  assert.equal(workspace.includes('**read-only**'), false)
  // Substituting one section must not disturb the rest of the lesson.
  for (const rendered of [full, readOnly, workspace]) {
    assert.ok(rendered.includes('## Step 0 - the plan line'), 'the rest of the lesson survives')
    assert.ok(rendered.includes('## Common mistakes'), 'the closing table survives')
    assert.ok(rendered.includes('## Trajectory 4 - paging'), 'the trajectories survive')
  }
})

await test('a loader-less scope keeps the sandbox tier and drops the load step together', () => {
  const rendered = renderBatchingGuidance(loadBatchingGuidance(), { loader: false, resident: ['ops_glob'], loadable: [], sandbox: 'read-only' })
  assert.match(rendered, /## Sandbox permissions - current mode: read-only/)
  assert.equal(rendered.includes('ops_load_sdk'), false, 'the load step is still gone')
  assert.ok(rendered.includes('ops_glob'), 'the published surface is still listed')
})

await test('a drifted sandbox anchor inserts the tier instead of silently dropping it', () => {
  const drifted = '# Batch tool calls\n\nintro\n## Step 0 - the plan line\nbody\n'
  const out = renderBatchingGuidance(drifted, { loader: true, resident: [], sandbox: 'danger-full-access' })
  assert.match(out, /## Sandbox permissions - current mode: danger-full-access/)
  assert.ok(out.includes('## Step 0 - the plan line'), 'the following section survives')
  assert.ok(out.startsWith('# Batch tool calls'), 'the H1 stays first')
})

await test('a loader-less scope is never taught to load', () => {
  const rendered = renderBatchingGuidance(loadBatchingGuidance(), { loader: false, resident: ['ops_glob', 'ops_grep'], loadable: [] })
  // The defect this guards: the lesson named a call that cannot succeed in this scope.
  assert.equal(rendered.includes('ops_load_sdk'), false, 'the unreachable loader is gone')
  assert.equal(rendered.includes(LOAD_SECTION_HEADING), false, 'the load section is replaced')
  // The Step 1 prose taught the same entry without naming the loader tool, so its
  // wording must not survive beside a section that says there is no loader.
  assert.equal(rendered.includes('SDK loading'), false, 'the Step 1 load prose is gone')
  assert.equal(rendered.includes('separate program'), false, 'no load entry is advertised')
  assert.ok(rendered.includes('Run independent calls under Promise.all'), 'the shared split lesson survives')
  assert.ok(rendered.includes('## Step 3 - call what is published'), 'the step that remains is named')
  assert.ok(rendered.includes('ops_glob') && rendered.includes('ops_grep'), 'the resident names are listed instead')
  // Everything shared with the loader path survives verbatim: the lesson is not truncated.
  for (const kept of ['# Batch tool calls', '## Step 1 - split by dependency', '## Step 2 - reconcile', '## Common mistakes', '// plan:']) {
    assert.ok(rendered.includes(kept), kept)
  }
})

await test('a scope that publishes nothing says so', () => {
  const rendered = renderBatchingGuidance(loadBatchingGuidance(), { loader: false, resident: [] })
  assert.equal(rendered.includes('ops_load_sdk'), false)
  assert.ok(rendered.includes('publishes no OPS API and no loader'), 'the empty surface is stated')
  assert.equal(rendered.includes('## Step 3 - call what is published'), false, 'no resident list is invented')
})

await test('the replacement survives a resident list that names the loader', () => {
  // The list is generated after the filter, so the filter can never eat it.
  const rendered = renderBatchingGuidance(loadBatchingGuidance(), { loader: false, resident: ['ops_load_sdk', 'ops_glob'], loadable: [] })
  assert.ok(rendered.includes('ops_load_sdk') && rendered.includes('ops_glob'), 'the list is rendered whole')
})

await test('a drifted file keeps its structure when the anchor is gone', () => {
  const drifted = '# Batch tool calls\n\nintro\n## Step 1 - split by dependency\nbody mentions ops_load_sdk once\n'
  const out = renderBatchingGuidance(drifted, { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.ok(out.startsWith('# Batch tool calls'), 'the H1 stays first')
  assert.ok(out.indexOf('call what is published') < out.indexOf('## Step 1'), 'the step precedes the first section')
  assert.equal(out.includes('ops_load_sdk'), false, 'no unreachable mention survives')
})

await test('a renamed load section does not survive beside its replacement', () => {
  // A drifted file keeps the old lesson under a different heading; two contradicting
  // Step 3 sections would teach both loading and direct calls.
  const drifted = '# Batch tool calls\n\nintro\n## Step 3 - loading tools\nload prose here\n## Step 1 - split\nbody\n'
  const out = renderBatchingGuidance(drifted, { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.equal((out.match(/## Step 3/g) ?? []).length, 1, 'exactly one Step 3 remains')
  assert.equal(out.includes('load prose here'), false, 'the old load section is dropped')
  assert.ok(out.startsWith('# Batch tool calls'), 'the H1 stays first')
})

await test('a fenced example that teaches loading is dropped whole', () => {
  // Deleting one line inside a fence would leave a half example that calls a name the
  // scope cannot reach, so the whole block goes with it.
  const drifted = '# Batch tool calls\n\nintro\n```js\nconst sdk = await tools.ops_load_sdk({ tools: ["edit_file"] })\nawait sdk.ops_edit_file({ path: "a" })\n```\n## Step 1 - split\nbody\n'
  const out = renderBatchingGuidance(drifted, { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.equal(out.includes('sdk.ops_edit_file'), false, 'the dangling call does not survive')
  assert.equal(out.includes('ops_load_sdk'), false, 'the load call does not survive')
  assert.equal((out.match(/```/g) ?? []).length, 0, 'no half-open fence is left behind')
})

await test('only a heading that means loading loses its section', () => {
  // A substring match would swallow "Payload" and drop a valid section with it.
  const drifted = '# Batch tool calls\n## Payload budget\nkeep me\n## Step 3 - loading tools\nload prose\n'
  const out = renderBatchingGuidance(drifted, { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.ok(out.includes('## Payload budget'), 'the ordinary section survives')
  assert.ok(out.includes('keep me'), 'its body survives too')
  assert.equal(out.includes('load prose'), false, 'the load section still goes')
})

await test('a heading inside a fence is example text, not a boundary', () => {
  // The fenced line must not cut the load section short, or half of it survives.
  const drifted = '# Batch tool calls\n## Step 3 - load before you call\nprose one\n```\n## not a heading\n```\nprose two\n## Trajectory 1 - next\nbody\n'
  const out = renderBatchingGuidance(drifted, { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.equal(out.includes('prose two'), false, 'the whole section is replaced')
  assert.ok(out.includes('## Trajectory 1 - next'), 'the next real section is kept')
})

await test('a fenced copy of the heading is not the anchor', () => {
  // Taking the quoted line for the anchor would slice the document inside the fence.
  const drifted = '# Batch tool calls\n```\n## Step 3 - load before you call\n```\nreal prose\n'
  const out = renderBatchingGuidance(drifted, { loader: false, resident: ['ops_glob'], loadable: [] })
  assert.ok(out.includes('real prose'), 'the real body survives the fallback')
  assert.ok(out.startsWith('# Batch tool calls'), 'the H1 stays first')
})

await test('the shipped file still carries the anchors the renderer rewrites', () => {
  // The loader-less rendering edits prose by anchor: moving either one must fail here, not at runtime.
  const lines = loadBatchingGuidance().split('\n')
  assert.ok(lines.some(line => line.trim() === LOAD_SECTION_HEADING), 'the load heading is present')
  assert.ok(lines.some(line => line.trim() === SANDBOX_SECTION_HEADING), 'the sandbox heading is present')
  assert.ok(lines.some(line => line.startsWith(LOAD_TABLE_ROW_PREFIX)), 'the load row is present')
  // The Step 1 prose must sit on its own line, or the prose filter would cut a shared
  // line short and leave the split lesson truncated.
  assert.ok(lines.some(line => line.startsWith(LOAD_PROSE_ANCHOR)), 'the load prose is a whole line')
})

await test('a loader-less scope whose only file API is inspect states the paths it needs', () => {
  // The acceptance case: with no loader, no listing and no search, a directory cannot be
  // probed, so the lesson must say where the paths come from instead of letting the model
  // spend a round trip on a call that cannot succeed.
  const rendered = renderBatchingGuidance(loadBatchingGuidance(), { loader: false, resident: ['ops_inspect_local_file', 'ops_stat'], loadable: [] })
  assert.ok(rendered.includes('ops_inspect_local_file'), 'the resident reader is listed')
  assert.match(rendered, /rejects directories/, 'the directory rejection is stated')
  assert.match(rendered, /concrete file paths/, 'the exact-path requirement is stated')
  assert.equal(rendered.includes('ops_load_sdk'), false, 'the loader stays gone')
})

await test('the path statement stays silent while a listing or search API is published', () => {
  // A scope that can list or search discovers paths itself; the caveat would read as noise.
  const rendered = renderBatchingGuidance(loadBatchingGuidance(), { loader: false, resident: ['ops_glob', 'ops_inspect_local_file'], loadable: [] })
  assert.doesNotMatch(rendered, /rejects directories/, 'a scope that can list needs no caveat')
  assert.ok(rendered.includes('ops_glob') && rendered.includes('ops_inspect_local_file'), 'the published pair is listed')
})

report('batching-guidance')
