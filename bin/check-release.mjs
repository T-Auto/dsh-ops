#!/usr/bin/env node
/** Windows x64 0.3.0 release closure. No downloads, credentials or publish side effects. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
if(JSON.stringify(pkg.os)!=='["win32"]'||JSON.stringify(pkg.cpu)!=='["x64"]')throw Error('Release scope must be Windows x64')
const targets=fs.readdirSync(path.join(root,'runtime'),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name)
if(JSON.stringify(targets)!=='["win32-x64"]')throw Error('Unexpected runtime targets in release')
const check=spawnSync(process.execPath,[path.join(root,'bin/native-runtime.mjs'),'check'],{stdio:'inherit'})
if(check.status!==0)throw Error('Native runtime gate failed')
const ipc=path.join(root,'runtime/win32-x64/bash-ipc')
const receipt=JSON.parse(fs.readFileSync(path.join(ipc,'provenance.json'),'utf8'))
if(receipt.version!==1||receipt.platform!=='win32-x64')throw Error('Invalid Bash IPC receipt')
for(const name of ['opsipc.dll','opsnt.dll'])if(hash(path.join(ipc,name))!==receipt.files[name])throw Error(`IPC hash mismatch ${name}`)
for(const name of ['security.h','opsipc.cpp','opsnt.cpp'])if(hash(path.join(root,'native/bash-ipc',name))!==receipt.sources[name])throw Error(`IPC source mismatch ${name}; rebuild proxies`)
const actual=fs.readdirSync(ipc).sort()
if(JSON.stringify(actual)!==JSON.stringify(['opsipc.dll','opsnt.dll','provenance.json']))throw Error('Unexpected Bash IPC output files')
console.log(`Release closure OK: dsh-ops@${pkg.version}, Windows x64 worker + Bash IPC proxies + matching source.`)
