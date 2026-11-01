#!/usr/bin/env node
/** Explicit real Windows/WSL acceptance. Requires both branch-built packaged workers; never skips. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
if (process.platform !== 'win32') throw new Error('Run this acceptance check on Windows with an installed Linux x64 WSL distribution')
const distro = process.argv[2] ?? 'Ubuntu'
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(distro)) throw new Error('Unsupported fixture distribution name')
const local = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dsh-ops-wsl-accept-'))
process.env.DSH_HOME = local
delete process.env.DSH_OPS_WORKER_BIN
const prefix = ['--distribution', distro, '--exec']
const wsl = args => execFileSync(path.join(process.env.SystemRoot, 'System32', 'wsl.exe'), [...prefix, ...args], { encoding: 'utf8', timeout: 30000 }).trim()
const setup = `import pathlib,tempfile,json
r=pathlib.Path(tempfile.mkdtemp(prefix="dsh-ops-wsl-accept-",dir="/var/tmp"))
(r/"scan").mkdir()
for n in range(500): (r/"scan"/f"file{n:04}.txt").write_text(f"needle {n}\\n",encoding="utf-8")
(r/"small.txt").write_text("literal /var/tmp/source text\\nsecond\\n",encoding="utf-8")
(r/"large.txt").write_text("x"*300000+"\\n",encoding="utf-8")
(r/"link").symlink_to(r/"small.txt")
(r/"Private").mkdir(); (r/"Private"/"token.txt").write_text("fixture-private")
(r/"reserved").mkdir(); (r/"reserved"/"NUL.txt").write_text("must be excluded")
print(str(r))`
const fixture = wsl(['/usr/bin/python3', '-c', setup])
assert.match(fixture, /^\/var\/tmp\/dsh-ops-wsl-accept-[A-Za-z0-9_-]+$/)
fs.writeFileSync(path.join(local, 'wsl-fixture.json'), JSON.stringify({ distro, fixture }))
const unc = `\\\\wsl.localhost\\${distro}${fixture.replaceAll('/', '\\')}`
const { bootHost, shutdown } = await import('../test/lib/host.mjs')
const { default: Subprocess } = await import('@deepseek-ai/dsh-subprocess-local')
const { default: FileSystem } = await import('@deepseek-ai/dsh-fs-local')
const { default: Sandbox } = await import('@deepseek-ai/dsh-sandbox-local')
const { invoke } = await import('../lib/execution/files.js')
const { resolveWorker } = await import('../lib/execution/runtime.js')
const { wslPath } = await import('../lib/execution/wsl-paths.js')
const { definition } = await import('../lib/file/contract.js')
const { expireResultSession } = await import('../lib/kernel/result-lifecycle.js')
const { ctx } = await bootHost(), file = resolveWorker()
let mode = 'workspace-write', hook = () => {}, afterWorker = false, afterWorkerRevoke = false
const session = { id: 'wsl-acceptance', header: { cwd: unc }, append() {}, read() { return [] } }, exec = { agent: { session } }
const seen = [], observed = []
let checks = 0
const check = async (label, action) => { const start = Date.now(); await action(); checks++; console.log(`PASS ${label} (${Date.now() - start}ms)`) }
try {
  await ctx.plugin(Subprocess); await ctx.plugin(FileSystem); await ctx.plugin(Sandbox)
  await ctx.plugin({ inject: ['tools'], apply(inner) {
    inner.provide('sandboxPolicy', { resolve: () => {
      const value = { mode, workspaceRoot: local, sessionId: session.id }
      if (afterWorker && afterWorkerRevoke) { afterWorkerRevoke = false; queueMicrotask(() => { mode = 'read-only' }) }
      return value
    } })
    inner.tools.register(definition('read_files', async () => ({})))
  } })
  ctx.on('fs/observed', (target, observation) => observed.push({ target, observation }))
  const processes = ctx.get('subprocess'), spawn = processes.spawn.bind(processes)
  processes.spawn = spec => {
    const envelope = spec.stdio?.stdin?.data?.startsWith('{') ? JSON.parse(spec.stdio.stdin.data) : undefined
    const entry = { argv: spec.argv, envelope }; seen.push(entry); hook(entry, spec)
    const handle = spawn(spec)
    if (envelope?.request.windows_paths) handle.done.then(() => { afterWorker = true })
    return handle
  }
  const call = (tool, args, signal, config) => invoke(ctx, file, tool, args, exec, signal, config)
  const scan = { path: 'scan', pattern: ['**/*.txt'], limit: 5 }
  await check('opt-in off preserves the Windows backend', async () => {
    delete process.env.DSH_OPS_WSL_READS; seen.length = 0
    const value = await call('read_files', { files: [{ path: 'small.txt' }] })
    assert.equal(value.status, 'completed'); assert.equal(seen.filter(item => item.envelope).length, 1)
    assert.equal(seen.some(item => item.argv.includes('--distribution')), false)
  })
  process.env.DSH_OPS_WSL_READS = '1'
  let first
  await check('exact WSL scan and opaque continuation preserve UNC paths', async () => {
    seen.length = 0; first = await call('glob', scan)
    assert.equal(first.matchedTotal, 500, JSON.stringify(first)); assert.equal(first.items.length, 5)
    assert.match(first.continuation, /^w1:/); assert.ok(first.items.every(item => item.startsWith(unc)))
    const delegated = seen.find(item => item.envelope?.request.windows_paths).envelope
    assert.equal(Object.hasOwn(delegated, 'storage'), false)
    const second = await call('glob', { ...scan, continuation: first.continuation })
    assert.equal(second.matchedTotal, 500); assert.equal(second.items.length, 5)
    assert.equal(second.items.some(item => first.items.includes(item)), false)
  })
  await check('both UNC aliases and unchanged inner native snapshot validation', async () => {
    session.header.cwd = unc.replace('wsl.localhost', 'wsl$')
    const next = await call('glob', { ...scan, continuation: first.continuation })
    assert.equal(next.items.length, 5, JSON.stringify(next))
    session.header.cwd = unc
    fs.writeFileSync(path.join(unc, 'scan', 'changed.txt'), 'needle changed\n')
    assert.equal((await call('glob', { ...scan, continuation: first.continuation })).error.code, 'SEARCH_STALE')
  })
  await check('real Windows Node PTC file bindings consume the same WSL cursor and read contract', async () => {
    const { default: NodePtc } = await import('@deepseek-ai/dsh-ptc-runtime-node')
    const { createScope } = await import('@deepseek-ai/dsh-scope')
    const { mountPtc } = await import('../lib/publication/ptc.js')
    exec.agent.id = 'wsl-acceptance-agent'; exec.agent.ctx = createScope(ctx, exec.agent).ctx
    ctx.provide('agents', { list: () => [exec.agent] })
    await exec.agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
    await ctx.plugin(NodePtc)
    await ctx.plugin({ apply(inner) { mountPtc(inner, { required: true, allowedTools: ['glob', 'read_files'], alwaysLoaded: ['glob', 'read_files'] }, { allows: () => true }) } })
    await ctx.serial('agent/created', { agent: exec.agent })
    await ctx.get('systemPrompt').assemble({ scope: exec.agent })
    const fresh = await call('glob', scan)
    const result = await ctx.get('tools').execute({ name: 'run_code', callId: 'wsl-ptc', agent: exec.agent,
      signal: new AbortController().signal, arguments: { description: 'Verify shared WSL readonly file bindings',
        code: `return {page:await tools.ops_glob(${JSON.stringify({ ...scan, continuation: fresh.continuation })}),read:await tools.ops_read_files({files:[{path:'small.txt',limit:1}]})};` } })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.result.page.data.matchedTotal, 501, JSON.stringify(result.value.result))
    assert.equal(result.value.result.read.data.items[0].items[0].text, 'literal /var/tmp/source text')
  })
  await check('read observations keep original UNC identity and file text', async () => {
    observed.length = 0
    const value = await call('read_files', { files: [{ path: 'small.txt', offset: 1, limit: 1 }] })
    assert.equal(value.items[0].items[0].text, 'literal /var/tmp/source text')
    assert.equal(value.items[0].path, path.join(unc, 'small.txt')); assert.equal(observed.length, 1)
    assert.equal(observed[0].observation.kind, 'present')
    assert.equal((await call('read_files', { files: [{ path: 'link' }] })).items[0].error.code, 'PATH_RESTRICTED')
  })
  await check('Windows credential case folding and reserved-name scan gaps survive Linux', async () => {
    process.env.DSH_OPS_DENY_READ = path.join(unc, 'private')
    const blocked = await call('glob', { path: 'Private', pattern: ['**'], limit: 5 })
    assert.equal(blocked.error.code, 'CREDENTIAL_DENIED')
    delete process.env.DSH_OPS_DENY_READ
    const reserved = await call('glob', { path: 'reserved', pattern: ['**'], limit: 5 })
    assert.equal(reserved.scanComplete, false); assert.equal(reserved.skipReasons['invalid-path'], 1)
    assert.equal(reserved.matchedTotal, undefined)
  })
  await check('byte-clipped read falls back to Windows private storage and pages its reference', async () => {
    seen.length = 0
    const value = await call('read_files', { files: [{ path: 'large.txt' }] })
    assert.ok(value.reference?.refId, JSON.stringify({ ...value, items: [] }))
    assert.equal(wslPath(value.referenceRoot)?.file, fixture)
    const calls = seen.filter(item => item.envelope)
    assert.equal(calls.length, 2); assert.equal(calls[0].envelope.request.windows_paths, true)
    assert.equal(Object.hasOwn(calls[0].envelope, 'storage'), false); assert.ok(calls[1].envelope.storage)
    assert.ok(calls[1].envelope.budget.timeoutMs < calls[0].envelope.budget.timeoutMs)
    const page = await call('result', { action: 'page', id: value.reference.refId, limit: 5 })
    assert.equal(page.status, 'completed', JSON.stringify(page))
  })
  await check('disabled opt-in cannot downgrade an existing WSL cursor', async () => {
    delete process.env.DSH_OPS_WSL_READS; seen.length = 0
    const value = await call('glob', { ...scan, continuation: first.continuation })
    assert.equal(value.error.code, 'EXECUTOR_UNAVAILABLE'); assert.equal(seen.length, 0)
    process.env.DSH_OPS_WSL_READS = '1'
  })
  await check('authority loss after first probe prevents subsequent probes and workers', async () => {
    seen.length = 0
    hook = entry => { if (entry.argv.includes('/usr/bin/wslpath')) mode = 'read-only' }
    const value = await call('glob', scan); hook = () => {}; mode = 'workspace-write'
    assert.equal(value.error.code, 'AUTHORITY_CHANGED'); assert.equal(seen.length, 1)
  })
  await check('authority loss after accepted worker result cannot publish read observations', async () => {
    observed.length = 0; afterWorker = false; afterWorkerRevoke = true
    const value = await call('read_files', { files: [{ path: 'small.txt' }] })
    assert.equal(value.error.code, 'AUTHORITY_CHANGED'); assert.equal(observed.length, 0)
    afterWorkerRevoke = false; mode = 'workspace-write'
  })
  await check('an expired preparation budget never starts a worker or a Windows fallback', async () => {
    seen.length = 0
    const value = await call('glob', scan, undefined, { toolCallTimeoutMs: 1 })
    assert.equal(value.error.code, 'TIMEOUT'); assert.equal(seen.filter(item => item.envelope).length, 0)
  })
  await check('caller cancellation stops the actual Linux worker and never replays on Windows', async () => {
    seen.length = 0; const controller = new AbortController()
    const payload = wsl(['/usr/bin/wslpath', '-u', path.resolve('runtime/linux-x64/dsh-ops-worker')])
    const observerCode = `import os,pathlib,sys,time
deadline=time.monotonic()+20
print("ready",flush=True)
while time.monotonic()<deadline:
 for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit(): continue
  try:
   if os.readlink(p/'exe')==sys.argv[1]: print(p.name,flush=True);sys.exit(0)
  except (OSError,PermissionError): pass
 time.sleep(.001)
sys.exit(2)`
    const watcher = spawnChild(path.join(process.env.SystemRoot, 'System32', 'wsl.exe'), [...prefix, '/usr/bin/python3', '-c', observerCode, payload], { stdio: ['ignore', 'pipe', 'pipe'] })
    let ready, found, rejectReady, rejectFound, output = ''
    const started = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject })
    const observedPid = new Promise((resolve, reject) => { found = resolve; rejectFound = reject })
    watcher.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
      const lines = output.trim().split(/\r?\n/)
      if (lines.includes('ready')) ready()
      const pid = lines.find(line => /^[1-9][0-9]*$/.test(line))
      if (pid) { found(Number(pid)); controller.abort() }
    })
    watcher.on('error', error => { rejectReady(error); rejectFound(error) })
    watcher.on('close', code => { if (code !== 0) { const error = new Error(`Linux worker observer exited ${code}`); rejectReady(error); rejectFound(error) } })
    try {
      await started
      const pending = call('grep', { path: 'scan', pattern: 'needle', limit: 5 }, controller.signal)
      const [value, pid] = await Promise.all([pending, observedPid])
      assert.equal(value.error.code, 'CANCELLED'); assert.equal(seen.filter(item => item.envelope).length, 1)
      const gone = wsl(['/usr/bin/python3', '-c', 'import os,sys,signal;p=int(sys.argv[1]);alive=False\ntry: alive=os.readlink(f"/proc/{p}/exe")==sys.argv[2]\nexcept OSError: pass\nprint("alive" if alive else "gone");os.kill(p,signal.SIGTERM) if alive else None', String(pid), payload])
      assert.equal(gone, 'gone', `owned Linux worker ${pid} survived launcher cancellation`)
      console.log(`Linux worker PID ${pid} observed before cancellation and absent afterward`)
    } finally { watcher.kill() }
  })
  console.log(`WSL acceptance: ${checks} passed, 0 skipped/failed`)
} finally {
  hook = () => {}; mode = 'workspace-write'
  await expireResultSession(ctx, session)
  await shutdown(ctx)
  wsl(['/usr/bin/python3', '-c', 'import pathlib,shutil,sys;p=pathlib.Path(sys.argv[1]);assert p.parent==pathlib.Path("/var/tmp") and p.name.startswith("dsh-ops-wsl-accept-");shutil.rmtree(p)', fixture])
  assert.equal(path.dirname(local), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(local).startsWith('dsh-ops-wsl-accept-'))
  fs.rmSync(local, { recursive: true, force: true })
}
