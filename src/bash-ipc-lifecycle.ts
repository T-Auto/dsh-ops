/** Conservative cache lifecycle. All cooperating readers/writers hold the same lock.
 * Unknown/legacy users and orphaned leases are NOT proven idle by a successful rename or dead PID.
 * No automatic lock stealing: after a crash an operator must stop all shells before removing it.
 * This protects cooperating processes, not hostile same-user filesystem replacement races. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const GENERATION_NAME=/^[a-f0-9]{24}$/
export const RETIRED_NAME=/^[a-f0-9]{24}\.stale-[a-z0-9]+$/
export const QUARANTINE_NAME=/^[a-f0-9]{24}\.bad-[a-z0-9]+$/
const POLICY='.ops-lifecycle.json'
const LEASES='.ops-leases'
const token=randomUUID()
const held=new Set<string>()

/** Check every existing component with lstat: includes Windows junctions, not just POSIX links. */
export function noLinks(target: string): boolean {
  const resolved=path.resolve(target), root=path.parse(resolved).root
  let current=root
  for(const component of resolved.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,component)
    try{ if(fs.lstatSync(current).isSymbolicLink())return false }
    catch(error){ if((error as NodeJS.ErrnoException).code==='ENOENT')return true; return false }
  }
  return true
}
export function assertNoLinks(target: string): void {
  if(!noLinks(target))throw Error('Bash IPC refuses a symlink/junction cache or payload path: '+target)
}
export function plainDirectory(target: string): boolean {
  try{return noLinks(target)&&fs.lstatSync(target).isDirectory()}catch{return false}
}
/** Check the entire tree before recursive copy, verification or removal. Never traverse a link. */
export function plainTree(target: string): boolean {
  if(!plainDirectory(target))return false
  try{
    for(const entry of fs.readdirSync(target,{withFileTypes:true})){
      const child=path.join(target,entry.name), stat=fs.lstatSync(child)
      if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))return false
      if(stat.isDirectory()&&!plainTree(child))return false
    }
    return true
  }catch{return false}
}
export function withLifecycleLock<T>(root: string, run: ()=>T): T {
  assertNoLinks(root)
  fs.mkdirSync(root,{recursive:true})
  const lock=path.join(root,'.ops-lifecycle-lock')
  if(held.has(path.resolve(root)))return run()
  // Bounded wait, no lease expiry: a suspended process must never lose its lock.
  let acquired=false
  for(let attempt=0;attempt<101;attempt++){
    try{fs.mkdirSync(lock); acquired=true; break}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
      assertNoLinks(lock)
      if(attempt<100)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)
    }
  }
  if(!acquired)throw Error('Bash IPC lifecycle lock is busy or left by an interrupted process: '+lock+'. Stop all confined shells before manually removing an abandoned lock; no unsafe lock stealing.')
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,token})+'\n',{flag:'wx'})
  held.add(path.resolve(root))
  try{return run()}finally{held.delete(path.resolve(root)); fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock)}
}
/** Explicit operator-only recovery, after stopping every host and confined descendant. */
export function recoverBashLifecycleLock(root: string, {confirmedStopped=false}: {confirmedStopped?: boolean}={}): void {
  if(!confirmedStopped)throw Error('Stopping all hosts and confined shells must be confirmed')
  assertNoLinks(root)
  const lock=path.join(root,'.ops-lifecycle-lock')
  assertNoLinks(lock)
  const owner=path.join(lock,'owner.json')
  assertNoLinks(owner)
  try{
    const pid=JSON.parse(fs.readFileSync(owner,'utf8')).pid
    if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid Bash IPC lifecycle lock owner; inspect manually')
    try{process.kill(pid,0);throw Error('Bash IPC lifecycle lock owner is still alive')}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}
    fs.unlinkSync(owner)
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  try{fs.rmdirSync(lock)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
}
export function markManaged(directory: string): void {
  fs.writeFileSync(path.join(directory,POLICY),JSON.stringify({version:1})+'\n',{flag:'wx'})
}
/** Only new managed, never-leased trees are automatically idle. Leases intentionally persist:
 * killing/exiting a host does not prove its shell descendants have exited. Manual cleanup requires
 * stopping ALL confined shells. This fail-safe policy can exceed the usual two-generation bound. */
export function idleGeneration(directory: string): boolean {
  if(!plainTree(directory))return false
  try{
    if(JSON.parse(fs.readFileSync(path.join(directory,POLICY),'utf8')).version!==1)return false
    return !fs.existsSync(path.join(directory,LEASES))
  }catch{return false}
}
/** Offline assertions must not override contradictory evidence of a live lease owner. */
export function hasLiveLease(directory: string): boolean {
  const leases=path.join(directory,LEASES)
  if(!fs.existsSync(leases))return false
  if(!plainDirectory(leases))return true
  try{
    for(const name of fs.readdirSync(leases)){
      const file=path.join(leases,name)
      if(!noLinks(file))return true
      const pid=JSON.parse(fs.readFileSync(file,'utf8')).pid
      if(!Number.isSafeInteger(pid)||pid<1)return true
      try{process.kill(pid,0);return true}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return true}
    }
    return false
  }catch{return true}
}
export function leaseGeneration(directory: string): void {
  assertNoLinks(directory)
  const leases=path.join(directory,LEASES)
  assertNoLinks(leases)
  fs.mkdirSync(leases,{recursive:true})
  const lease=path.join(leases,process.pid+'-'+token+'.json')
  if(!fs.existsSync(lease))fs.writeFileSync(lease,JSON.stringify({pid:process.pid,token})+'\n',{flag:'wx'})
}
