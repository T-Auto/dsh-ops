/** Installation-relative, verified private MSYS runtime for confined Windows calls.
 * Original payloads remain untouched. Full access does not select this runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
export { recoverBashLifecycleLock } from './bash-ipc-lifecycle.js'
import { errorMessage } from './shells/types.js'
import { bashRuntimeFailure } from './bash-runtime-failure.js'
import { patchMsys } from './bash-pe.js'
import { GENERATION_NAME, RETIRED_NAME, QUARANTINE_NAME, noLinks, assertNoLinks, plainDirectory, plainTree, withLifecycleLock, idleGeneration, markManaged, leaseGeneration, hasLiveLease } from './bash-ipc-lifecycle.js'
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const hash=(bytes: Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
interface Runtime { file: string; env?: NodeJS.ProcessEnv; runtime?: string }
interface TreeEntry { size: number; mtimeMs: number; sha256?: string }
interface Receipt { platform?: unknown; msysSha256?: unknown; files?: unknown }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const cache=new Map<string, Runtime>()
/** One identity-named generation. Anything else in the cache directory is debris with its own lifetime. */

/** Cleanup is rate-limited, but never disabled permanently after a retained/failed sweep. */
const swept=new Map<string,number>()
function maybeReclaim(root: string, identity: string): void {
  const key=root+'|'+identity,now=Date.now()
  if(now-(swept.get(key)??0)<60_000)return
  swept.set(key,now)
  try{reclaimBashGenerations(root,identity)}catch(error){console.error('dsh-ops: cache cleanup failed: '+errorMessage(error))}
}

/** The directory confined Windows Bash generations live in. */
export const bashIpcRoot=(home: string): string=>path.join(home,'dsh-ops','bash-ipc')
/** How long an interrupted `stage-*` tree is left alone before a sweep may remove it.
 *  A cooperating staging process holds the lifecycle lock, so nothing can be staging while a sweep
 *  runs; the age bound keeps even a crashed sibling's tree untouched for a while (#512). */
export const STAGING_TTL_MS=60*60*1000
const proxies=path.join(packageRoot,'runtime/win32-x64/bash-ipc')
const SOURCES: Record<string, string>={config:'configured bashPath',path:'system bash on PATH','well-known':'system Git for Windows install',bundled:'bundled bash',provisioned:'provisioned bash'}
// Resolve both PortableGit's bin wrapper and its real usr/bin executable.
function msysRoot(file: string) {
  const directory=path.dirname(file)
  return path.basename(directory).toLowerCase()==='bin' && path.basename(path.dirname(directory)).toLowerCase()==='usr'
    ? path.resolve(directory,'../..') : path.resolve(directory,'..')
}
/** The one actionable explanation for a bash that restricted modes cannot run (#42). */
export function restrictedRemedy(file: string, source: string | undefined, why: string) {
  const label=source !== undefined && SOURCES[source] ? `${SOURCES[source]} ` : ''
  return `EXECUTOR_UNAVAILABLE: ops_bash cannot run the ${label}${file} in restricted modes (read-only / workspace-write): ${why} `
    +'By design, restricted modes run only the pinned MSYS whose DSH IPC compatibility proxies were verified; this is not a user authorization denial. '
    +'A custom bashPath or system Git for Windows works only in danger-full-access. '
    +'Next steps: remove bashPath (and allowSystemShellFallback) so the bundled or provisioned pinned bash is used (`dsh-ops provision-shells --bash` if it is missing), '
    +'or ask the user to switch the session to danger-full-access. Approvals never repair an incompatible confined runtime; do not bypass confinement.'
}
/** Whether restricted modes can run this bash, without copying or building anything. */
export function restrictedCompatibility(file: string, {platform=process.platform}: { platform?: NodeJS.Platform }={}) {
  if(platform!=='win32')return {compatible:true,reason:'no MSYS IPC compatibility layer is needed on this platform'}
  const dll=path.join(msysRoot(file),'usr/bin/msys-2.0.dll')
  if(!fs.existsSync(dll))return {compatible:false,reason:`it has no usr/bin/msys-2.0.dll beside it (${dll}), which is not the supported MSYS payload layout.`}
  let receipt: Receipt
  try { receipt=JSON.parse(fs.readFileSync(path.join(proxies,'provenance.json'),'utf8')) as Receipt }
  catch { return {compatible:false,reason:'this dsh-ops installation carries no Bash IPC compatibility receipt (runtime/win32-x64/bash-ipc/provenance.json).'} }
  const msysSha256=hash(fs.readFileSync(dll))
  if(receipt.platform==='win32-x64' && receipt.msysSha256===msysSha256)return {compatible:true,reason:'its msys-2.0.dll matches the pinned MSYS build',msysSha256,expectedSha256:receipt.msysSha256}
  return {compatible:false,msysSha256,expectedSha256:receipt.msysSha256,
    reason:`its msys-2.0.dll (sha256 ${msysSha256.slice(0,12)}…) is not the pinned build (${String(receipt.msysSha256).slice(0,12)}…).`}
}
/** The directories this runtime puts on the child's PATH — what an attacker would target. */
const PATH_DIRS=['usr/bin','ucrt64/bin','cmd']
/** Per-call PATH for the verified private MSYS tree. */
export function privateRuntimePath(target: string, inheritedPath = process.env.PATH ?? '') {
  return [path.join(target,'usr/bin'), ...inheritedPath.split(path.delimiter).filter(Boolean),
    path.join(target,'ucrt64/bin'),path.join(target,'cmd')].join(path.delimiter)
}
/** Relative-path → `{sha256, size, mtimeMs}` for every file under {@link PATH_DIRS}.
 *  `bash.exe` and the DLLs are verified individually; this covers the rest of what the child can
 *  actually execute, so swapping `cmd/git.exe` — which the PATH exposes and the child will
 *  resolve — is caught too, not only the two or three files a receipt names.
 *  Records size/mtime as well as the digest, so {@link treeMatches} can re-check the whole tree
 *  with one `stat` per file instead of re-reading ~174 MB on every command. */
