/** PTC declarations must follow the step admission, including loader-less scopes. */
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, test, report, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareStep, selectExecutor } from './lib/executor.mjs'
import { mountPtc } from '../lib/publication/ptc.js'
import { acquire } from '../lib/publication/registrar.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

/** The ops_ members one assembly declares in tools:sdk, sorted. */
function declared(assembly) {
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
  return [...new Set([...sdk.matchAll(/^\s{2}(ops_[a-z_]+): \{/gm)].map(match => match[1]))].sort()
}

async function setup(gate, ptc = {}, sandboxMode = 'danger-full-access') {
  // Root stays Native; each agent's scoped executor provides the PTC presentation,
  // so a test can withdraw that presentation exactly the way ptc-sdk does.
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  const agents = []
  ctx.provide('agents', { list: () => agents })
  // One mutable policy object: a test flips its mode to withdraw permission mid-scope.
  const sandbox = { mode: sandboxMode, workspaceRoot: process.cwd() }
  await ctx.plugin(inner => {
    inner.provide('ptcRuntime', { language: 'typescript' })
    inner.provide('sandboxPolicy', { resolve: () => sandbox })
    inner.provide('subprocess', { spawn() { throw new Error('declaration probe must never spawn') } })
  })
  mountPtc(ctx, { binaryPath: process.execPath, required: true, ...ptc }, { allows: () => true, ...gate })
  const agent = { id: 'surface', session: { id: 'surface', mode: sandboxMode, header: { cwd: process.cwd() }, append() {}, read() { return [] } } }
  agent.ctx = createScope(ctx, agent).ctx
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { agent.lift = selectExecutor(inner, 'ptc') } })
  agents.push(agent)
  await ctx.serial('agent/created', { agent })
  await tick(); await tick()
  return { ctx, agent, sandbox }
}

/** Flip the agent's scoped executor; the old handle is disposed first. */
async function setExecutor(agent, mode) {
  agent.lift()
  await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { agent.lift = selectExecutor(inner, mode) } })
}

/** Drive the retained loader definition the way a step call would. */
async function loadRaw(ctx, agent, raw) {
  const step = await prepareStep(ctx, agent)
  try {
    const loader = ctx.get('tools').get('ops_load_sdk', agent, step.toolSet)
    return await loader.execute({ tools: [raw] }, { agent, name: 'ops_load_sdk', toolSet: step.toolSet, signal: new AbortController().signal })
  } finally { step.dispose() }
}

/** An isolated admitted view over one definition, the way a retained step binding sees it. */
const isolated = (name, definition) => ({ view: () => new Map([[name, definition]]) })

await test('a loader-less scope declares no selectable API even without a step tool set', async () => {
  const { ctx, agent } = await setup({ resident: false, dynamic: false })
  try {
    const step = await prepareStep(ctx, agent)
    const admitted = declared(step.assembly)
    step.dispose()
    // A host assembly that omits the step tool set reads every registered definition.
    // Nothing from the allowed pool may be registered when no loader can select it.
    assert.deepEqual(declared(await ctx.get('systemPrompt').assemble({ scope: agent })), [])
    assert.deepEqual(admitted, [])
  } finally { await shutdown(ctx) }
})

/** Poll the first-round SDK declaration until publication settles. */
async function declaredNow(ctx, agent) {
  const step = await prepareStep(ctx, agent)
  try { return declared(step.assembly) } finally { step.dispose() }
}

await test('an explicit full tier declares the whole permitted pool in the first round, loader-less', async () => {
  // D1 truth-table row T (#987): the declaration half of the dual verification;
  // the run_code binding half lives in the worker-backed ptc-full-disclosure suite.
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { disclosurePolicy: 'full', allowedTools: ['grep', 'stat'] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_grep'),
      { what: 'ops_grep declared in the first round', timeoutMs: 10_000 })
    const admitted = await declaredNow(ctx, agent)
    assert.deepEqual(admitted, ['ops_grep', 'ops_inspect_local_file', 'ops_result', 'ops_stat'])
    assert.equal(admitted.includes('ops_load_sdk'), false, 'the full tier publishes no loader (#979 §2)')
    assert.equal(admitted.includes('ops_glob'), false, 'a pool-outside business API stays undeclared')
  } finally { await shutdown(ctx) }
})

await test('read-only keeps mutating APIs out of the full-tier declaration', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { disclosurePolicy: 'full', allowedTools: ['write_file', 'stat'] }, 'read-only')
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_stat'),
      { what: 'ops_stat declared under read-only', timeoutMs: 10_000 })
    assert.deepEqual(await declaredNow(ctx, agent), ['ops_inspect_local_file', 'ops_result', 'ops_stat'],
      'the mutating member of the cap is never declared')
  } finally { await shutdown(ctx) }
})

