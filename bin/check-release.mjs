#!/usr/bin/env node
/** Windows and Linux x64 release closure. No downloads, credentials or publish side effects. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
// --require win32-x64,linux-x64 demands a target this staging tree may not
// carry; without it the closure validates exactly what is staged, which is what
// a local build can honestly answer. The release run passes every advertised
// target, so a tarball missing one cannot be produced by the documented flow.
const args=process.argv.slice(2)
const required=[]
for(let i=0;i<args.length;i++){
  if(args[i]==='--require'){required.push(...String(args[++i]??'').split(',').map(s=>s.trim()).filter(Boolean))}
  else if(args[i].startsWith('--require=')){required.push(...args[i].slice('--require='.length).split(',').map(s=>s.trim()).filter(Boolean))}
  else throw Error(`unknown argument: ${args[i]}`)
}
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
if(JSON.stringify(pkg.os)!=='["win32","linux"]'||JSON.stringify(pkg.cpu)!=='["x64"]')throw Error('Release scope must be Windows and Linux x64')
const SUPPORTED=new Set(['win32-x64','linux-x64'])
const targets=fs.readdirSync(path.join(root,'runtime'),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort()
if(targets.length===0||targets.some(target=>!SUPPORTED.has(target)))throw Error(`Unexpected runtime targets in release: ${targets.join(', ')}`)
for(const target of required)if(!targets.includes(target))throw Error(`this release must carry ${target}; staged: ${targets.join(', ')}. Stage it with \`node bin/native-runtime.mjs stage --platform ${target} --input <build>\`.`)
for(const target of targets)if(!fs.existsSync(path.join(root,'runtime',target,'provenance.json')))throw Error(`${target} has no provenance receipt; restage it instead of shipping unverified bytes`)
// Check exactly the targets this build staged, not every target the source can
// build: a Windows-only or Linux-only staging tree is a legitimate closure.
const check=spawnSync(process.execPath,[path.join(root,'bin/native-runtime.mjs'),'check',...targets.flatMap(target=>['--platform',target])],{stdio:'inherit'})
if(check.status!==0)throw Error('Native runtime gate failed')
// The Bash IPC proxies exist only where the MSYS payload does: the Windows target.
// A Linux-only build legitimately carries none, so the closure checks them when
// the directory is present instead of demanding them from every platform.
const ipc=path.join(root,'runtime/win32-x64/bash-ipc')
if(fs.existsSync(ipc)){
const receipt=JSON.parse(fs.readFileSync(path.join(ipc,'provenance.json'),'utf8'))
if(receipt.version!==1||receipt.platform!=='win32-x64')throw Error('Invalid Bash IPC receipt')
for(const name of ['opsipc.dll','opsnt.dll'])if(hash(path.join(ipc,name))!==receipt.files[name])throw Error(`IPC hash mismatch ${name}`)
for(const name of ['security.h','opsipc.cpp','opsnt.cpp'])if(hash(path.join(root,'native/bash-ipc',name))!==receipt.sources[name])throw Error(`IPC source mismatch ${name}; rebuild proxies`)
const actual=fs.readdirSync(ipc).sort()
if(JSON.stringify(actual)!==JSON.stringify(['opsipc.dll','opsnt.dll','provenance.json']))throw Error('Unexpected Bash IPC output files')
}
console.log(`Release closure OK: dsh-ops@${pkg.version}, ${targets.join(' + ')} worker(s)`+(fs.existsSync(ipc)?' + Bash IPC proxies + matching source.':'.'))