function treeDigest(base: string,withHash=true){
  assertNoLinks(base)
  const out: Record<string, TreeEntry>={}
  const walk=(rel: string)=>{
    let entries
    assertNoLinks(path.join(base,rel))
    try{entries=fs.readdirSync(path.join(base,rel),{withFileTypes:true})}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    for(const e of entries.sort((a,b)=>a.name<b.name?-1:1)){
      const next=rel===''?e.name:`${rel}/${e.name}`
      assertNoLinks(path.join(base,next))
      if(e.isDirectory())walk(next)
      else if(e.isFile()){
        const abs=path.join(base,next)
        let st
        try{st=fs.statSync(abs)}catch{return}
        out[next]={size:st.size,mtimeMs:st.mtimeMs,...(withHash?{sha256:hash(fs.readFileSync(abs))}:{})}
      }
    }
  }
  for(const dir of PATH_DIRS)walk(dir)
  return out
}
/** Cheap re-check against a manifest recorded at staging time. **Stats only — reads no file
 *  contents**, so it costs one `stat` per file instead of a full digest pass. It sits on the
 *  per-command path (`confinedBash` is called from the bash tool's `execute`), which is why it
 *  must stay cheap. See the module note in `confinedBash` for what this does and does not buy. */
function treeMatches(base: string,expected: unknown){
  if(!record(expected))return false
  const names=Object.keys(expected)
  if(names.length===0)return false
  let actual: Record<string, TreeEntry>
  try{actual=treeDigest(base,false)}catch{return false}
  if(names.length!==Object.keys(actual).length)return false
  return names.every(name=>{
    const want=expected[name],got=actual[name]
    return got!==undefined&&record(want)&&want.size===got.size&&want.mtimeMs===got.mtimeMs
  })
}
/** Per-source-tree memo. Everything derived from the **source** payload — the MSYS bytes, their
 *  digest, the patched result and its digest, the proxy bytes, the receipt and the generation id —
 *  depends only on files that do not change while the plugin runs, yet the code used to re-read and
 *  re-hash ~3.4 MB on **every** confined-bash call (a 44% tax on the hot path).
 *  Keyed by source root and revalidated against **everything the snapshot holds** — the MSYS DLL,
 *  `provenance.json`, and both IPC proxies — not just the DLL. ⚠️ An earlier revision keyed on the
 *  DLL alone, so rewriting the receipt or either proxy was ignored **without even preserving size
 *  and mtime**; worse, once the package was upgraded, a long-lived process going
 *  quarantine → rebuild would write the old snapshot's proxy bytes back into the cache and
 *  never self-heal.
 *  ⚠️ Consequence, stated rather than implied: if a source file is rewritten with its size and mtime
 *  preserved, this memo will not re-check it. That path was never a boundary either — the source
 *  tree lives under the profile's `node_modules`, with the same owner as the cache. */