await test('an empty allowed pool declares only the resident surface plus result', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { disclosurePolicy: 'full', allowedTools: [] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_result'),
      { what: 'ops_result declared over an empty pool', timeoutMs: 10_000 })
    const admitted = await declaredNow(ctx, agent)
    assert.deepEqual(admitted, ['ops_inspect_local_file', 'ops_result'], 'nothing else to publish, and still no loader')
    assert.equal(admitted.includes('ops_load_sdk'), false)
  } finally { await shutdown(ctx) }
})

await test('duplicate allowed names register exactly once in the full tier', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { disclosurePolicy: 'full', allowedTools: ['stat', 'stat', 'grep'] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_grep'),
      { what: 'ops_grep declared', timeoutMs: 10_000 })
    const step = await prepareStep(ctx, agent)
    try {
      const registered = ctx.get('tools').definitions(agent, step.toolSet).map(tool => tool.name)
      assert.equal(registered.filter(name => name === 'ops_stat').length, 1, 'a duplicated name registers exactly once')
      assert.deepEqual(declared(step.assembly), ['ops_grep', 'ops_inspect_local_file', 'ops_result', 'ops_stat'])
    } finally { step.dispose() }
  } finally { await shutdown(ctx) }
})

await test('the same agent keeps registered, declared and admitted names distinct across the two assembly paths', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { allowedTools: ['batch'] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_load_sdk'),
      { what: 'loader declared', timeoutMs: 10_000 })
    // With a step tool set: the request path. The unloaded pool member declares nothing
    // and holds no program binding, so calling it is a JS error, never a tool error.
    assert.deepEqual(await declaredNow(ctx, agent), ['ops_inspect_local_file', 'ops_load_sdk'],
      'an unloaded name never impersonates a callable one')
    const step = await prepareStep(ctx, agent)
    try { assert.equal(step.toolSet.view(agent).has('ops_batch'), false, 'no program binding for the unloaded name') } finally { step.dispose() }
    // Without a step tool set: the diagnostics path. The same agent's registration
    // view still lists the pool member; recorded, never published as callable.
    const registered = ctx.get('tools').definitions(agent).map(tool => tool.name).filter(name => name.startsWith('ops_')).sort()
    assert.deepEqual(registered, ['ops_batch', 'ops_inspect_local_file', 'ops_load_sdk', 'ops_result'])
  } finally { await shutdown(ctx) }
})

await test('a diagnostic assembly without a tool set is not reported as a first model request', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { allowedTools: ['batch'] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_load_sdk'),
      { what: 'loader declared', timeoutMs: 10_000 })
    const receipt = await loadRaw(ctx, agent, 'batch')
    assert.equal(receipt.status, 'completed', JSON.stringify(receipt))
    // The scope's presentation flips to Native without any model step in between.
    await setExecutor(agent, 'native')
    // The no-tool-set snapshot is the diagnostics path: it marks the withdrawn
    // presentation but must not consume the pending load as a request would.
    const diagnostic = await ctx.get('systemPrompt').assemble({ scope: agent })
    assert.equal(diagnostic.sections.some(section => section.name === 'tools:ptc-only'), false,
      'the snapshot itself confirms the Native presentation')
    await setExecutor(agent, 'ptc')
    await ctx.serial('session/event', agent.session, { type: 'step/end' })
    assert.deepEqual(await declaredNow(ctx, agent), ['ops_batch', 'ops_inspect_local_file', 'ops_load_sdk'],
      'the pending load survives the diagnostic assembly')
  } finally { await shutdown(ctx) }
})

await test('calling an unloaded pool member through the dispatcher points at the loader, not at denial', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { allowedTools: ['batch'] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_load_sdk'),
      { what: 'loader declared', timeoutMs: 10_000 })
    const def = ctx.get('tools').get('ops_batch', agent)
    assert.ok(def, 'the pool member registers without a step admission')
    // Isolate the dispatch verdict: the call runs through the definition's own
    // dispatcher over an admitted view, exactly like a retained step binding.
    const verdict = await def.execute({ action: 'plan', operations: [] },
      { agent, toolSet: isolated('ops_batch', def), signal: new AbortController().signal })
    // The result-lifecycle admission classifies the raw refusal; assert the
    // four-verdict error envelope rather than its wrapper status.
    assert.equal(verdict.error.code, 'SDK_NOT_LOADED', JSON.stringify(verdict))
    assert.match(verdict.error.message, /ops_load_sdk/)
    assert.match(verdict.error.message, /batch/)
    assert.equal(verdict.error.effectState, 'none')
    assert.equal(verdict.error.retry, 'never')
  } finally { await shutdown(ctx) }
})

