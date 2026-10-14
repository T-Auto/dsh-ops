import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { patchMsys, proxyDefinition } from '../lib/bash-pe.js'
import { confinedBash } from '../lib/bash-ipc.js'
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
    assert.throws(()=>confinedBash(path.join(root,'usr/bin/bash.exe')),/no verified DSH IPC compatibility build/)
    assert.equal(fs.readFileSync(path.join(root,'usr/bin/msys-2.0.dll'),'utf8'),'unsupported')
  })
  assert.equal(hash(fs.readFileSync(path.join(source,'usr/bin/msys-2.0.dll'))),hash(original))
})
report('bash-ipc')