interface SourceState { key: string; bytes: Buffer; receipt: Receipt & { files: Record<string, unknown> }; proxyBytes: Record<string, Buffer>; patched: Buffer; patchedSha: string; bashSha: string; identity: string; payload: Record<string, TreeEntry> }
const sourceMemo=new Map<string, SourceState>()
/** `size:mtimeMs` for a file, or `absent` — absence is part of the key, not an error. */
const statKey = (file: string) => { try { const s=fs.statSync(file); return `${s.size}:${s.mtimeMs}` } catch { return 'absent' } }
function sourceState(root: string, dll: string): SourceState{
  assertNoLinks(root)
  let st
  try{st=fs.statSync(dll)}catch{
    // A missing payload layout cannot be repaired by another call, so the stage is named and retrying is not advised (#512).
    throw bashRuntimeFailure('bash-runtime-missing','Windows confined Bash requires the supported MSYS payload layout and its usr/bin/msys-2.0.dll; no unconfined fallback')
  }
  const bashFile=path.join(root,'usr/bin/bash.exe')
  const inventory=treeDigest(root,false)
  const key=JSON.stringify(inventory)+'|'+[dll,bashFile,path.join(proxies,'provenance.json'),path.join(proxies,'opsipc.dll'),path.join(proxies,'opsnt.dll')].map(statKey).join('|')
  const cached=sourceMemo.get(root)
  if(cached!==undefined&&cached.key===key)return cached
  const bytes=fs.readFileSync(dll)
  const receipt=JSON.parse(fs.readFileSync(path.join(proxies,'provenance.json'),'utf8')) as Receipt as Receipt
  if(receipt.platform!=='win32-x64'||receipt.msysSha256!==hash(bytes)||!record(receipt.files))throw bashRuntimeFailure('bash-ipc-mismatch','This MSYS version has no verified DSH IPC compatibility build; rebuild the matching proxies and do not bypass confinement')
  const proxyBytes: Record<string, Buffer>={}
  for(const name of ['opsipc.dll','opsnt.dll']){
    proxyBytes[name]=fs.readFileSync(path.join(proxies,name))
    if(hash(proxyBytes[name])!==receipt.files[name])throw bashRuntimeFailure('bash-ipc-mismatch',`Bash IPC provenance mismatch: ${name}`)
  }
  const patched=patchMsys(bytes).bytes
  // The identity is what the generation *is*, never where it was staged from: two profiles (or two
  // machines with the same payload) share one generation, and an upgraded payload gets a new one.
  // Every verified byte is in the key — the patched MSYS, both IPC proxies and the bash executable —
  // so reusing a sibling is only possible when the confined shell would run identical bytes.
  const files=Object.fromEntries(Object.entries(receipt.files).sort(([a],[b])=>a<b?-1:a>b?1:0))
  const bashSha=hash(fs.readFileSync(bashFile))
  const patchedSha=hash(patched)
  const payload=treeDigest(root)
  const payloadIdentity=Object.fromEntries(Object.entries(payload).map(([name,value])=>[name,{size:value.size,sha256:value.sha256}]))
  const state: SourceState={key,bytes,receipt: { ...receipt, files: receipt.files },proxyBytes,patched,
    patchedSha,bashSha,payload,
    identity:hash(Buffer.from(JSON.stringify({msys:receipt.msysSha256,files,bash:bashSha,patched:patchedSha,payload:payloadIdentity}))).slice(0,24)}
  sourceMemo.set(root,state)
  return state
}
/** How long a directory rename keeps being retried, and how long to wait between attempts.
 *  Cumulative budget is 2.5 s, deliberately above the window measured in #352: on Windows 11 26100
 *  the same rename that raises `EPERM` at +2 ms was observed to succeed only at +1639 ms,
 *  including from another process, with real-time antivirus off. A first 1.5 s budget covered the
 *  typical ~1.5 s recovery but sat just below that worst sample; the extra 1 s step covers it
 *  without waiting forever. Only sharing/ownership errors are retried — a permission that will
 *  never change still surfaces after the last delay. */
export const RENAME_RETRY_DELAYS_MS: readonly number[]=[100,200,400,800,1000]
const RETRYABLE_RENAME_CODES: ReadonlySet<string>=new Set(['EPERM','EBUSY','EACCES'])
/** A blocking sleep, so the retry does not turn the per-command path asynchronous. */
const sleepSync=(ms: number): void=>{ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms) }
/** Rename a directory, tolerating the brief window in which Windows still holds the freshly written
 *  tree. Without this, a recovering cache fails on the first `EPERM` and reports "could not be
 *  quarantined" for a condition that is gone a moment later (#352).
 *
 *  `rename` and `wait` are injectable so a test can make the failure deterministic and assert the
 *  bound instead of sleeping on a real 2.5 s window. */
