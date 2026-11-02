#!/usr/bin/env node
/** Build local Windows x64 IPC proxies; no package or host binary is modified. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pinnedBashExecutable } from '../lib/shells/pinned.js'
import { patchMsys, proxyDefinition } from '../lib/bash-pe.js'
import { bashIpcBuildBatch } from './lib/bash-ipc-command.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Build the Bash IPC proxies on Windows x64')
const bash=pinnedBashExecutable({file:process.env.DSH_OPS_TEST_BASH})
const source=path.resolve(path.dirname(bash),'../usr/bin/msys-2.0.dll')
const {exports}=patchMsys(fs.readFileSync(source))
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'ops-ipc-build-'))
const destination=path.join(root,'runtime/win32-x64/bash-ipc')
const programFiles=process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'
const vswhere=path.join(programFiles,'Microsoft Visual Studio/Installer/vswhere.exe')
const discovered=fs.existsSync(vswhere) ? spawnSync(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{encoding:'utf8',windowsHide:true}).stdout.trim() : ''
const vcvars=process.env.DSH_OPS_VCVARS64 ?? (discovered ? path.join(discovered,'VC/Auxiliary/Build/vcvars64.bat') : '')
if(!fs.existsSync(vcvars))throw Error('Set DSH_OPS_VCVARS64 to the installed vcvars64.bat')
try {
 const targets=[]
 for(const [dll,names] of Object.entries(exports)){
  const name=dll==='kernel32.dll'?'opsipc':'opsnt'
  fs.writeFileSync(path.join(scratch,name+'.def'),proxyDefinition(names,dll))
  targets.push(name)
 }
 const batch=bashIpcBuildBatch({vcvars,scratch,sourceDirectory:path.join(root,'native/bash-ipc'),names:targets})
 const file=path.join(scratch,'build.cmd');fs.writeFileSync(file,batch.text,'ascii')
 const build=spawnSync('cmd.exe',['/d','/c',file],{stdio:'inherit',windowsHide:true,env:{...process.env,...batch.env}})
 if(build.status!==0)throw Error(`IPC proxy build failed: ${build.status}`)
 fs.mkdirSync(destination,{recursive:true})
 const sha256=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
 const files={}
 for(const name of ['opsipc.dll','opsnt.dll']){fs.copyFileSync(path.join(scratch,name),path.join(destination,name));files[name]=sha256(path.join(destination,name))}
 const sources={}
 for(const name of ['security.h','opsipc.cpp','opsnt.cpp'])sources[name]=sha256(path.join(root,'native/bash-ipc',name))
 fs.writeFileSync(path.join(destination,'provenance.json'),JSON.stringify({version:1,platform:'win32-x64',source:'native/bash-ipc (original MIT)',sources,msysSha256:sha256(source),files},null,2)+'\n')
 console.log('Built and staged Windows Bash IPC compatibility proxies.')
} finally {fs.rmSync(scratch,{recursive:true,force:true})}
