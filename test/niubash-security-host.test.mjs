import { selectExecutor, executeCall, prepareStep } from './lib/executor.mjs'
import fs from 'node:fs'
import path from 'node:path'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import { assert, test, report, skipSuite, scenarioDir, waitFor } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { verifiedNiubash } from '../lib/niubash/runtime.js'
import { resolveShells } from '../lib/shells/resolve.js'
import { pathToFileURL } from 'node:url'
const consumerRoot = process.env.DSH_OPS_NIUBASH_CONSUMER
const moduleAt = relative => import(consumerRoot ? pathToFileURL(path.join(consumerRoot, relative)).href : new URL(`../${relative}`, import.meta.url).href)
const { mountSessionBash } = await moduleAt('lib/session-shells.js')
const { startSessionBash } = await moduleAt('lib/shells/session-execution.js')
const { DEFAULT_BASH_TIMEOUT_MS } = await moduleAt('lib/shells/constants.js')

// Opt-in upstream fixture, never a developer profile or installer. The exact full-tree pin is
// still enforced; this variable cannot bless alternate bytes. CI can supply its frozen artifact.
const file = consumerRoot ? path.join(consumerRoot, 'runtime/win32-x64/niubash/niu.exe') : process.env.DSH_OPS_TEST_NIUBASH
if (process.platform !== 'win32' || !file) skipSuite('niubash-security-host', 'requires Windows x64 and DSH_OPS_TEST_NIUBASH pointing at the complete frozen v1.5.0 payload')
verifiedNiubash(file)
const root = scenarioDir('niu-host-中文'), outside = scenarioDir('niu-outside')
const bash = consumerRoot ? resolveShells({}, { bundleRoot: consumerRoot }).bash : resolveShells({ bashPath: file }).bash
assert.equal(bash.available, true, bash.detail)
const { ctx } = await bootHost({ withWorkingDirectory: true })
const agent = { id: 'niu-security', session: { id: 'niu-security', mode: 'workspace-write', header: { cwd: root }, append() { return Promise.resolve() }, read() { return [] } } }
agent.ctx = createScope(ctx, agent).ctx
await ctx.plugin(Subprocess)
await ctx.plugin(Sandbox, {})
await ctx.plugin(inner => inner.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: (input) => ({ mode: input?.session?.mode ?? agent.session.mode, workspaceRoot: root, sessionId: input?.session?.id ?? agent.session.id }) }))
await ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { mountSessionBash(inner, { publishBashTool: true }, { bash }) } })
await ctx.serial('agent/created', { agent })
await waitFor(() => ctx.get('tools').get('ops_bash', agent), { what: 'Niubash tool publication' })
const tool = ctx.get('tools').get('ops_bash', agent)
const call = (command, overrides = {}, signal = new AbortController().signal) => tool.execute({ description: 'Verify Niubash confinement', command, graceMs: 100, workdir: root, ...overrides }, { agent, signal })
const quote = text => `'${text.replaceAll("'", "'\\''")}'`
// Use native script files: Niubash pipeline reparsing of nested quotes is an upstream
// language difference, not evidence that the OPS sandbox denied a filesystem operation.
let scriptSequence = 0
const node = code => {
  const script = path.join(root, `native-${scriptSequence++}.cjs`)
  fs.writeFileSync(script, code)
  return `${quote(process.execPath)} ${quote(script)}`
}
const ok = value => { assert.equal(value.exitCode, 0, JSON.stringify(value)); assert.equal(value.status, 'completed', JSON.stringify(value)); return value }
try {
  await test('the execution root parent honours DSH_OPS_EXEC_ROOT', async () => {
    // Outside the session workspace: the workspace-write grant writes an
    // inheritable Low label on the workspace root, and a clone below it would
    // mark the payload's shared inodes Low (the shell then starts at Low
    // integrity and every Medium sibling path is refused).
    const configured = path.join(path.dirname(root), 'exec-root')
    const previous = process.env.DSH_OPS_EXEC_ROOT
    process.env.DSH_OPS_EXEC_ROOT = configured
    try {
      const value = ok(await call(node('process.stdout.write(process.env.NIU_ROOT)')))
      // NIU_ROOT is the clone's winuxcmd directory; its parent is the per-call tree.
      const instance = path.dirname(value.stdout.text)
      assert.match(path.basename(instance), /^dsh-ops-niu-exec-/u)
      assert.equal(fs.realpathSync.native(path.dirname(instance)), fs.realpathSync.native(configured))
      assert.equal(fs.existsSync(instance), false, 'the execution tree is disposed')
    } finally {
      if (previous === undefined) delete process.env.DSH_OPS_EXEC_ROOT
      else process.env.DSH_OPS_EXEC_ROOT = previous
    }
  })
  await test('real host confines Niubash command, script, EOF stdin and native children with Unicode cwd/env', async () => {
    const value = ok(await call("printf '牛'; printf pipe | cat; read x; printf 'EOF=%s' \"$?\""))
    assert.equal(value.stdout.text, '牛pipeEOF=1'); assert.equal(value.sandbox.mode, 'workspace-write'); assert.equal(value.sandbox.enforcement, 'partial')
    fs.writeFileSync(path.join(root, '脚本 file.sh'), "printf 'SCRIPT中文'\n")
    assert.equal(ok(await call(undefined, { script_path: path.join(root, '脚本 file.sh') })).stdout.text, 'SCRIPT中文')
    const native = ok(await call(node("const fs=require('fs'),path=require('path');const base=path.dirname(process.env.NIU_ROOT);const receipt=JSON.parse(fs.readFileSync(path.join(base,'execution-provenance.json'),'utf8'));const cat=fs.statSync(path.join(process.env.NIU_ROOT,'usr/bin/cat.exe'));process.stdout.write(JSON.stringify({cwd:process.cwd(),root:process.env.NIU_ROOT,mode:receipt.mode,seal:receipt.seal,writeBits:cat.mode & 0o222,nlink:cat.nlink}));")))
    const data = JSON.parse(native.stdout.text)
    assert.equal(fs.realpathSync.native(data.cwd), fs.realpathSync.native(root)); assert.notEqual(data.root, path.dirname(file)); assert.equal(path.basename(data.root), 'winuxcmd'); assert.match(path.basename(path.dirname(data.root)), /^dsh-ops-niu-exec-/); assert.equal(fs.existsSync(data.root), false, 'execution copy disposed after settlement')
    assert.ok(data.mode === 'hardlink' || data.mode === 'copy', JSON.stringify(data))
    assert.equal(data.seal === 'readonly+acl' || data.seal === 'readonly', true, JSON.stringify(data))
    assert.equal(data.writeBits, 0, 'the payload is sealed read-only while the command runs')
    if (data.mode === 'hardlink') assert.ok(data.nlink >= 2, JSON.stringify(data))
    else assert.equal(data.nlink, 1, JSON.stringify(data))
  })
  await test('workspace in/out and read-only effects are confined for shell and native child', async () => {
    ok(await call('printf allowed > allowed.txt'))
    assert.equal(fs.readFileSync(path.join(root, 'allowed.txt'), 'utf8'), 'allowed')
    for (const command of ['printf denied > forbidden.txt', node("require('fs').writeFileSync('native-forbidden.txt','bad')")]) {
      const value = await call(command, { workdir: outside })
      assert.equal(value.timedOut, false, JSON.stringify(value)); assert.notEqual(value.exitCode, 0, JSON.stringify(value))
    }
    assert.equal(fs.existsSync(path.join(outside, 'forbidden.txt')), false)
    assert.equal(fs.existsSync(path.join(outside, 'native-forbidden.txt')), false)
    agent.session.mode = 'read-only'
    const denied = await call('printf denied > read-only.txt')
    assert.equal(denied.timedOut, false, JSON.stringify(denied)); assert.notEqual(denied.exitCode, 0, JSON.stringify(denied)); assert.equal(fs.existsSync(path.join(root, 'read-only.txt')), false)
    const native = await call(node("require('fs').writeFileSync('native-read-only.txt','bad')"))
    assert.equal(native.timedOut, false, JSON.stringify(native)); assert.notEqual(native.exitCode, 0, JSON.stringify(native)); assert.equal(fs.existsSync(path.join(root, 'native-read-only.txt')), false)
    agent.session.mode = 'workspace-write'
    ok(await call('printf restored > restored.txt'))
  })
  await test('two consecutive read-only and workspace-write calls preserve immutable source', async () => {
    for (const mode of ['read-only', 'workspace-write']) {
      agent.session.mode = mode
      for (let n = 0; n < 2; n++) assert.equal(ok(await call('printf repeated')).stdout.text, 'repeated')
      verifiedNiubash(file)
    }
    agent.session.mode = 'workspace-write'
  })
  await test('restricted native children cannot modify the source or their execution payload', async () => {
    for (const mode of ['read-only', 'workspace-write']) {
      agent.session.mode = mode
      for (const target of ['source', 'execution']) {
        const command = node(`const fs=require('fs'),path=require('path');const file=${target === 'source' ? 'JSON_SOURCE' : "path.join(process.env.NIU_ROOT,'usr/bin/cat.exe')"};try{fs.appendFileSync(file,'BAD');process.stdout.write('MUTATED')}catch(e){process.stdout.write('DENIED')}`.replace('JSON_SOURCE', JSON.stringify(path.join(path.dirname(file), 'niu.exe'))))
        assert.equal(ok(await call(command)).stdout.text, 'DENIED', `${mode} ${target}`)
      }
      verifiedNiubash(file)
    }
    agent.session.mode = 'workspace-write'
  })
  await test('external cat and awk resolve inside the fresh production execution payload', async () => {
    const resolved = JSON.parse(ok(await call(node(`const fs=require('fs'),path=require('path');const find=name=>process.env.PATH.split(path.delimiter).map(dir=>path.join(dir,name+'.exe')).find(file=>fs.existsSync(file));process.stdout.write(JSON.stringify({cat:find('cat'),awk:find('awk')}))`))).stdout.text)
    assert.match(resolved.cat, /dsh-ops-niu-exec-.*winuxcmd.*cat/i)
    assert.match(resolved.awk, /dsh-ops-niu-exec-.*winuxcmd.*awk/i)
    // Explicit external invocation bypasses the rubash builtin without introducing a
    // nested synchronous Node launcher (which has its own host sandbox constraints).
    const value = ok(await call('printf EXTERNAL_CAT | "$NIU_ROOT/usr/bin/cat.exe"'))
    assert.equal(value.stdout.text, 'EXTERNAL_CAT')
    assert.equal(ok(await call("printf '2\n' | awk '{print $1+1}'")).stdout.text.trim(), '3')
  })
  await test('host output spill and native pipeline preserve complete retained output', async () => {
    const value = ok(await call(node("process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000))"), { includeDiagnostics: true }))
    for (const stream of [value.stdout, value.stderr]) {
      assert.equal(stream.bytesTotal, 200000, JSON.stringify(stream))
      assert.ok(stream.spillPath); assert.equal(fs.statSync(stream.spillPath).size, 200000)
    }
    const pipeline = ok(await call(`${node("process.stdout.write('NATIVE_PIPE')")} | cat`))
    assert.equal(pipeline.stdout.text, 'NATIVE_PIPE', JSON.stringify(pipeline))
  })
  await test('host timeout and cancellation kill native descendants, not just niu.exe', async () => {
    for (const cancel of [false, true]) {
      agent.session.mode = cancel ? 'workspace-write' : 'danger-full-access'
      const marker = path.join(root, cancel ? 'cancel-child.txt' : 'timeout-child.txt')
      const ready = path.join(root, cancel ? 'cancel-ready.txt' : 'timeout-ready.txt')
      const controller = new AbortController()
      // The deadline includes full verified staging. Schedule the timeout marker
      // past that absolute deadline so variable preparation cannot make it fire early.
      const deadline = Date.now() + DEFAULT_BASH_TIMEOUT_MS
      const markerDelay = cancel ? '30000' : `Math.max(0, ${deadline + 2000} - Date.now())`
      const command = node(`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'escaped'),${markerDelay});setInterval(()=>{},1000)`)
      const pending = call(command, { timeoutMs: DEFAULT_BASH_TIMEOUT_MS }, controller.signal)
      if (cancel) { await waitFor(() => fs.existsSync(ready), { what: 'native child readiness', timeoutMs: DEFAULT_BASH_TIMEOUT_MS }); controller.abort(new Error('security test cancellation')) }
      const value = await pending
      assert.equal(cancel ? value.cancelled : value.timedOut, true, JSON.stringify(value))
      assert.equal(fs.existsSync(ready), true, 'child actually started')
      await new Promise(resolve => setTimeout(resolve, cancel ? 30200 : Math.max(0, deadline + 2200 - Date.now())))
      assert.equal(fs.existsSync(marker), false, 'no live child remains after host Job termination')
    }
    agent.session.mode = 'workspace-write'
  })
  await test('sandbox failures and authority changes during confinement fail before host spawn', async () => {
    agent.session.mode = 'workspace-write'
    for (const changed of [false, true]) {
      let spawns = 0
      const policy = ctx.get('sandboxPolicy').resolve({ session: agent.session })
      const guarded = { get(name) {
        if (name === 'subprocess') return { spawn() { spawns++; throw new Error('must not spawn') } }
        if (name === 'sandbox') return { async confine(argv) {
          if (!changed) throw new Error('SANDBOX_UNAVAILABLE: test provider failed')
          agent.session.mode = 'read-only'
          return { argv, enforcement: 'partial' }
        } }
        return ctx.get(name)
      } }
      const execution = startSessionBash({ ctx: guarded, bash, active: () => true },
        { command: 'printf MUST_NOT_START', workdir: root }, { agent }, policy, policy, {}, {})
      const value = await execution.result()
      assert.match(value.error, changed ? /AUTHORITY_CHANGED/ : /EXECUTOR_UNAVAILABLE/)
      if (!changed) assert.equal(value.sandbox.runnerFailed, true)
      assert.equal(spawns, 0)
      agent.session.mode = 'workspace-write'
    }
  })
  await test('Native and PTC projections use the same live session policy', async () => {
    await ctx.plugin(FileSystem, {})
    await ctx.plugin(NodePtc, {})
    await agent.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(inner) { selectExecutor(inner, 'ptc') } })
    const ptc = async (command, workdir = root) => {
      const result = await executeCall(ctx, { name: 'run_code', callId: 'niu-ptc', agent, signal: new AbortController().signal,
        arguments: { description: 'Verify Niubash PTC authority', code: `return await tools.ops_bash(${JSON.stringify({ description: 'Verify PTC confinement', command, workdir })});` } })
      assert.notEqual(result.isError, true, JSON.stringify(result)); return result.value.result
    }
    assert.equal(ok(await ptc("printf 'PTC_OK' | cat")).stdout.text, 'PTC_OK')
    const value = await ptc('printf blocked > ptc-outside.txt', outside)
    assert.equal(value.timedOut, false, JSON.stringify(value)); assert.notEqual(value.exitCode, 0, JSON.stringify(value)); assert.equal(fs.existsSync(path.join(outside, 'ptc-outside.txt')), false)
    agent.session.mode = 'read-only'
    const denied = await ptc('printf blocked > ptc-readonly.txt')
    assert.equal(denied.timedOut, false, JSON.stringify(denied)); assert.notEqual(denied.exitCode, 0, JSON.stringify(denied)); assert.equal(fs.existsSync(path.join(root, 'ptc-readonly.txt')), false)
    agent.session.mode = 'danger-full-access'
    ok(await call('printf full > full.txt', { workdir: outside }))
    assert.equal(fs.readFileSync(path.join(outside, 'full.txt'), 'utf8'), 'full')
  })
  await test('the real frozen payload remains byte-identical after execution', async () => {
    verifiedNiubash(file); assert.equal(fs.existsSync(path.join(path.dirname(file), 'winuxcmd/dev')), false)
  })
} finally { await shutdown(ctx) }
report('niubash-security-host')