export function renameWithRetry(from: string, to: string, {
  rename=(source: string,destination: string): void=>{ fs.renameSync(source,destination) },
  delays=RENAME_RETRY_DELAYS_MS,
  wait=sleepSync,
}: { rename?: (from: string,to: string)=>void; delays?: readonly number[]; wait?: (ms: number)=>void }={}): void {
  for(let attempt=0;;attempt+=1){
    try{ rename(from,to); return }catch(error){
      const code=(error as NodeJS.ErrnoException).code
      if(attempt>=delays.length||code===undefined||!RETRYABLE_RENAME_CODES.has(code))throw error
      wait(delays[attempt])
    }
  }
}
/** Move one unverifiable generation aside, keeping the two most recent quarantines.
 *
 *  Renaming keeps a generation that may still belong to a running process intact, and gives the next
 *  attempt somewhere to stage into. The rename is retried by {@link renameWithRetry}; `rename` is
 *  injectable so the retry can be asserted with a deterministic transient failure rather than by
 *  waiting on a real Windows sharing window (#352). */
export function quarantineGeneration(target: string, {rename}: { rename?: (from: string,to: string)=>void }={}): string {
  if(!plainTree(target)||!idleGeneration(target))throw Error('Bash IPC refuses to quarantine a linked, legacy or leased generation; stop all confined shells and remove it manually.')
  const quarantine=`${target}.bad-${Date.now().toString(36)}`
  renameWithRetry(target,quarantine,{rename})
  // Quarantines are retained: rename success never proves an old runtime is unused.
  console.error(`dsh-ops: quarantined an unverifiable bash runtime generation at ${quarantine}; staging a fresh one. Delete it once no confined shell is running.`)
  return quarantine
}

/** A directory under `<DSH_HOME>/dsh-ops/bash-ipc` and what it costs on disk. */
export interface BashIpcEntry {
  name: string
  kind: 'generation' | 'quarantine' | 'staging' | 'retired' | 'other'
  bytes: number
  files: number
  mtimeMs: number
  current: boolean
}
/** The cache as an operator report: every entry, the verified bytes, and what the next sweep may drop. */
export interface BashIpcInventory {
  root: string
  current: string | null
  generations: number
  entries: BashIpcEntry[]
  totalBytes: number
  reclaimableBytes: number
}
/** Sizes of one tree without following links out of it; an unreadable entry is simply absent. */
function directoryUsage(directory: string): { bytes: number; files: number } {
  let bytes=0,files=0
  const walk=(dir: string)=>{
    let entries
    try{ entries=fs.readdirSync(dir,{withFileTypes:true}) }catch{ return }
    for(const entry of entries){
      const target=path.join(dir,entry.name)
      if(entry.isDirectory()&&plainDirectory(target)) walk(target)
      else if(entry.isFile()||entry.isSymbolicLink()){
        try{ const stat=fs.lstatSync(target); files+=1; bytes+=stat.size }catch{ /* raced with a sweep */ }
      }
    }
  }
  if(plainDirectory(directory))walk(directory)
  return {bytes,files}
}
/**
 * Read the Bash IPC cache without changing it. This is the discoverability the issue came from:
 * an upgrade used to grow the directory silently and neither `bash-runtime status` nor
 * `ladder` mentioned it.
 *
 * `current` is the identity this deployment would use, when it can be computed; all generations
 * except the one retained for the previous deployment are reclaimable.
 */