await test('a permission-forbidden API answers denial without a load suggestion', async () => {
  const { ctx, agent } = await setup({ resident: true, dynamic: true }, { allowedTools: ['batch', 'grep'] }, 'read-only')
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_load_sdk'),
      { what: 'loader declared under read-only', timeoutMs: 10_000 })
    const admitted = await declaredNow(ctx, agent)
    assert.equal(admitted.includes('ops_batch'), false, 'a mutating API stays undeclared under read-only')
    // Through the loader: the forbidden name is inside the configured pool, so
    // permission, not pool membership, refuses it — and no reload can change that.
    const loader = await loadRaw(ctx, agent, 'batch')
    assert.equal(loader.error.code, 'POLICY_DENIED', JSON.stringify(loader))
    assert.match(loader.error.message, /sandbox policy/)
    assert.ok(!loader.error.message.includes('ops_load_sdk'), 'a permission refusal never points at the loader')
    // A name outside the configured pool keeps the pool refusal.
    const outsider = await loadRaw(ctx, agent, 'replace')
    assert.equal(outsider.error.code, 'INVALID_ARGUMENT', JSON.stringify(outsider))
    // Through an isolated dispatch view: the same permission verdict, not a loader pointer.
    const def = ctx.get('tools').get('ops_batch', agent)
    const direct = await def.execute({ action: 'plan', operations: [] },
      { agent, toolSet: isolated('ops_batch', def), signal: new AbortController().signal })
    assert.equal(direct.error.code, 'POLICY_DENIED', JSON.stringify(direct))
    assert.match(direct.error.message, /sandbox policy/)
    assert.ok(!direct.error.message.includes('ops_load_sdk'), 'a permission refusal never suggests loading the same tool')
  } finally { await shutdown(ctx) }
})

await test('a loaded API whose admission is later withdrawn answers a revoked verdict', async () => {
  const { ctx, agent, sandbox } = await setup({ resident: true, dynamic: true }, { allowedTools: ['batch'] })
  try {
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_load_sdk'),
      { what: 'loader declared', timeoutMs: 10_000 })
    assert.equal((await loadRaw(ctx, agent, 'batch')).status, 'completed')
    await ctx.serial('session/event', agent.session, { type: 'step/end' })
    await waitFor(async () => (await declaredNow(ctx, agent)).includes('ops_batch'),
      { what: 'batch declared after loading', timeoutMs: 10_000 })
    // Retain the step that admitted the loaded API, then withdraw the permission.
    const step = await prepareStep(ctx, agent)
    try {
      sandbox.mode = 'read-only'
      const def = ctx.get('tools').get('ops_batch', agent, step.toolSet)
      const verdict = await def.execute({ action: 'plan', operations: [] },
        { agent, toolSet: step.toolSet, signal: new AbortController().signal })
      assert.equal(verdict.error.code, 'POLICY_DENIED', JSON.stringify(verdict))
      assert.match(verdict.error.message, /revoked/)
      assert.ok(!verdict.error.message.includes('ops_load_sdk'), 'a revoked admission never suggests reloading')
    } finally { step.dispose() }
    // Disposing the scope revokes the retained handle with the scope's own verdict.
    const retained = ctx.get('tools').get('ops_batch', agent)
    await ctx.serial('agent/disposed', { agent })
    const scope = await retained.execute({ action: 'plan', operations: [] },
      { agent, signal: new AbortController().signal })
    assert.equal(scope.error.code, 'POLICY_DENIED', JSON.stringify(scope))
    assert.match(scope.error.message, /revoked/)
    assert.notEqual(scope.error.message, 'This API must be admitted for the calling PTC scope; no action executed.',
      'scope withdrawal reads differently from the plain admission refusal')
  } finally { await shutdown(ctx) }
})

await test('a pulled publication grant answers revoked rather than never available', async () => {
  const { ctx } = await bootHost({ withWorkingDirectory: true })
  try {
    const agent = { id: 'revoked-grant', session: { id: 'revoked-grant' } }
    agent.ctx = createScope(ctx, agent).ctx
    const canonical = { description: 'Registrar fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [] } }
    const lease = await acquire(ctx, undefined, 'registrar_revoked', canonical)
    let calls = 0
    const dispatch = async () => { ++calls; return {} }
    // An entitled grant existed for this agent and was pulled; the replacement
    // is not entitled, so the eligible set reads empty exactly as a revocation would.
    lease.grant({ consumer: {}, agent, token: {}, entitled: true, dispatch })()
    lease.grant({ consumer: {}, agent, token: {}, entitled: false, dispatch })
    const def = ctx.get('tools').get('registrar_revoked', agent)
    assert.ok(def, 'the current generation stays registered after the rotation')
    const verdict = await def.execute({},
      { agent, toolSet: isolated('registrar_revoked', def), signal: new AbortController().signal })
    assert.equal(verdict.status, 'rejected', JSON.stringify(verdict))
    assert.equal(verdict.error.code, 'PUBLICATION_GRANT_REVOKED', JSON.stringify(verdict))
    assert.equal(verdict.error.effectState, 'none')
    assert.equal(verdict.error.retry, 'never')
    assert.equal(calls, 0, 'a revoked grant never dispatches')
    lease.dispose()
  } finally { await shutdown(ctx) }
})

report('ptc-declaration-surface')
