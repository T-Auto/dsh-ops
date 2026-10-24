/** Release checks require the exact supported matrix, never just the build host. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { PACKAGE_ROOT, assert, report, test, withTempDir } from './lib/harness.mjs'
import { PLATFORMS, workerName } from '../lib/ptc/runtime.js'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function header(target) {
  const bytes = Buffer.alloc(80)
  if (target === 'win32-x64') { bytes.write('MZ'); bytes.writeUInt32LE(64,60); bytes.writeUInt32LE(0x4550,64); bytes.writeUInt16LE(0x8664,68) }
  if (target === 'linux-x64') { Buffer.from([127,69,76,70,2,1]).copy(bytes); bytes.writeUInt16LE(62,18) }
  if (target === 'darwin-arm64' || target === 'darwin-x64') { bytes.writeUInt32LE(0xfeedfacf,0); bytes.writeUInt32LE(target.endsWith('x64') ? 0x1000007 : 0x100000c,4) }
  return bytes
}
function fixture(root, targets = PLATFORMS) {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT,'package.json'),'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT,'dsh-plugin.json'),'utf8'))
  fs.mkdirSync(path.join(root,'bin'),{recursive:true})
  fs.mkdirSync(path.join(root,'lib/ptc'),{recursive:true})
  for (const name of ['native-runtime.mjs','check-release.mjs']) fs.copyFileSync(path.join(PACKAGE_ROOT,'bin',name),path.join(root,'bin',name))
  fs.copyFileSync(path.join(PACKAGE_ROOT,'lib/ptc/runtime.js'),path.join(root,'lib/ptc/runtime.js'))
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify(pkg))
  fs.writeFileSync(path.join(root,'dsh-plugin.json'),JSON.stringify(manifest))
  for (const target of targets) {
    const dir = path.join(root,'runtime',target), name = workerName(target.split('-')[0]), bytes = header(target)
    fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,name),bytes); fs.chmodSync(path.join(dir,name),0o755)
    fs.writeFileSync(path.join(dir,'provenance.json'),JSON.stringify({version:pkg.version,target,executable:name,sha256:hash(bytes)}))
  }
  if (targets.includes('win32-x64')) {
    const ipc=path.join(root,'runtime/win32-x64/bash-ipc'), source=path.join(root,'native/bash-ipc')
    fs.mkdirSync(ipc,{recursive:true}); fs.mkdirSync(source,{recursive:true})
    const receipt={version:1,platform:'win32-x64',files:{},sources:{}}
    for(const name of ['opsipc.dll','opsnt.dll']) { fs.writeFileSync(path.join(ipc,name),name); receipt.files[name]=hash(name) }
    for(const name of ['security.h','opsipc.cpp','opsnt.cpp']) { fs.writeFileSync(path.join(source,name),name); receipt.sources[name]=hash(name) }
    fs.writeFileSync(path.join(ipc,'provenance.json'),JSON.stringify(receipt))
  }
  return root
}
function run(root, name='check-release.mjs', args=[]) {
  const result=spawnSync(process.execPath,[path.join(root,'bin',name),...(name==='native-runtime.mjs'?['check']:[]),'--root',root,...args],{encoding:'utf8'})
  return {status:result.status,out:`${result.stdout}${result.stderr}`}
}
await test('all four paired targets and Windows IPC close successfully',async()=>withTempDir('release-all',root=>{
  fixture(root); const result=run(root); assert.equal(result.status,0,result.out); assert.match(result.out,/Release closure OK/)
}))
await test('an Intel-only staged closure validates its Mach-O worker and receipt (#371)',async()=>withTempDir('release-intel',root=>{
  fixture(root,['darwin-x64'])
  const result=run(root,'native-runtime.mjs',['--platform','darwin-x64'])
  assert.equal(result.status,0,result.out)
  assert.match(result.out,/darwin-x64/)
}))
await test('each missing target fails strict release while staged source checks remain local',async()=>withTempDir('release-missing',root=>{
  fixture(root,['linux-x64']); assert.equal(run(root,'native-runtime.mjs',['--staged']).status,0)
  const result=run(root); assert.notEqual(result.status,0); assert.match(result.out,/missing win32-x64, darwin-arm64, darwin-x64/)
}))
await test('every foreign target is rejected',async()=>withTempDir('release-foreign',root=>{
  fixture(root); for(const target of ['win32-arm64','linux-arm64','darwin-riscv64']) {
    const result=run(root,'native-runtime.mjs',['--platform',target]); assert.notEqual(result.status,0); assert.match(result.out,/Unsupported target/)
  }
}))
await test('non-host worker tampering is checked',async()=>withTempDir('release-tamper',root=>{
  fixture(root); fs.appendFileSync(path.join(root,'runtime/darwin-arm64/dsh-ops-worker'),'changed')
  const result=run(root); assert.notEqual(result.status,0); assert.match(result.out,/provenance mismatch|Native runtime gate failed/)
}))
await test('Windows worker without IPC cannot pass',async()=>withTempDir('release-no-ipc',root=>{
  fixture(root); fs.rmSync(path.join(root,'runtime/win32-x64/bash-ipc'),{recursive:true})
  const result=run(root); assert.notEqual(result.status,0); assert.match(result.out,/requires its Bash IPC/)
}))
await test('half-staged and unexpected targets are never silently skipped',async()=>withTempDir('release-stray',root=>{
  fixture(root); fs.mkdirSync(path.join(root,'runtime/darwin-riscv64')); assert.match(run(root).out,/Unexpected runtime targets/)
  fs.rmSync(path.join(root,'runtime/darwin-riscv64'),{recursive:true}); fs.unlinkSync(path.join(root,'runtime/darwin-arm64/provenance.json'))
  assert.match(run(root,'native-runtime.mjs',['--staged']).out,/Half-staged runtime/)
}))
await test('manifest exact targets, npm platform filters and shell pins must agree',async()=>withTempDir('release-drift',root=>{
  fixture(root); const file=path.join(root,'dsh-plugin.json'), manifest=JSON.parse(fs.readFileSync(file,'utf8'))
  manifest.contributes['x-components'].find(c=>c.id==='dsh-ops-ptc').targets.push('win32-arm64')
  fs.writeFileSync(file,JSON.stringify(manifest)); assert.match(run(root).out,/disagree/)
}))
await test('release closure requires the pinned Bash payload and refuses a PowerShell dependency', async () => withTempDir('release-shell-dep', root => {
  fixture(root)
  const file = path.join(root, 'package.json'), pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  const write = changed => fs.writeFileSync(file, JSON.stringify(changed))
  const expected = run(root)
  assert.equal(expected.status, 0, expected.out)
  assert.match(expected.out, /Release closure OK/)
  const cases = [
    { ...pkg, optionalDependencies: {} },
    { ...pkg, optionalDependencies: { ...pkg.optionalDependencies, '@dsh-ops/bash-win32-x64': '9.9.9' } },
    { ...pkg, dependencies: { ...pkg.dependencies, '@dsh-ops/bash-win32-x64': '0.2.1' } },
    { ...pkg, optionalDependencies: { ...pkg.optionalDependencies, '@dsh-ops/pwsh-win32-x64': '0.2.1' } },
    { ...pkg, dependencies: { ...pkg.dependencies, '@dsh-ops/pwsh-win32-x64': '0.2.1' } },
  ]
  for (const changed of cases) {
    write(changed)
    const result = run(root)
    assert.notEqual(result.status, 0, JSON.stringify(changed.optionalDependencies))
    assert.match(result.out, /must remain the pinned|must be optional|must not be a package dependency|only @dsh-ops optional payload/)
  }
}))
report('release-scope')