export function bashIpcInventory({home=process.env.DSH_HOME ?? path.join(os.homedir(),'.dsh'), current=null,
  stagingTtlMs=STAGING_TTL_MS, now=Date.now}: { home?: string; current?: string | null; stagingTtlMs?: number; now?: ()=>number }={}): BashIpcInventory {
  const root=bashIpcRoot(home)
  let names: string[]=[]
  try{ if(noLinks(root))names=fs.readdirSync(root) }catch{ /* a missing cache is an empty one */ }
  const entries: BashIpcEntry[]=[]
  for(const name of names){
    const target=path.join(root,name)
    let stat
    try{ stat=fs.lstatSync(target) }catch{ continue }
    if(!stat.isDirectory()) continue
    const kind: BashIpcEntry['kind']=GENERATION_NAME.test(name) ? 'generation'
      : QUARANTINE_NAME.test(name) ? 'quarantine'
        : RETIRED_NAME.test(name) ? 'retired'
          : name.startsWith('stage-') ? 'staging' : 'other'
    const usage=directoryUsage(target)
    entries.push({name,kind,bytes:usage.bytes,files:usage.files,mtimeMs:stat.mtimeMs,current:name===current})
  }
  entries.sort((a,b)=>b.mtimeMs-a.mtimeMs||(a.name<b.name?-1:1))
  const stale=entries.filter(entry=>entry.kind==='generation'&&!entry.current)
  // An interrupted staging tree is reclaimable by age alone: it carries no published manifest and
  // no lease, and the sweep that removes it runs under the lifecycle lock (#512).
  const staleStaging=entries.filter(entry=>entry.kind==='staging'
    && now()-entry.mtimeMs>=Math.max(0,stagingTtlMs) && plainTree(path.join(root,entry.name)))
  // One previous generation is retained on purpose: a second profile or a process that is still
  // running the old payload may need it, and a directory that cannot be moved aside is kept.
  const reclaimable=[
    ...[...stale.slice(1),...entries.filter(entry=>entry.kind==='retired')].filter(entry=>idleGeneration(path.join(root,entry.name))),
    ...staleStaging,
  ]
  return {
    root, current,
    generations: entries.filter(entry=>entry.kind==='generation').length,
    entries,
    totalBytes: entries.reduce((sum,entry)=>sum+entry.bytes,0),
    reclaimableBytes: reclaimable.reduce((sum,entry)=>sum+entry.bytes,0),
  }
}
/** What a sweep removes: generation names (not paths), kept names, and the bytes freed. */
export interface BashIpcReclaimResult { removed: string[]; kept: string[]; bytes: number }
/**
 * Retire every generation beyond the current one and one retained predecessor.
 *
 * Only managed, never-leased trees are automatically eligible. Leased/legacy trees are retained:
 * neither a successful rename nor host PID exit proves a shell descendant has finished.
 * Offline confirmedStopped cleanup is an explicit operator assertion covering ALL hosts and shells.
 * Even then, unmarked/linked trees are not removed. Rename failures always preserve the source.
 *
 * `retain` and the filesystem calls are injectable so the bound can be asserted without a real
 * 412 MB payload, and without waiting for Windows to release a directory.
 */
