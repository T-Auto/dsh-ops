/** Three end-to-end scenarios: real Rust worker + real Cordis/tools/prompt;
 * simulated workspace and confinement provider, no business code in tests.
 */
import { ownWindowsFixture, skipSuite } from './lib/harness.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as ptc from '../lib/ptc/index.js'
import { definition } from '../lib/ptc/contract.js'
import { tryResolveWorker, resolveWorker } from '../lib/ptc/runtime.js'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { invoke } from '../lib/ptc/worker.js'
import { invoke as invokeFile } from '../lib/file/worker.js'
/**
 * `npm run build:ptc` builds a host binary into `native/target/release`, but a
 * `--target <triple>` build — what the release matrix and any cross-check run —
 * lands in `native/target/<triple>/release` instead. Accept either so the suite
 * tests the worker rather than the build invocation.
 */
const workerTriples = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc' }
const workerName = process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'
const workerCandidates = [
  ...(process.env.DSH_OPS_WORKER_BIN !== undefined ? [process.env.DSH_OPS_WORKER_BIN] : [
    path.resolve('native/target/release', workerName),
    ...(workerTriples[`${process.platform}-${process.arch}`] ? [path.resolve('native/target', workerTriples[`${process.platform}-${process.arch}`], 'release', workerName)] : []),
  ]),
].filter(candidate => candidate !== undefined)
const file = workerCandidates.find(candidate => fs.existsSync(candidate))
if (file === undefined) {
  // No built or staged worker at all: a suite that drives the native worker cannot
  // answer here, and upstream this failed while the module was still loading. Say so
  // as a skip (exit 77) — never as a pass — and let DSH_OPS_REQUIRE_RUNTIME=1 turn the
  // absence into a failure, the way the other worker-driven suites do. The reason comes
  // from the runtime module's own matrix rather than a second copy of it here.
  const attempt = tryResolveWorker()
  const reason = attempt.ok
    ? `no built or staged native worker for ${process.platform}-${process.arch}; run npm run build:ptc`
    : `this host cannot resolve the native worker (${attempt.reason})`
  if (process.env.DSH_OPS_REQUIRE_RUNTIME === '1') throw new Error(reason)
  skipSuite('ptc', reason)
}
assert.ok(file, `Build the independent worker with npm run build:ptc; this suite never silently skips. Looked in: ${workerCandidates.join(', ')}`)
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-ptc-')))
ownWindowsFixture(dir)
const request = (tool, args, scope = 'scenario') => {
  const result = spawnSync(file, [], { input: JSON.stringify({ root: dir, scope, tool, args }), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const write = (name, text = name) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text) }
const exists = name => fs.existsSync(path.join(dir, name))
try {
  // 1. Mixed cleanup: preserved main, junction, readonly Git file, collision,
  // observation conflict and restart/resume without repeating completed items.
  write('main/keep', 'protected'); write('review/.git/objects/ro', 'readonly');
  fs.chmodSync(path.join(dir, 'review/.git/objects/ro'), 0o444)
  fs.symlinkSync(path.join(dir, 'main'), path.join(dir, 'review/link'), process.platform === 'win32' ? 'junction' : 'dir')
  write('source/a', 'alpha'); write('source/b', 'beta')
  const run = request('batch', { action: 'run', protect: ['main'], operations: [
    { op: 'remove', path: 'review' }, { op: 'copy', path: 'source/a', to: 'copy-a' }, { op: 'move', path: 'source/b', to: 'moved-b' },
  ] })
  assert.equal(run.status, 'completed', JSON.stringify(run)); assert.equal(run.done, 3)
  assert.equal(exists('review'), false); assert.equal(exists('source/b'), false); assert.equal(exists('main/keep'), true)
  assert.equal(fs.readFileSync(path.join(dir, 'copy-a'), 'utf8'), 'alpha')
  write('source/a', 'new content')
  assert.equal(request('batch', { action: 'resume', id: run.id }).done, 3)
  assert.equal(fs.readFileSync(path.join(dir, 'copy-a'), 'utf8'), 'alpha', 'completed copy never re-executed')
  assert.equal(request('batch', { action: 'run', operations: [{ op: 'copy', path: 'source/a', to: 'copy-a' }] }).error.code, 'REVISION_CONFLICT')
  assert.equal(request('batch', { action: 'run', protect: ['main'], operations: [{ op: 'remove', path: 'main' }] }).error.code, 'PATH_RESTRICTED')
  assert.equal(request('batch', { action: 'run', operations: [{ op: 'move', path: 'source', to: 'source/nested' }] }).error.code, 'PATH_RESTRICTED')
  const plan = request('batch', { action: 'plan', operations: [{ op: 'remove', path: 'source/a' }] })
  assert.equal(request('batch', { action: 'run', id: plan.id }).error.code, 'INVALID_ARGUMENT')
  write('source/a', 'changed after observation')
  assert.equal(request('batch', { action: 'resume', id: plan.id }).failed, 1); assert.ok(exists('source/a'))
  const page = request('result', { action: 'page', id: run.id })
  assert.equal(page.items.length, 3); assert.equal(page.complete, true)
  assert.equal(page.expires, null)
  assert.equal(request('result', { action: 'release', id: run.id }).error.code, 'INVALID_ARGUMENT')
  assert.equal(request('result', { action: 'page', id: run.id }, 'foreign-session').error.code, 'POLICY_DENIED')
  // Simulate the durable write-ahead boundary left by a process crash, rather than
  // adding fault-injection switches to production code.
  const store = path.join(dir, '.dsh-ops')
  const latest = fs.readdirSync(store).filter(n => n.startsWith(`${run.id}.`) && n.endsWith('.json')).sort().at(-1)
  const manifest = JSON.parse(fs.readFileSync(path.join(store, latest), 'utf8'))
  manifest.items[0].state = 'unknown'; manifest.items[1].state = 'unknown'; write('copy-a', 'partial copy')
  const generation = Number(latest.split('.')[1])+1
  fs.writeFileSync(path.join(store, `${run.id}.${String(generation).padStart(6,'0')}.json`), JSON.stringify(manifest))
  const recovered = request('batch', { action: 'resume', id: run.id })
  assert.equal(recovered.done, 2); assert.equal(recovered.unknown, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'copy-a'), 'utf8'), 'partial copy', 'unknown mismatch is not retried')
  assert.notEqual(request('result', { action: 'page', id: run.id }).contentHash, page.contentHash, 'changed audit rows change the fingerprint')
  console.log('ok: mixed workspace preflight, no-follow, readonly cleanup and conservative recovery')

  // 2. Large result data stays local, lossless paged rows and bounded projection.
  const rows = Array.from({ length: 1000 }, (_, n) => ({ n, kind: n%2 ? 'odd' : 'even', payload: 'x'.repeat(160) }))
  const reference = request('result', { action: 'put', items: rows })
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  assert.equal(reference.contentHash, `sha256:${createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex')}`)
  assert.equal(reference.sourceTotal, rows.length)
  assert.equal(request('result', { action: 'put', items: rows }).contentHash, reference.contentHash, 'identity and expiry are not part of row content')
  const got = []; let offset = 0
  do {
    const page = request('result', { action: 'page', id: reference.id, offset, limit: 512, maxBytes: 2048 })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 2048)
    assert.equal(page.contentHash, reference.contentHash); assert.equal(page.expires, reference.expires)
    assert.equal(page.sourceTotal, rows.length)
    got.push(...page.items); offset = page.nextOffset
    if (page.complete) break
    assert.ok(page.items.length)
  } while (offset < rows.length)
  assert.deepEqual(got, rows)
  const first = request('result', { action: 'page', id: reference.id, limit: 1 })
  assert.equal(first.items[0].n, 0); assert.equal(first.nextOffset, 1)
  const last = request('result', { action: 'page', id: reference.id, offset: rows.length - 1 })
  assert.equal(last.items[0].n, 999); assert.equal(last.complete, true)
  const beyond = request('result', { action: 'page', id: reference.id, offset: rows.length + 10 })
  assert.deepEqual(beyond.items, []); assert.equal(beyond.complete, true); assert.equal(beyond.nextOffset, rows.length)
  assert.equal(request('result', { action: 'page', id: 'invalid' }).error.code, 'INVALID_ARGUMENT')
  const projected = request('result', { action: 'page', id: reference.id, equals: { kind: 'even' }, fields: ['n'], limit: 512, maxBytes: 16384 })
  assert.equal(projected.total, 500); assert.deepEqual(projected.items[1], { n: 2 })
  assert.equal(projected.sourceTotal, 1000); assert.equal(projected.contentHash, reference.contentHash)
  const empty = request('result', { action: 'page', id: reference.id, equals: { kind: 'absent' }, maxBytes: 512 })
  assert.equal(empty.complete, true); assert.equal(empty.total, 0); assert.equal(empty.sourceTotal, 1000)
  assert.ok(Buffer.byteLength(JSON.stringify(empty)) <= 512)
  assert.equal(request('result', { action: 'page', id: reference.id }, 'foreign-session').error.code, 'POLICY_DENIED')
  assert.equal(request('result', { action: 'release', id: reference.id }, 'foreign-session').error.code, 'POLICY_DENIED')
  assert.equal(request('result', { action: 'put', items: [{ huge: 'x'.repeat(2000) }] }).total, 1)
  assert.equal(request('result', { action: 'page', id: reference.id, maxBytes: 1 }).error.code, 'INVALID_ARGUMENT')
  assert.equal(request('result', { action: 'release', id: reference.id }).status, 'released')
  assert.equal(request('result', { action: 'page', id: reference.id }).error.code, 'NOT_FOUND')
  write('reference-source', 'stored operation')
  const operationRef = request('result', { action: 'put', items: [{ op: 'copy', path: 'reference-source', to: 'reference-dest' }] })
  assert.equal(request('batch', { action: 'run', operationsRef: operationRef.id }).status, 'completed')
  assert.equal(request('batch', { action: 'plan', operationsRef: operationRef.id }, 'foreign-session').error.code, 'POLICY_DENIED')
  const expired = request('result', { action: 'put', items: [{ op: 'remove', path: 'main/keep' }] })
  const expiredFile = fs.readdirSync(store).find(name => name.startsWith(expired.id) && name.endsWith('.json'))
  const expiredRecord = JSON.parse(fs.readFileSync(path.join(store, expiredFile), 'utf8'))
  expiredRecord.expires = 1
  fs.writeFileSync(path.join(store, expiredFile), JSON.stringify(expiredRecord))
  assert.equal(request('result', { action: 'page', id: expired.id }).error.code, 'REFERENCE_EXPIRED')
  assert.match(request('result', { action: 'page', id: expired.id }).error.nextAction, /Release.*new observation/)
  assert.equal(request('result', { action: 'page', id: expired.id }, 'foreign-session').error.code, 'POLICY_DENIED')
  assert.equal(request('batch', { action: 'plan', operationsRef: expired.id }).error.code, 'REFERENCE_EXPIRED')
  assert.equal(request('result', { action: 'release', id: expired.id }).status, 'released')
  assert.ok(exists('main/keep'))
  const huge = request('result', { action: 'put', items: [{ payload: 'x'.repeat(2000) }] })
  assert.equal(request('result', { action: 'page', id: huge.id, maxBytes: 512 }).error.code, 'OUTPUT_LIMIT')
  assert.equal(request('result', { action: 'page', id: huge.id, fields: ['payload'], maxBytes: 4096 }).items[0].payload.length, 2000)
  const schemaBytes = Buffer.byteLength(JSON.stringify(['batch','result'].map(n => definition(n, () => {})).map(({name,description,parameters}) => ({name,description,parameters}))))
  console.log(`ok: 1000-row round trip and byte-bounded projection; schemas=${schemaBytes} bytes, summary=${Buffer.byteLength(JSON.stringify(run))} bytes vs audit=${Buffer.byteLength(JSON.stringify(page))} bytes`)
  // Driving PTC on macOS exposed two facts the schema text must not omit: a
  // relative root is rejected at preflight, and paging a detailsRef needs the
  // batch's root. Assert the wording so it cannot silently regress.
  const batchText = definition('batch', () => ({})).description
  const resultText = definition('result', () => ({})).description
  assert.match(batchText, /absolute path/)
  assert.match(batchText, /INVALID_ARGUMENT/)
  assert.match(resultText, /NOT_FOUND/)

  // Host-resolved absolute paths, spelled the way the caller sees them. On macOS
  // `os.tmpdir()` sits under `/var`, a symlink to `/private/var`, so an absolute
  // path handed straight through carries an alias in its directory chain; the
  // worker opens every component with no-follow and refuses such a path before
  // doing any work. `lib/file/worker.js` resolves the parent chain, so a request
  // must succeed from the caller's spelling while a link the caller *names* stays
  // refused. It has to go through the host bridge: at the worker level the alias
  // reaches the no-follow walk and is refused either way.
  const bridge = new Context(); bridge.logger.level = 0
  await bridge.plugin(Subprocess)
  await bridge.plugin(inner => { inner.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: dir, sessionId: 'alias' }) }) })
  try {
    const aliasRoot = fs.realpathSync.native(dir) !== dir
    const aliasSession = { id: 'alias', mode: 'read-only', header: { cwd: dir } }
    const fileCall = (tool, args) => invokeFile(bridge, file, tool, args,
      { agent: { session: aliasSession } }, new AbortController().signal)
    const observed = await fileCall('inspect_local_file', { path: path.join(dir, 'main/keep') })
    assert.equal(observed.status, 'completed', JSON.stringify(observed))
    assert.equal(observed.items[0]?.text, 'protected', JSON.stringify(observed))
    fs.symlinkSync(path.join(dir, 'main'), path.join(dir, 'named-link'), process.platform === 'win32' ? 'junction' : 'dir')
    const linked = await fileCall('inspect_local_file', { path: path.join(dir, 'named-link') })
    assert.equal(linked.error?.code, 'PATH_RESTRICTED', JSON.stringify(linked))
    console.log(`ok: host-bridge absolute paths work${aliasRoot ? ' through the /var -> /private/var alias' : ''}; a named link stays POLICY_DENIED`)
  } finally { await bridge.fiber.dispose() }

  // 3. Actual host registration scopes and presentation with a simulated enforcing
  // provider; subprocess still starts the real worker. Never claim this is an OS sandbox test.
  const ctx = new Context(); ctx.logger.level = 0
  const calls = []; const handles = new Set()
  const subprocess = { spawn(spec) {
    calls.push(spec)
    let out = '', err = ''
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: 'pipe' }); handles.add(child)
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b)
    child.stdin.end(spec.stdio.stdin.data)
    const abort = () => child.kill(); spec.signal?.addEventListener('abort', abort, { once: true })
    return { collected: { stdout: { readFrom: () => ({text:out,lossy:false}) }, stderr: { readFrom: () => ({text:err,lossy:false}) } },
      done: new Promise((resolve,reject) => { child.on('error',reject); child.on('close',(exitCode,signal) => {
        handles.delete(child); spec.signal?.removeEventListener('abort',abort); resolve({exitCode,signal})
      }) }) }
  } }
  try {
    await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolRuntime, { mode: 'native' })
    let sandboxAvailable = true
    await ctx.plugin(inner => {
      inner.provide('ptcRuntime', { language: 'typescript' })
      inner.provide('subprocess', subprocess)
      inner.provide('sandboxPolicy', { resolve: ({session}) => ({ mode: session.mode, workspaceRoot: dir, sessionId: session.id }) })
      inner.provide('sandbox', { async confine(argv, policy) {
        assert.equal(policy.mode, 'workspace-write')
        if (!sandboxAvailable) throw Object.assign(new Error('fixture backend unavailable'), { code: 'SANDBOX_UNAVAILABLE' })
        return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
      } })
    })
    const component = await ctx.plugin(ptc, { binaryPath: file, required: true, alwaysLoaded: ['batch'] })
    const makeAgent = async (id, presentation, parent) => {
      const agent = { id, session: { id, mode: 'workspace-write', header: { cwd: dir } } }
      const scope = createScope(parent?.ctx ?? ctx, agent); agent.ctx = scope.ctx
      if (presentation) await agent.ctx.plugin({ inject: ['tools','systemPrompt'], apply(inner) { agent.liftPresentation = inner.tools.presentAs(presentation) } })
      await ctx.serial('agent/created', {agent}); return agent
    }
    const pure = await makeAgent('pure','ptc'), native = await makeAgent('native','native',pure), both = await makeAgent('both','both')
    const nativeParent = await makeAgent('native-parent', 'native')
    const ptcChild = await makeAgent('ptc-child', 'ptc', nativeParent)
    const visible = agent => ctx.get('tools').schemas(agent).map(s => s.name)
    const until = async predicate => {
      const deadline = Date.now()+5000
      while (!predicate()) { if (Date.now()>deadline) throw new Error('host reconciliation timeout'); await new Promise(r => setTimeout(r, 10)) }
    }
    await until(() => visible(pure).includes('ops_batch'))
    await until(() => !visible(native).includes('ops_batch'))
    assert.equal(visible(both).includes('ops_result'), false)
    await until(() => visible(ptcChild).includes('ops_result'))
    assert.equal(visible(nativeParent).includes('ops_result'), false)
    assert.equal(ctx.get('tools').schemas().length, 0)
    const assembled = await ctx.get('systemPrompt').assemble({scope:pure})
    assert.deepEqual(assembled.tools.map(t => t.name), ['run_code'])
    assert.ok(assembled.sections.some(s => s.text.includes('ops_batch')))
    assert.ok(assembled.sections.some(s => s.name === 'dsh-ops:repository-tooling:ptc' && s.text.includes('typed Outcome')))
    assert.equal((await ctx.get('systemPrompt').assemble({scope:native})).sections.some(s => s.text.includes('ops_batch')), false)
    const def = ctx.get('tools').get('ops_batch', pure)
    const wrongOwner = await def.execute({ action: 'plan', operations: [] }, { agent: ptcChild, signal: new AbortController().signal })
    assert.equal(wrongOwner.error.code, 'POLICY_DENIED')
    write('host-copy', 'host data')
    const result = await ctx.get('tools').get('ops_batch', pure).execute({ action:'run',operations:[{op:'copy',path:'host-copy',to:'host-dest'}] }, {agent:pure,signal:new AbortController().signal})
    assert.equal(result.status,'completed',JSON.stringify(result)); assert.equal(result.data.sandbox.enforcement,'full')
    const hostJobs = new Map(); let jobNumber = 0
    await ctx.plugin(inner => inner.provide('jobs', {
      start(spec) {
        assert.equal(spec.owner, 'pure'); const id = `ops-${++jobNumber}`
        const hooks = spec.run({ updateProgress: line => assert.equal(typeof line, 'string') }); hostJobs.set(id, hooks); return id
      },
      async wait(id) { await hostJobs.get(id).done },
      remove(id) { hostJobs.delete(id) },
    }))
    const before = calls.length
    pure.session.mode = 'read-only'
    const readonly = await def.execute({action:'run',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure,signal:new AbortController().signal})
    assert.equal(readonly.error.code,'POLICY_DENIED')
    assert.equal(readonly.data.error.permission.current, 'read-only'); assert.match(readonly.error.nextAction, /Do not retry/)
    pure.session.mode = 'workspace-write'; sandboxAvailable = false
    assert.equal((await def.execute({action:'run',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure,signal:new AbortController().signal})).error.code,'EXECUTOR_UNAVAILABLE')
    assert.equal(calls.length,before); assert.equal(hostJobs.size,0)
    const fakeOutcome = (outcome, stderr = '', lossy = false) => ({ get(name) {
      if (name === 'subprocess') return { spawn() { return { done: Promise.resolve(outcome),
        collected: { stdout: { readFrom: () => ({ text: '{}', lossy }) }, stderr: { readFrom: () => ({ text: stderr }) } } } } }
      if (name === 'sandbox') return { confine: async argv => ({ argv, enforcement: 'full', denialSignatures: ['fixture access denied'],
        runnerFailureRules: [{ fatalSignatures: ['fixture runner failed'], allowedExitCodes: [9] }] }) }
      return ctx.get(name)
    } })
    const fixtureCall = fixture => invoke(fixture, file, 'batch', { action: 'run', operations: [{ op: 'remove', path: 'host-dest' }] }, { agent: pure }, new AbortController().signal)
    const runnerError = await fixtureCall(fakeOutcome({ exitCode: 9 }, 'fixture runner failed'))
    assert.equal(runnerError.error.code, 'EXECUTOR_UNAVAILABLE'); assert.equal(runnerError.error.effectState, 'none')
    const osDenied = await fixtureCall(fakeOutcome({ exitCode: 1 }, 'fixture access denied'))
    assert.equal(osDenied.error.code, 'EXECUTION_RESTRICTED'); assert.equal(osDenied.error.effectState, 'unknown')
    assert.equal(osDenied.error.permission, undefined); assert.match(osDenied.error.nextAction, /Do not blindly retry/)
    const lost = await fixtureCall(fakeOutcome({ exitCode: 0 }, '', true))
    assert.equal(lost.error.code, 'OUTPUT_LIMIT'); assert.equal(lost.error.effectState, 'unknown'); assert.match(lost.detailsRef, /^j-/)
    const changingPolicy = { get(name) {
      if (name === 'sandbox') return { confine: async argv => { pure.session.mode = 'read-only'; return { argv, enforcement: 'full' } } }
      return ctx.get(name)
    } }
    const authorityChanged = await fixtureCall(changingPolicy)
    assert.equal(authorityChanged.error.code, 'POLICY_DENIED'); assert.equal(authorityChanged.error.effectState, 'none')
    assert.equal(authorityChanged.error.permission.current, 'read-only'); assert.equal(calls.length, before)
    pure.session.mode = 'workspace-write'
    let pageSpawns = 0, snapshots = 0
    const changedPageAuthority = { get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: ++snapshots === 1 ? 'workspace-write' : 'read-only', workspaceRoot: dir }) }
      if (name === 'sandbox') return { confine: async argv => ({ argv, enforcement: 'full' }) }
      if (name === 'subprocess') return { spawn() { pageSpawns++; throw new Error('changed page must not spawn') } }
      return ctx.get(name)
    } }
    const changedPage = await invoke(changedPageAuthority, file, 'result', { action: 'page', id: reference.id }, { agent: pure }, new AbortController().signal)
    assert.equal(changedPage.error.code, 'AUTHORITY_CHANGED')
    assert.equal(changedPage.error.effectState, 'none'); assert.equal(changedPage.error.permission, undefined)
    assert.equal(pageSpawns, 0)
    sandboxAvailable = true
    const hostDestKept = exists('host-dest'); assert.equal(hostDestKept,true)
    const partialSandboxCtx = { get(name) {
      if (name === 'sandbox') return {confine:async argv=>({argv,enforcement:'partial'})}
      return ctx.get(name)
    } }
    const partial = await invoke(partialSandboxCtx,file,'batch',{action:'plan',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure},new AbortController().signal)
    assert.equal(partial.status,'planned'); assert.equal(partial.sandbox.enforcement,'partial')
    const monitored = await def.execute({action:'plan',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure,signal:new AbortController().signal})
    assert.equal(monitored.status,'completed'); assert.equal(monitored.data.status,'planned'); assert.equal(hostJobs.size,0); assert.ok(jobNumber >= 1)
    const aborted = new AbortController(); aborted.abort()
    const cancelled = await invoke(ctx,file,'batch',{action:'run',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure},aborted.signal)
    assert.equal(cancelled.error.effectState,'none'); assert.equal(cancelled.error.code,'CANCELLED')
    assert.equal(calls.length, before+2)
    const abortDuringWork = new AbortController()
    let enteredWorker
    const workerStarted = new Promise(resolve => { enteredWorker = resolve })
    const interruptedCtx = { get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({mode:'danger-full-access',workspaceRoot:dir}) }
      if (name === 'subprocess') return { spawn() {
        enteredWorker()
        return { collected: { stdout: {readFrom:()=>({text:'',lossy:false})},stderr:{readFrom:()=>({text:'',lossy:false})} },
          done: new Promise(resolve => abortDuringWork.signal.addEventListener('abort', () => resolve({exitCode:null,signal:'SIGTERM'}), {once:true})) }
      } }
    } }
    const interruption = invoke(interruptedCtx,file,'batch',{action:'run',operations:[{op:'remove',path:'host-dest'}]}, {agent:pure},abortDuringWork.signal)
    await workerStarted
    abortDuringWork.abort()
    const unsettled = await interruption
    assert.equal(unsettled.error.code,'RESULT_UNKNOWN'); assert.match(unsettled.detailsRef,/^j-/)
    assert.ok(exists('host-dest')); assert.equal(hostJobs.size,0)
    const removedDefinition = ctx.get('tools').get('ops_result', ptcChild)
    let releaseAssembly, enteredAssembly
    const blocked = new Promise(resolve => { enteredAssembly = resolve })
    let blockOnce = true
    const removeSection = ctx.get('systemPrompt').section({ name: 'ptc-race-fixture', order: 100, interpolate: false,
      async text() {
        if (!blockOnce) return ''
        blockOnce = false; enteredAssembly()
        await new Promise(resolve => { releaseAssembly = resolve })
        return ''
      } })
    const race = removedDefinition.execute({ action: 'page', id: result.data.detailsRef }, { agent: ptcChild, signal: new AbortController().signal })
    await blocked
    const callsBeforeRace = calls.length
    ptcChild.liftPresentation()
    releaseAssembly()
    assert.equal((await race).error.code, 'POLICY_DENIED')
    assert.equal(calls.length, callsBeforeRace, 'presentation changes during assembly must not spawn a worker')
    removeSection()
    await ctx.get('systemPrompt').assemble({ scope: ptcChild });
    assert.equal(visible(ptcChild).includes('ops_result'), false, 'presentation withdrawal precedes returned Native assembly')
    assert.equal((await removedDefinition.execute({ action: 'page', id: result.data.detailsRef }, { agent: ptcChild, signal: new AbortController().signal })).error.code, 'POLICY_DENIED')
    await ctx.serial('agent/disposed', { agent: ptcChild })
    assert.equal(visible(ptcChild).includes('ops_result'), false)
    assert.equal((await removedDefinition.execute({ action: 'page', id: result.data.detailsRef }, { agent: ptcChild, signal: new AbortController().signal })).error.code, 'POLICY_DENIED')
    // Unload rejects retained callbacks and cleans owned registrations, not foreign tools.
    await until(() => visible(pure).includes('ops_batch'))
    const schemaBefore = JSON.stringify(ctx.get('tools').schemas(pure))
    ctx.get('tools').register({name:'foreign',description:'fixture',parameters:{type:'object'},output:{schema:{type:'object'},render:()=>[]},execute:()=>({})})
    await until(() => visible(pure).includes('ops_batch'))
    assert.equal(JSON.stringify(ctx.get('tools').schemas(pure).filter(s=>s.name.startsWith('ops_'))),
      JSON.stringify(JSON.parse(schemaBefore).filter(s=>s.name.startsWith('ops_'))))
    await component.dispose()
    assert.equal(visible(pure).includes('ops_batch'),false); assert.equal(visible(native).includes('ops_result'),false)
    assert.equal((await def.execute({}, {agent:pure,signal:new AbortController().signal})).error.code,'POLICY_DENIED')
    assert.ok(ctx.get('tools').get('foreign')); assert.equal(Object.hasOwn(ctx.get('tools'),'register'),false)
    console.log('ok: real DSH scopes/SDK, native+hybrid isolation, fail-closed authority and unload')
  } finally { for (const child of handles) child.kill(); await ctx.fiber.dispose() }

  // Native sandbox acceptance: original DSH providers, not mocks. No changes to
  // a user's workspace permissions; only the provider-owned temporary fixture.
  // Installed-package resolution is tested without source/build fallback.
  const isolatedPackage = path.join(dir,'runtime-package')
  fs.mkdirSync(isolatedPackage)
  fs.copyFileSync('package.json',path.join(isolatedPackage,'package.json'))
  const runtimeDir = path.resolve('runtime',`${process.platform}-${process.arch}`)
  fs.cpSync(runtimeDir,path.join(isolatedPackage,'runtime',`${process.platform}-${process.arch}`),{recursive:true})
  assert.throws(() => resolveWorker({}, {platform:'linux',arch:'arm64'}), /unsupported runtime target/)
  assert.throws(() => resolveWorker({}, {platform:'win32',arch:'arm64'}), /unsupported runtime target/)
  assert.throws(() => resolveWorker({}, {platform:'darwin',arch:'riscv64'}), /unsupported runtime target/)
  assert.ok(resolveWorker({}, {packageRoot:isolatedPackage}).startsWith(isolatedPackage))
  console.log('ok: installed runtime resolves without binaryPath or source build tree')
  const real = new Context(); real.logger.level = 0
  // The local sandbox grants the platform temporary area on Linux, so the
  // outside-workspace fixture must sit outside that area as well as the root.
  const outside = process.platform === 'win32'
    ? fs.mkdtempSync(path.join(os.tmpdir(),'ops-outside-'))
    : fs.mkdtempSync(path.join(path.resolve('.'),'.tmp-outside-'))
  const external = path.join(outside,'protected.txt'); fs.writeFileSync(external,'keep')
  // A second root that is outside the workspace AND outside the DSH temporary
  // areas. `workspace-write` grants `/tmp` and `os.tmpdir()` on purpose, so a
  // temp sibling is authorized by the policy rather than caught by it.
  const nonTemp = fs.mkdtempSync(path.join(os.homedir(),'ops-outside-'))
  const externalNonTemp = path.join(nonTemp,'protected.txt'); fs.writeFileSync(externalNonTemp,'keep')
  try {
    await real.plugin(SystemPrompt, {}); await real.plugin(ToolRuntime, { mode: 'native' })
    await real.plugin(Subprocess)
    await real.plugin(Sandbox, {})
    await real.plugin(FileSystem, {})
    const agent = { id: 'real-ptc', session: {id:'real-ptc',mode:'workspace-write',header:{cwd:dir},append(){return Promise.resolve()},read(){return []}} }
    agent.ctx = createScope(real, agent).ctx
    await real.plugin(inner => { inner.provide('sandboxPolicy',{resolve:({session} = {})=>({mode:session?.mode ?? agent.session.mode,workspaceRoot:dir,sessionId:session?.id ?? agent.session.id})}) })
    write('real-source','native')
    await real.plugin(NodePtc, {})
    await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
    const sdkComponent = await real.plugin(ptc, { binaryPath: file, required: true, alwaysLoaded: ['batch'] })
    await real.serial('agent/created', { agent })
    for (let n = 0; n < 100 && !real.get('tools').get('ops_result', agent); n++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(real.get('tools').get('ops_result', agent), JSON.stringify(await real.get('systemPrompt').assemble({ scope: agent })))
    const sdk = async code => {
      const completion = await real.get('tools').execute({ name: 'run_code', callId: 'ptc-result-sdk', agent,
        signal: new AbortController().signal, arguments: { description: 'Verify bounded PTC-native dataflow', code } })
      assert.notEqual(completion.isError, true, JSON.stringify(completion))
      assert.equal(completion.value.sandbox.mode, agent.session.mode, JSON.stringify(completion))
      return completion.value.result
    }
    const sdkResult = await sdk(`
      const storedOutcome = await tools.ops_result({action:'put',items:Array.from({length:120},(_,n)=>({n,kind:n%2?'odd':'even',payload:'x'.repeat(80)}))});
      if (storedOutcome.status !== 'completed') return storedOutcome; const stored = storedOutcome.data;
      const selected = []; let offset = 0; let stable = true; let bounded = true; let contentHash;
      while (true) {
        const pageOutcome = await tools.ops_result({action:'page',id:stored.id,equals:{kind:'even'},fields:['n'],offset,limit:7,maxBytes:2048});
        if (pageOutcome.error) return pageOutcome; const page = pageOutcome.data;
        contentHash ??= page.contentHash;
        stable = stable && page.contentHash === contentHash && page.sourceTotal === 120 && page.total === 60 && stored.reference.totalItems === 120;
        bounded = bounded && JSON.stringify(page).length <= 2048;
        selected.push(...page.items.map(row=>row.n));
        if (page.complete) break;
        if (page.nextOffset <= offset) return {error:'pagination did not advance'};
        offset = page.nextOffset;
      }
      const invalid = await tools.ops_batch({action:'resume',id:'not-an-id'});
      const denied = await tools.ops_batch({action:'plan',root:${JSON.stringify(nonTemp)},operations:[{op:'remove',path:'protected.txt'}]});
      const planOutcome = await tools.ops_batch({action:'plan',operations:[{op:'copy',path:'real-source',to:'sdk-copy'}]});
      if (planOutcome.status !== 'completed') return planOutcome; const plan = planOutcome.data;
      const audit = await tools.ops_result({action:'page',id:plan.detailsRef,fields:['state','revision','entries']});
      const resumed = await tools.ops_batch({action:'resume',id:plan.id});
      const replay = await tools.ops_batch({action:'resume',id:plan.id});
      await tools.ops_result({action:'release',id:stored.id});
      return {stable,bounded,count:selected.length,last:selected[selected.length-1],invalid:invalid.error.code,denied:denied.data.error,
        audit:audit.data.items[0],resumed:resumed.status,replay:replay.data.done,detailsRef:plan.detailsRef};
    `)
    assert.equal(sdkResult.stable, true, JSON.stringify(sdkResult)); assert.equal(sdkResult.bounded, true)
    assert.equal(sdkResult.count, 60); assert.equal(sdkResult.last, 118)
    assert.equal(sdkResult.invalid, 'INVALID_ARGUMENT'); assert.equal(sdkResult.audit.state, 'pending')
    assert.equal(sdkResult.denied.code, 'POLICY_DENIED'); assert.equal(sdkResult.denied.permission.current, 'workspace-write')
    assert.equal(fs.readFileSync(externalNonTemp, 'utf8'), 'keep')
    assert.match(sdkResult.audit.revision, /^[a-f0-9]{64}$/)
    assert.equal(sdkResult.resumed, 'completed'); assert.equal(sdkResult.replay, 1)
    agent.session.mode = 'read-only'
    const sdkReadonly = await sdk(`
      const denied = await tools.ops_result({action:'put',items:[{n:1}]});
      const page = await tools.ops_result({action:'page',id:${JSON.stringify(sdkResult.detailsRef)},fields:['state'],maxBytes:512});
      return {denied,page};
    `)
    assert.equal(sdkReadonly.denied.error.code, 'POLICY_DENIED')
    assert.equal(sdkReadonly.denied.data.error.permission.current, 'read-only')
    assert.equal(sdkReadonly.page.data.items[0].state, 'completed')
    agent.session.mode = 'workspace-write'
    await sdkComponent.dispose()
    assert.equal(real.get('tools').schemas(agent).some(schema => schema.name.startsWith('ops_')), false)
    const call = (tool,args) => invoke(real,file,tool,args,{agent},new AbortController().signal)
    const copied = await call('batch',{action:'run',operations:[{op:'copy',path:'real-source',to:'real-copy'}]})
    assert.equal(copied.status,'completed',JSON.stringify(copied))
    agent.session.mode='read-only'
    const beforeStore = fs.readdirSync(path.join(dir,'.dsh-ops')).sort()
    const readonlyPage = await call('result',{action:'page',id:copied.detailsRef})
    assert.equal(readonlyPage.items[0].state,'completed',JSON.stringify(readonlyPage))
    assert.deepEqual(fs.readdirSync(path.join(dir,'.dsh-ops')).sort(),beforeStore)
    agent.session.mode='workspace-write'
    const denied=await call('batch',{root:outside,action:'run',operations:[{op:'remove',path:'protected.txt'}]})
    assert.equal(denied.status === 'error' || denied.status === 'rejected',true,JSON.stringify(denied))
    assert.equal(denied.error?.code ?? denied.permission?.code,'POLICY_DENIED',JSON.stringify(denied))
    assert.ok(fs.existsSync(external))
    agent.session.mode='danger-full-access'
    const unrestricted=await call('batch',{root:outside,action:'run',operations:[{op:'remove',path:'protected.txt'}]})
    assert.equal(unrestricted.status,'completed',JSON.stringify(unrestricted)); assert.equal(fs.existsSync(external),false)
    assert.equal(unrestricted.sandbox.enforcement,undefined)
    assert.equal(path.basename(resolveWorker({}, {packageRoot:path.resolve('.')})), path.basename(file))
    assert.throws(() => resolveWorker({binaryPath:path.join(dir,'missing-worker.exe')}), /unavailable/)
    const staged = path.join(dir,'installed-package'); fs.mkdirSync(staged)
    fs.copyFileSync('package.json',path.join(staged,'package.json'))
    const runtime = path.dirname(resolveWorker({}, {packageRoot:path.resolve('.')}))
    fs.cpSync(runtime,path.join(staged,'runtime',`${process.platform}-${process.arch}`),{recursive:true})
    assert.ok(resolveWorker({}, {packageRoot:staged}).startsWith(staged))

    // L12: a worker that exists but cannot be executed is refused here, by name and
    // mode, instead of being accepted and failing later as a bare EACCES from spawn.
    // POSIX-only: Windows has no execute bit.
    if (process.platform !== 'win32') {
      const flat = path.join(dir,'flat-worker')
      const flatTarget = path.join(flat,'runtime',`${process.platform}-${process.arch}`)
      fs.mkdirSync(flatTarget,{recursive:true})
      fs.copyFileSync('package.json',path.join(flat,'package.json'))
      fs.copyFileSync(path.join(runtime,path.basename(file)),path.join(flatTarget,path.basename(file)))
      fs.copyFileSync(path.join(runtime,'provenance.json'),path.join(flatTarget,'provenance.json'))
      fs.chmodSync(path.join(flatTarget,path.basename(file)),0o644)
      assert.throws(() => resolveWorker({}, {packageRoot:flat}), /not executable \(mode 0644\)/)
    }

    // A missing receipt must be named as an incomplete stage, not leak a raw ENOENT
    // from inside readFileSync.
    const noReceipt = path.join(dir,'no-receipt')
    const noReceiptTarget = path.join(noReceipt,'runtime',`${process.platform}-${process.arch}`)
    fs.mkdirSync(noReceiptTarget,{recursive:true})
    fs.copyFileSync('package.json',path.join(noReceipt,'package.json'))
    fs.copyFileSync(path.join(runtime,path.basename(file)),path.join(noReceiptTarget,path.basename(file)))
    fs.chmodSync(path.join(noReceiptTarget,path.basename(file)),0o755)
    // The receipt error names the artifact *inside the package* and reports only the error code:
    // it must stay actionable without disclosing the operator's install path (#30).
    assert.throws(() => resolveWorker({}, {packageRoot:noReceipt}), error => {
      assert.match(error.message, /provenance receipt at runtime\/[^/]+\/provenance\.json could not be read \(ENOENT\)/)
      assert.ok(!error.message.includes(noReceipt), `the message leaked the install path: ${error.message}`)
      return true
    })

    // An unavailable runtime must say what was tried, so it is debuggable without
    // reading the resolver.
    assert.throws(() => resolveWorker({}, {packageRoot:path.join(dir,'nothing-here')}), /unavailable[\s\S]*runtime[\s\S]*native[\s\S]*build:ptc/)
    console.log('ok: original DSH native sandbox, readonly pages, outside-root denial and full-access outside-root execution')
  } finally { await real.fiber.dispose(); fs.rmSync(outside,{recursive:true,force:true}); fs.rmSync(nonTemp,{recursive:true,force:true}) }
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
