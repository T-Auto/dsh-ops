/** Installation-relative, verified private MSYS runtime for confined Windows calls.
 * Original payloads remain untouched. Full access does not select this runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { patchMsys } from './bash-pe.js'
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const cache=new Map()
export function confinedBash(file, {home=process.env.DSH_HOME ?? path.join(os.homedir(),'.dsh'), platform=process.platform}={}) {
  if(platform!=='win32')return {file}
  // Resolve both PortableGit's bin wrapper and its real usr/bin executable.
  const directory=path.dirname(file)
  const root=path.basename(directory).toLowerCase()==='bin' && path.basename(path.dirname(directory)).toLowerCase()==='usr'
    ? path.resolve(directory,'../..') : path.resolve(directory,'..')
  const dll=path.join(root,'usr/bin/msys-2.0.dll')
  if(!fs.existsSync(dll))throw Error('EXECUTOR_UNAVAILABLE: Windows confined Bash requires the supported MSYS payload layout; no unconfined fallback.')
  const bytes=fs.readFileSync(dll)
  const proxies=path.join(packageRoot,'runtime/win32-x64/bash-ipc')
  const receipt=JSON.parse(fs.readFileSync(path.join(proxies,'provenance.json'),'utf8'))
  if(receipt.platform!=='win32-x64'||receipt.msysSha256!==hash(bytes))throw Error('EXECUTOR_UNAVAILABLE: This MSYS version has no verified DSH IPC compatibility build. Rebuild the matching proxies; do not bypass confinement.')
  const proxyBytes={}
  for(const name of ['opsipc.dll','opsnt.dll']){
    proxyBytes[name]=fs.readFileSync(path.join(proxies,name))
    if(hash(proxyBytes[name])!==receipt.files[name])throw Error(`Bash IPC provenance mismatch: ${name}`)
  }
  const identity=hash(Buffer.from(JSON.stringify({root,msys:receipt.msysSha256,files:receipt.files}))).slice(0,24)
  const target=path.join(home,'dsh-ops/bash-ipc',identity)
  const selected=path.join(target,'usr/bin/bash.exe')
  const key=path.resolve(target)
  if(cache.has(key)) {
    const value=cache.get(key)
    if(hash(fs.readFileSync(path.join(target,'usr/bin/msys-2.0.dll')))!==hash(patchMsys(bytes).bytes) ||
      !['opsipc.dll','opsnt.dll'].every(name=>hash(fs.readFileSync(path.join(target,'usr/bin',name)))===receipt.files[name])) {
      throw Error('Bash IPC cached runtime integrity mismatch; refusing execution.')
    }
    return value
  }
  const patched=patchMsys(bytes).bytes
  const marker=path.join(target,'.ops-ipc.json')
  let valid=false
  try {
    const saved=JSON.parse(fs.readFileSync(marker,'utf8'))
    valid=saved.identity===identity && fs.existsSync(selected) && hash(fs.readFileSync(path.join(target,'usr/bin/msys-2.0.dll')))===hash(patched) &&
      ['opsipc.dll','opsnt.dll'].every(name=>hash(fs.readFileSync(path.join(target,'usr/bin',name)))===receipt.files[name])
  } catch {}
  if(!valid){
    // Never overwrite a possibly running generation. Failed incomplete builds
    // get a new staging directory and only complete copies are published.
    fs.mkdirSync(path.dirname(target),{recursive:true})
    const stage=fs.mkdtempSync(path.join(path.dirname(target),'stage-'))
    try {
      fs.cpSync(root,stage,{recursive:true,filter:source=>!['.git','node_modules'].includes(path.basename(source))})
      fs.writeFileSync(path.join(stage,'usr/bin/msys-2.0.dll'),patched)
      for(const [name,data] of Object.entries(proxyBytes))fs.writeFileSync(path.join(stage,'usr/bin',name),data)
      fs.writeFileSync(path.join(stage,'.ops-ipc.json'),JSON.stringify({identity,source:root,msys:receipt.msysSha256,patchedSha256:hash(patched),files:receipt.files})+'\n')
      if(fs.existsSync(target))throw Error('Bash IPC runtime integrity mismatch; refusing to overwrite an existing generation.')
      try {fs.renameSync(stage,target)} catch(error){if(!fs.existsSync(marker))throw error}
    } finally {fs.rmSync(stage,{recursive:true,force:true})}
  }
  const result={file:selected,env:{PATH:[path.join(target,'usr/bin'),path.join(target,'ucrt64/bin'),path.join(target,'cmd'),process.env.PATH??''].join(path.delimiter)},runtime:identity}
  cache.set(key,result)
  return result
}