export function reclaimBashGenerations(root: string, current: string, {
  retain=1, confirmedStopped=false, dryRun=false, stagingTtlMs=STAGING_TTL_MS,
  rename=(from: string,to: string): void=>{ fs.renameSync(from,to) },
  remove=(target: string): void=>{ fs.rmSync(target,{recursive:true,force:true}) },
  now=Date.now,
  log=(message: string)=>console.error(message),
}: { retain?: number; confirmedStopped?: boolean; dryRun?: boolean; stagingTtlMs?: number; rename?: (from: string,to: string)=>void; remove?: (target: string)=>void; now?: ()=>number; log?: (message: string)=>void }={}): BashIpcReclaimResult {
  assertNoLinks(root)
  if(!fs.existsSync(root))return {removed:[],kept:[],bytes:0}
  const run=()=>{
  const result: BashIpcReclaimResult={removed:[],kept:[],bytes:0}
  let entries
  try{ entries=fs.readdirSync(root,{withFileTypes:true}) }catch{ return result }
  const generations=entries.filter(entry=>entry.isDirectory()&&GENERATION_NAME.test(entry.name)&&entry.name!==current)
    .map(entry=>{
      let mtimeMs=0
      try{ mtimeMs=fs.lstatSync(path.join(root,entry.name)).mtimeMs }catch{ /* raced with a sweep */ }
      return {name:entry.name,mtimeMs}
    })
    .sort((a,b)=>b.mtimeMs-a.mtimeMs||(a.name<b.name?-1:1))
  const eligible=(directory: string)=>{
    if(idleGeneration(directory))return true
    if(!confirmedStopped||!plainTree(directory)||hasLiveLease(directory))return false
    try{const m=JSON.parse(fs.readFileSync(path.join(directory,'.ops-ipc.json'),'utf8'));return record(m)&&typeof m.identity==='string'&&GENERATION_NAME.test(m.identity)&&record(m.files)&&record(m.tree)}catch{return false}
  }
  const budget=Math.max(0,retain)
  result.kept.push(...generations.slice(0,budget).map(entry=>entry.name))
  for(const entry of generations.slice(budget)){
    const source=path.join(root,entry.name), retired=`${source}.stale-${now().toString(36)}`
    if(!eligible(source)){result.kept.push(entry.name);continue}
    const usage=directoryUsage(source)
    if(dryRun){result.removed.push(entry.name);result.bytes+=usage.bytes;continue}
    try{ rename(source,retired) }catch{ result.kept.push(entry.name); continue }
    try{
      remove(retired)
      result.removed.push(entry.name)
      result.bytes+=usage.bytes
      log(`dsh-ops: reclaimed an older bash runtime generation: ${entry.name} (${(usage.bytes/1048576).toFixed(0)} MB)`)
    }catch{
      // Renamed but not deleted: the next sweep retries the `.stale-` directory.
      result.kept.push(entry.name)
    }
  }
  // Sweeps interrupted between rename and delete leave a full generation behind; finish those too.
  for(const entry of entries){
    if(!entry.isDirectory()||!RETIRED_NAME.test(entry.name)) continue
    const retired=path.join(root,entry.name)
    if(!eligible(retired))continue
    const usage=directoryUsage(retired)
    if(dryRun){result.removed.push(entry.name);result.bytes+=usage.bytes;continue}
    try{ remove(retired);result.removed.push(entry.name);result.bytes+=usage.bytes }catch{ /* still held; a later sweep retries */ }
  }
  // Interrupted staging copies: a host killed mid-copy leaves a partial `stage-*` tree with no
  // owner. Cooperating processes hold the lifecycle lock while they stage, so nothing this sweep
  // can see is staging; the TTL still protects a crashed sibling's tree for a bounded time (#512).
  const stageCutoff=now()-Math.max(0,stagingTtlMs)
  for(const entry of entries){
    if(!entry.isDirectory()||!entry.name.startsWith('stage-')) continue
    const staging=path.join(root,entry.name)
    let mtimeMs=0
    try{ mtimeMs=fs.lstatSync(staging).mtimeMs }catch{ continue }
    if(mtimeMs>stageCutoff)continue
    if(!plainTree(staging))continue
    const usage=directoryUsage(staging)
    if(dryRun){result.removed.push(entry.name);result.bytes+=usage.bytes;continue}
    try{
      remove(staging);result.removed.push(entry.name);result.bytes+=usage.bytes
      log(`dsh-ops: removed an interrupted bash runtime staging copy: ${entry.name} (${(usage.bytes/1048576).toFixed(0)} MB)`)
    }catch{ /* held by a scanner; a later sweep retries */ }
  }
  return result
  }
  return dryRun ? run() : withLifecycleLock(root,run)
}
/**
 * The identity this deployment would stage, without staging it. Reading and patching the pinned
 * payload is safe and writes nothing; any failure means "unknown", never a cache creation.
 */
export function currentBashIpcIdentity(file: string | undefined, {platform=process.platform}: { platform?: NodeJS.Platform }={}): string | null {
  if(platform!=='win32'||typeof file!=='string')return null
  const root=msysRoot(file)
  try{ return sourceState(root,path.join(root,'usr/bin/msys-2.0.dll')).identity }catch{ return null }
}
/** The inventory plus the identity of the resolved bash, for the CLI reports. */
export function bashIpcReport(file: string | undefined, {home, platform=process.platform, stagingTtlMs, now}: { home?: string; platform?: NodeJS.Platform; stagingTtlMs?: number; now?: ()=>number }={}): BashIpcInventory {
  return bashIpcInventory({home,current:currentBashIpcIdentity(file,{platform}),
    ...(stagingTtlMs!==undefined?{stagingTtlMs}:{}),...(now!==undefined?{now}:{})})
}
/** @param {string} file
 * @param {{home?: string, platform?: NodeJS.Platform, source?: string}} options */
