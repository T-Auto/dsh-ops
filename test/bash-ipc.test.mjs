import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { pinnedBashExecutable } from '../lib/shells/pinned.js'
import { patchMsys, proxyDefinition } from '../lib/bash-pe.js'
import { confinedBash, quarantineGeneration, renameWithRetry, restrictedCompatibility, RENAME_RETRY_DELAYS_MS } from '../lib/bash-ipc.js'
import { markManaged } from '../lib/bash-ipc-lifecycle.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
await test('PE patch rejects non-PE input without writing anything', () => {
  assert.throws(()=>patchMsys(Buffer.from('not a DLL')),/Expected PE/)
})
await test('quarantine rename retries only transient sharing errors, a bounded number of times', () => {
  const eperm=()=>Object.assign(new Error('EPERM: operation not permitted'),{code:'EPERM'})
  let calls=0, waits=[]
  renameWithRetry('a','b',{delays:[1,2],wait:ms=>waits.push(ms),rename:()=>{calls+=1; if(calls<3)throw eperm()}})
  assert.equal(calls,3,'two refusals are absorbed, the third attempt succeeds')
  assert.deepEqual(waits,[1,2])
  calls=0
  assert.throws(()=>renameWithRetry('a','b',{delays:[1,2],wait:()=>{},rename:()=>{calls+=1; throw eperm()}}),error=>error.code==='EPERM')
  assert.equal(calls,3,'bounded: the first attempt plus one per delay, never more')
  // The configured budget must stay above the worst window measured in #352 (1639 ms); the
  // delays also fix the attempt count, so a shortened budget turns this assertion red.
  const budget=RENAME_RETRY_DELAYS_MS.reduce((sum,ms)=>sum+ms,0)
  assert.equal(RENAME_RETRY_DELAYS_MS.length,5,'five waits, i.e. six attempts including the first')
  assert.equal(budget,2500,'the cumulative budget is the documented 2.5 s')
  assert.ok(budget>1639,'the budget covers the worst measured recovery window from #352')
  calls=0
  assert.throws(()=>renameWithRetry('a','b',{delays:[1,2],wait:()=>{},rename:()=>{calls+=1; throw Object.assign(new Error('ENOENT: no such file'),{code:'ENOENT'})}}))
  assert.equal(calls,1,'an error that will not change is surfaced immediately')
})
await test('proxy definitions never intercept file, token, or impersonation APIs', () => {
  const kernel=proxyDefinition(['CreateNamedPipeA','CreatePipe','CreateFileA','CreateProcessW','ImpersonateNamedPipeClient'],'kernel32.dll')
  assert.match(kernel,/CreateNamedPipeA=OpsCreateNamedPipeA/)
  assert.match(kernel,/CreateFileA=KERNEL32.CreateFileA/)
  assert.match(kernel,/ImpersonateNamedPipeClient=KERNEL32.ImpersonateNamedPipeClient/)
  const nt=proxyDefinition(['NtCreateNamedPipeFile','NtCreateSection','NtCreateFile','NtSetInformationToken'],'ntdll.dll')
  assert.match(nt,/NtCreateFile=NTDLL.NtCreateFile/)
  assert.match(nt,/NtSetInformationToken=NTDLL.NtSetInformationToken/)
})
await test('private runtime accepts only matching original MSYS, and never edits the original', async () => {
  if(process.platform!=='win32')return
  const source=path.resolve(path.dirname(pinnedBashExecutable({file:process.env.DSH_OPS_TEST_BASH})),'..')
  const original=fs.readFileSync(path.join(source,'usr/bin/msys-2.0.dll'))
  const hash=b=>createHash('sha256').update(b).digest('hex')
  const patched=patchMsys(original)
  assert.notEqual(hash(original),hash(patched.bytes))
  assert.equal(original.includes(Buffer.from('opsipc.dll')),false)
  assert.equal(patched.bytes.includes(Buffer.from('opsipc.dll')),true)
  await withTempDir('unsupported-msys',async root=>{
    fs.mkdirSync(path.join(root,'usr/bin'),{recursive:true})
    fs.writeFileSync(path.join(root,'usr/bin/msys-2.0.dll'),'unsupported')
    const bash=path.join(root,'usr/bin/bash.exe')
    let message=''
    try { confinedBash(bash,{source:'config'}) } catch(error) { message=error.message }
    // The diagnostic is actionable, not "rebuild the proxies" (#42).
    assert.match(message,/^EXECUTOR_UNAVAILABLE: ops_bash cannot run the configured bashPath /)
    assert.ok(message.includes(bash),message)
    assert.match(message,/is not the pinned build/)
    assert.match(message,/works only in danger-full-access/)
    assert.match(message,/remove bashPath/)
    assert.match(message,/provision-shells --bash/)
    assert.match(message,/Approvals never repair an incompatible confined runtime/)
    assert.doesNotMatch(message,/Rebuild the matching proxies/)
    const check=restrictedCompatibility(bash)
    assert.equal(check.compatible,false)
    assert.equal(check.expectedSha256===undefined,false)
    assert.equal(fs.readFileSync(path.join(root,'usr/bin/msys-2.0.dll'),'utf8'),'unsupported')
    assert.deepEqual(fs.readdirSync(root),['usr'],'the check copies or builds nothing')
  })
  assert.equal(hash(fs.readFileSync(path.join(source,'usr/bin/msys-2.0.dll'))),hash(original))
})
await test('restricted compatibility accepts the pinned payload and explains a missing MSYS layout', async () => {
  if(process.platform!=='win32')return
  const receipt=path.resolve('runtime/win32-x64/bash-ipc/provenance.json')
  if(fs.existsSync(receipt)) {
    const pinned=restrictedCompatibility(pinnedBashExecutable({file:process.env.DSH_OPS_TEST_BASH}))
    assert.equal(pinned.compatible,true,pinned.reason)
  }
  await withTempDir('no-msys',async root=>{
    const check=restrictedCompatibility(path.join(root,'bin/bash.exe'))
    assert.equal(check.compatible,false)
    assert.match(check.reason,/not the supported MSYS payload layout/)
    assert.throws(()=>confinedBash(path.join(root,'bin/bash.exe'),{source:'well-known'}),/system Git for Windows install .*works only in danger-full-access/s)
  })
})
await test('a tampered leased generation is refused without moving active paths; an idle fixture recovers', async () => {
  if(process.platform!=='win32')return
  const source=path.resolve(path.dirname(pinnedBashExecutable({file:process.env.DSH_OPS_TEST_BASH})),'..')
  const bash=path.join(source,'usr/bin/bash.exe')
  await withTempDir('bash-ipc-tamper',async home=>{
    const first=confinedBash(bash,{home}), target=path.dirname(path.dirname(path.dirname(first.file)))
    const proxy=path.join(target,'usr/bin/opsipc.dll'), markerPath=path.join(target,'.ops-ipc.json')
    const marker=JSON.parse(fs.readFileSync(markerPath,'utf8')),buf=fs.readFileSync(proxy)
    buf[buf.length-1]^=0xff;fs.writeFileSync(proxy,buf)
    const now=fs.statSync(proxy)
    assert.equal(now.size,marker.tree['usr/bin/opsipc.dll'].size)
    marker.tree['usr/bin/opsipc.dll']={size:now.size,mtimeMs:now.mtimeMs}
    fs.writeFileSync(markerPath,JSON.stringify(marker)+'\n')
    assert.throws(()=>confinedBash(bash,{home}),/could not be quarantined/)
    assert.equal(fs.existsSync(target),true,'leased absolute paths must remain untouched')
    assert.equal(fs.readdirSync(path.dirname(target)).some(n=>n.includes('.bad-')),false)
    // No shell was launched by this fixture: explicitly model a provably idle generation.
    fs.rmSync(path.join(target,'.ops-leases'),{recursive:true,force:true})
    const recovered=confinedBash(bash,{home})
    assert.equal(recovered.file,first.file)
    assert.equal(fs.readdirSync(path.dirname(target)).some(n=>n.includes('.bad-')),true)
    assert.equal(confinedBash(bash,{home}).file,first.file)
  })
})
await test('a transient EPERM on quarantine is retried instead of stranding the cache (#352)', async () => {
  await withTempDir('bash-ipc-quarantine', async home=>{
    const target=path.join(home,'dsh-ops','bash-ipc','generation')
    fs.mkdirSync(target,{recursive:true})
    markManaged(target)
    fs.writeFileSync(path.join(target,'payload.txt'),'a generation that failed verification')
    const realRename=fs.renameSync
    let attempts=0
    // Two refusals, then the same rename Windows would accept a moment later. Without the retry the
    // first `EPERM` escapes and the generation is never quarantined — the cache stays stranded.
    const quarantine=quarantineGeneration(target,{rename:(from,to)=>{
      attempts+=1
      if(attempts<=2)throw Object.assign(new Error('EPERM: operation not permitted'),{code:'EPERM'})
      realRename(from,to)
    }})
    assert.equal(attempts,3,'both refused attempts are retried, and the third succeeds')
    assert.equal(fs.existsSync(target),false,'the failed generation is moved aside')
    assert.equal(fs.existsSync(quarantine),true,'the quarantine is a sibling, not a deletion')
    assert.equal(path.dirname(quarantine),path.dirname(target))

    // A failure that does not go away must stay bounded rather than spin.
    const stuck=path.join(home,'dsh-ops','bash-ipc','stuck')
    fs.mkdirSync(stuck,{recursive:true})
    markManaged(stuck)
    let calls=0
    assert.throws(()=>quarantineGeneration(stuck,{rename:()=>{calls+=1; throw Object.assign(new Error('EPERM'),{code:'EPERM'})}}),error=>error.code==='EPERM')
    assert.equal(calls,RENAME_RETRY_DELAYS_MS.length+1,'the attempt budget is the configured one')
    assert.equal(fs.existsSync(stuck),true,'a generation that cannot be moved is left where it was')
  })
})
await test('malformed IPC proxy receipts fail before staging a runtime', async () => {
  await withTempDir('bash-ipc-receipt', async root => {
    const plugin = path.join(root, 'plugin'), payload = path.join(root, 'payload'), home = path.join(root, 'home')
    fs.mkdirSync(path.join(plugin, 'lib/shells'), { recursive: true })
    fs.mkdirSync(path.join(plugin, 'runtime/win32-x64/bash-ipc'), { recursive: true })
    fs.mkdirSync(path.join(payload, 'usr/bin'), { recursive: true })
    fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ type: 'module' }))
    for (const file of ['bash-ipc.js', 'bash-ipc-lifecycle.js', 'bash-pe.js', 'shells/types.js']) {
      fs.copyFileSync(path.resolve('lib', file), path.join(plugin, 'lib', file))
    }
    const dll = Buffer.from('receipt validation must precede PE parsing')
    fs.writeFileSync(path.join(payload, 'usr/bin/msys-2.0.dll'), dll)
    fs.writeFileSync(path.join(plugin, 'runtime/win32-x64/bash-ipc/provenance.json'), JSON.stringify({
      platform: 'win32-x64', msysSha256: createHash('sha256').update(dll).digest('hex'), files: null,
    }))
    const isolated = await import(pathToFileURL(path.join(plugin, 'lib/bash-ipc.js')).href)
    assert.throws(() => isolated.confinedBash(path.join(payload, 'usr/bin/bash.exe'), { home, platform: 'win32' }),
      /^Error: EXECUTOR_UNAVAILABLE: This MSYS version has no verified DSH IPC compatibility build/)
    assert.equal(fs.existsSync(home), false, 'invalid receipts cannot create a private runtime')
    assert.deepEqual(fs.readFileSync(path.join(payload, 'usr/bin/msys-2.0.dll')), dll)
  })
})
report('bash-ipc')
