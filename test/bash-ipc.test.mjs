import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { patchMsys, proxyDefinition } from '../lib/bash-pe.js'
import { confinedBash, restrictedCompatibility } from '../lib/bash-ipc.js'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
await test('PE patch rejects non-PE input without writing anything', () => {
  assert.throws(()=>patchMsys(Buffer.from('not a DLL')),/Expected PE/)
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
  const source=path.resolve('node_modules/@dsh-ops/bash-win32-x64')
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
    assert.match(message,/no per-call sandbox_permissions escalation/)
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
    const pinned=restrictedCompatibility(path.resolve('node_modules/@dsh-ops/bash-win32-x64/bin/bash.exe'))
    assert.equal(pinned.compatible,true,pinned.reason)
  }
  await withTempDir('no-msys',async root=>{
    const check=restrictedCompatibility(path.join(root,'bin/bash.exe'))
    assert.equal(check.compatible,false)
    assert.match(check.reason,/not the supported MSYS payload layout/)
    assert.throws(()=>confinedBash(path.join(root,'bin/bash.exe'),{source:'well-known'}),/system Git for Windows install .*works only in danger-full-access/s)
  })
})
await test('a tampered cached generation is rejected, quarantined and rebuilt', async () => {
  if(process.platform!=='win32')return
  const receipt=path.resolve('runtime/win32-x64/bash-ipc/provenance.json')
  if(!fs.existsSync(receipt))return
  const source=path.resolve('node_modules/@dsh-ops/bash-win32-x64')
  const bash=path.join(source,'usr/bin/bash.exe')
  if(!fs.existsSync(bash))return
  await withTempDir('bash-ipc-tamper',async home=>{
    const first=confinedBash(bash,{home})
    const target=path.join(home,'dsh-ops','bash-ipc',first.runtime)
    const bads=()=>fs.readdirSync(path.dirname(target)).filter(n=>n.includes('.bad-')).length

    // (1) Content changed, **length preserved** — the case only the "versus the in-package receipt"
    //     anchor can see. A stat-only comparison (which an intermediate revision shipped) let this
    //     through on both paths.
    // (1) Content changed, length preserved, **and the manifest's recorded size/mtime updated to
    //     match** — i.e. the attacker rewrote the manifest too, which is precisely what the cheap stat
    //     layer cannot catch. (Restoring mtime with `utimes` is not a reliable setup: it quantises, and
    //     two attempts failed to settle on the recorded value. Driving the comparison from the manifest
    //     side is deterministic.) With a stat-only comparison — which an intermediate revision
    //     shipped — this passes on **both** paths; the "versus the in-package receipt" anchor is what
    //     rejects it. Verified by mutation: disable that anchor and this assertion stops failing.
    const proxy=path.join(target,'usr/bin/opsipc.dll')
    const markerPath=path.join(target,'.ops-ipc.json')
    const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'))
    const buf=fs.readFileSync(proxy)
    buf[buf.length-1]^=0xff
    fs.writeFileSync(proxy,buf)
    const now=fs.statSync(proxy)
    assert.equal(now.size,marker.tree['usr/bin/opsipc.dll'].size,'test setup: flipping one byte must not change the size')
    marker.tree['usr/bin/opsipc.dll']={size:now.size,mtimeMs:now.mtimeMs}
    fs.writeFileSync(markerPath,JSON.stringify(marker)+'\n')
    const second=confinedBash(bash,{home})
    assert.equal(second.file,first.file)
    assert.equal(bads()>0,true,'a tampered generation must be quarantined')

    // (2) A different size in one of the PATH directories — the stat layer catches this one, and the
    //     rebuild must **not** throw (the pre-recovery code bricked the tool until the host restarted).
    const again=path.join(home,'dsh-ops','bash-ipc',second.runtime)
    fs.appendFileSync(path.join(again,'cmd/git.exe'),'X'.repeat(4096))
    const third=confinedBash(bash,{home})
    assert.equal(third.file,first.file)

    // (3) Served from the rebuild, and the quarantine does not accumulate.
    assert.equal(confinedBash(bash,{home}).file,third.file)
    assert.equal(bads()<=2,true)
  })
})
report('bash-ipc')