export function confinedBash(file: string, {home=process.env.DSH_HOME ?? path.join(os.homedir(),'.dsh'), platform=process.platform, source}: { home?: string; platform?: NodeJS.Platform; source?: string }={}): Runtime {
  if(platform!=='win32')return {file}
  const root=msysRoot(file)
  const check=restrictedCompatibility(file,{platform})
  if(!check.compatible)throw bashRuntimeFailure('bash-runtime-incompatible',restrictedRemedy(file,source,check.reason))
  const {receipt,proxyBytes,patched,patchedSha,bashSha,identity,payload}=sourceState(root,path.join(root,'usr/bin/msys-2.0.dll'))
  const cacheDir=bashIpcRoot(home)
  return withLifecycleLock(cacheDir,()=>{
  const target=path.join(cacheDir,identity)
  assertNoLinks(target)
  const selected=path.join(target,'usr/bin/bash.exe')
  const key=path.resolve(target)
  const marker=path.join(target,'.ops-ipc.json')
  const readMarker = (): unknown => { try { return JSON.parse(fs.readFileSync(marker,'utf8')) } catch { return null } }
  /**
   * One judgement, used by **both** the cached and the cold path.
   *
   * What each part actually buys — stated precisely, because an earlier revision overclaimed and a
   * later one **over-trimmed** while "unifying" the two paths (a review caught a tampered
   * `opsipc.dll` sailing through on both):
   *
   *  · **Two in-package pinned constants**: the two IPC proxies against `receipt.files`, which the
   *    cache directory cannot rewrite. This is the part of the check that resists someone who can
   *    write the cache.
   *  · **Two in-domain consistency checks**: the patched MSYS runtime against `patchMsys`'s output,
   *    and `bash.exe` against the source payload. ⚠️ These compare cache-versus-source, and the
   *    source tree (`<profile>\node_modules\@dsh-ops\bash-win32-x64`) is **writable by the same
   *    user** — so they catch an accidental or half-finished breakage that can then rebuild, not a
   *    deliberate rewrite of both sides. There is no expected digest for `bash.exe` anywhere.
   *  · **The recorded manifest, compared by stat**: `.ops-ipc.json` sits beside the files it
   *    describes, same owner, no MAC — so whoever can rewrite a payload can rewrite it to match.
   *    That half catches *accidental* drift (a restore, a `touch`, a sync tool), nothing more.
   *
   * The two paths previously disagreed (cold compared sha256, hot only size+mtime), so a mere
   * timestamp drift passed cold and failed hot, landing in the recovery branch with no attacker
   * involved. Both now run this same function.
   */
  const generationIntact = (directory: string, m: unknown, adopting=false) => {
    if(!plainDirectory(directory))return false
    if(!record(m)||(!adopting&&m.payloadIdentity!==identity))return false
    if(adopting){
      const actual=treeDigest(directory)
      const expected={...payload,'usr/bin/msys-2.0.dll':{size:patched.length,mtimeMs:0,sha256:patchedSha},...Object.fromEntries(Object.entries(proxyBytes).map(([name,data])=>['usr/bin/'+name,{size:data.length,mtimeMs:0,sha256:hash(data)}]))}
      if(Object.keys(actual).length!==Object.keys(expected).length||!Object.entries(expected).every(([name,want])=>actual[name]?.sha256===want.sha256))return false
    }
    let msysOk
    try { msysOk = hash(fs.readFileSync(path.join(directory,'usr/bin/msys-2.0.dll'))) === patchedSha } catch { return false }
    if(!msysOk) return false
    try {
      if(hash(fs.readFileSync(path.join(directory,'usr/bin/bash.exe')))!==bashSha) return false
      for(const name of ['opsipc.dll','opsnt.dll']){
        if(hash(fs.readFileSync(path.join(directory,'usr/bin',name)))!==receipt.files[name]) return false
      }
    } catch { return false }
    return treeMatches(directory, record(m) ? m.tree : undefined)
  }
  let knownBad=false
  if(cache.has(key)) {
    if(generationIntact(target,readMarker())) { leaseGeneration(target);maybeReclaim(cacheDir,identity);return cache.get(key)! }
    // Not a throw. A cached-but-mismatched generation takes the same quarantine + staging path as a
    // cold miss; throwing here bricked bash for the lifetime of a long-lived host process.
    knownBad=true
    cache.delete(key)
  }
  /**
   * Adopt a generation staged by an older identity scheme (or by another profile path) instead of
   * copying the payload again. The identity used to include the source root, so the first run after
   * this change — and every profile that shares a payload — found no matching directory and staged
   * another full copy; the issue was exactly that accumulation. A candidate is only adopted when
   * every verified byte matches, and it is renamed into place, never rewritten.
   */
  const adopt = (): boolean => {
    let names: string[]
    try{ names=fs.readdirSync(cacheDir) }catch{ return false }
    for(const name of names){
      if(name===identity||!GENERATION_NAME.test(name)) continue
      const candidate=path.join(cacheDir,name)
      if(!idleGeneration(candidate))continue
      let m
      try{ m=JSON.parse(fs.readFileSync(path.join(candidate,'.ops-ipc.json'),'utf8')) }catch{ continue }
      if(!record(m)||typeof m.identity!=='string') continue
      const files=m.files
      if(m.msys!==receipt.msysSha256||m.patchedSha256!==patchedSha||!record(files)) continue
      if(!['opsipc.dll','opsnt.dll'].every(proxy=>files[proxy]===receipt.files[proxy])) continue
      if(!generationIntact(candidate,m,true)) continue
      // Rewrite the manifest before the rename: a crash then leaves a fully verifiable generation
      // under a stale name for the next sweep, never a renamed directory whose identity disagrees.
      try{ fs.writeFileSync(path.join(candidate,'.ops-ipc.json'),JSON.stringify({...m,identity,payloadIdentity:identity,source:root})+'\n') }catch{ continue }
      try{ renameWithRetry(candidate,target) }catch{ continue }
      console.error(`dsh-ops: adopted the existing bash runtime generation ${name} as ${identity}`)
      return true
    }
    return false
  }
  // One marker read and one judgement per call: a failed cache check already proved the generation
  // bad, so re-running the (expensive) judgement on the way to quarantine just doubles the work.
  const marker0=readMarker()
  let valid = !knownBad && fs.existsSync(selected) && record(marker0) && marker0.identity===identity && generationIntact(target,marker0)
  if(!valid && !fs.existsSync(target)){
    adopt()
    // Re-read after adoption (or another process publishing the same generation): the marker on
    // disk, not the one read before the rename, decides whether this call can use it.
    const fresh=readMarker()
    valid = fs.existsSync(selected) && record(fresh) && fresh.identity===identity && generationIntact(target,fresh)
  }
  if(!valid){
    // A generation that exists but does not verify is **quarantined, not overwritten**: it may
    // belong to a process that is still running. Renaming keeps that guarantee while giving the next
    // attempt somewhere to stage into — without this, one bad write bricks the bash tool permanently
    // (the previous code threw "refusing to overwrite an existing generation" on every later call,
    // with no way out and no recovery hint).
    if(fs.existsSync(target)){
      try{
        quarantineGeneration(target)
      }catch(error){
        // Recoverable only after the process still using the generation is gone, so the advice is not "retry now" (#512).
        throw bashRuntimeFailure('bash-generation-quarantine-failed',
          `the bash runtime at ${target} failed verification and could not be quarantined after retrying (${errorMessage(error)}); `
          +'a confined shell or another process may still be using it', { cause: error })
      }
    }
    // Failed incomplete builds get a new staging directory and only complete copies are published.
    fs.mkdirSync(cacheDir,{recursive:true})
    const stage=fs.mkdtempSync(path.join(cacheDir,'stage-'))
    try {
      if(!plainTree(root))throw Error('Bash IPC refuses symlink/junction payload trees')
      fs.cpSync(root,stage,{recursive:true,filter:name=>!['.git','node_modules'].includes(path.basename(name))})
      const copied=treeDigest(stage)
      if(Object.keys(copied).length!==Object.keys(payload).length||!Object.entries(payload).every(([name,value])=>copied[name]?.sha256===value.sha256))throw Error('Bash IPC source payload changed during staging; retry')
      fs.writeFileSync(path.join(stage,'usr/bin/msys-2.0.dll'),patched)
      for(const [name,data] of Object.entries(proxyBytes))fs.writeFileSync(path.join(stage,'usr/bin',name),data)
      // Stat-only manifest: `generationIntact` re-checks this tree with `stat`, so recording a
      // sha256 per file here bought nothing and cost a full 174 MB read on every staging.
      fs.writeFileSync(path.join(stage,'.ops-ipc.json'),JSON.stringify({identity,payloadIdentity:identity,source:root,msys:receipt.msysSha256,patchedSha256:patchedSha,files:receipt.files,tree:treeDigest(stage,false)})+'\n')
      markManaged(stage)
      try {renameWithRetry(stage,target)} catch(error){if(!fs.existsSync(marker))throw error}
    } catch(error){
      // Copy, verification and publication are one recoverable unit: a later call stages a fresh
      // copy by itself, so an interrupted staging must say so instead of claiming the runtime is
      // broken and telling the caller not to retry (#512).
      throw bashRuntimeFailure('bash-staging-failed',
        `the private restricted-Bash runtime was not published with a complete copy (${errorMessage(error)})`, { cause: error })
    } finally {
      // Cleanup must never replace the classified failure above with a Windows sharing error (#512).
      try {fs.rmSync(stage,{recursive:true,force:true})} catch(cleanupError){
        console.error(`dsh-ops: could not remove an interrupted staging copy ${stage}: ${errorMessage(cleanupError)}; a later sweep retries it`)
      }
    }
  }
  leaseGeneration(target)
  maybeReclaim(cacheDir,identity)
  const result={file:selected,env:{PATH:privateRuntimePath(target)},runtime:identity}
  cache.set(key,result)
  return result
  })
}
