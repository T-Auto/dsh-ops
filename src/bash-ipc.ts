/** Installation-relative, verified private MSYS runtime for confined Windows calls.
 * Original payloads remain untouched. Full access does not select this runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { errorMessage } from './shells/types.js'
import { patchMsys } from './bash-pe.js'
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const hash=(bytes: Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
interface Runtime { file: string; env?: NodeJS.ProcessEnv; runtime?: string }
interface TreeEntry { size: number; mtimeMs: number; sha256?: string }
interface Receipt { platform?: unknown; msysSha256?: unknown; files?: unknown }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const cache=new Map<string, Runtime>()
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
  const out: Record<string, TreeEntry>={}
  const walk=(rel: string)=>{
    let entries
    try{entries=fs.readdirSync(path.join(base,rel),{withFileTypes:true})}catch{return}
    for(const e of entries.sort((a,b)=>a.name<b.name?-1:1)){
      const next=rel===''?e.name:`${rel}/${e.name}`
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
  const actual=treeDigest(base,false)
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
interface SourceState { key: string; bytes: Buffer; receipt: Receipt & { files: Record<string, unknown> }; proxyBytes: Record<string, Buffer>; patched: Buffer; patchedSha: string; identity: string }
const sourceMemo=new Map<string, SourceState>()
/** `size:mtimeMs` for a file, or `absent` — absence is part of the key, not an error. */
const statKey = (file: string) => { try { const s=fs.statSync(file); return `${s.size}:${s.mtimeMs}` } catch { return 'absent' } }
function sourceState(root: string, dll: string): SourceState{
  let st
  try{st=fs.statSync(dll)}catch{
    throw Error('EXECUTOR_UNAVAILABLE: Windows confined Bash requires the supported MSYS payload layout; no unconfined fallback.')
  }
  const key=[dll,path.join(proxies,'provenance.json'),path.join(proxies,'opsipc.dll'),path.join(proxies,'opsnt.dll')].map(statKey).join('|')
  const cached=sourceMemo.get(root)
  if(cached!==undefined&&cached.key===key)return cached
  const bytes=fs.readFileSync(dll)
  const receipt=JSON.parse(fs.readFileSync(path.join(proxies,'provenance.json'),'utf8')) as Receipt as Receipt
  if(receipt.platform!=='win32-x64'||receipt.msysSha256!==hash(bytes)||!record(receipt.files))throw Error('EXECUTOR_UNAVAILABLE: This MSYS version has no verified DSH IPC compatibility build. Rebuild the matching proxies; do not bypass confinement.')
  const proxyBytes: Record<string, Buffer>={}
  for(const name of ['opsipc.dll','opsnt.dll']){
    proxyBytes[name]=fs.readFileSync(path.join(proxies,name))
    if(hash(proxyBytes[name])!==receipt.files[name])throw Error(`Bash IPC provenance mismatch: ${name}`)
  }
  const patched=patchMsys(bytes).bytes
  const state: SourceState={key,bytes,receipt: { ...receipt, files: receipt.files },proxyBytes,patched,
    patchedSha:hash(patched),
    identity:hash(Buffer.from(JSON.stringify({root,msys:receipt.msysSha256,files:receipt.files}))).slice(0,24)}
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
  const quarantine=`${target}.bad-${Date.now().toString(36)}`
  renameWithRetry(target,quarantine,{rename})
  // Keep the quarantine bounded: each generation is hundreds of MB, and a generation can go bad
  // for wholly mundane reasons (a restored backup, a `touch`, a sync tool rewriting mtimes).
  // Keep the two most recent and drop older ones.
  try{
    const parent=path.dirname(target), base=path.basename(target)
    const stale=fs.readdirSync(parent).filter(name=>name.startsWith(`${base}.bad-`)).sort().slice(0,-2)
    for(const name of stale){ fs.rmSync(path.join(parent,name),{recursive:true,force:true}); console.error(`dsh-ops: removed an older quarantined bash runtime: ${name}`) }
  }catch{ /* best effort — cleanup must never block recovery */ }
  console.error(`dsh-ops: quarantined an unverifiable bash runtime generation at ${quarantine}; staging a fresh one. Delete it once no confined shell is running.`)
  return quarantine
}
/** @param {string} file
 * @param {{home?: string, platform?: NodeJS.Platform, source?: string}} options */
export function confinedBash(file: string, {home=process.env.DSH_HOME ?? path.join(os.homedir(),'.dsh'), platform=process.platform, source}: { home?: string; platform?: NodeJS.Platform; source?: string }={}): Runtime {
  if(platform!=='win32')return {file}
  const root=msysRoot(file)
  const check=restrictedCompatibility(file,{platform})
  if(!check.compatible)throw Error(restrictedRemedy(file,source,check.reason))
  const {receipt,proxyBytes,patched,patchedSha,identity}=sourceState(root,path.join(root,'usr/bin/msys-2.0.dll'))
  const target=path.join(home,'dsh-ops/bash-ipc',identity)
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
  const generationIntact = (m: unknown) => {
    let msysOk
    try { msysOk = hash(fs.readFileSync(path.join(target,'usr/bin/msys-2.0.dll'))) === patchedSha } catch { return false }
    if(!msysOk) return false
    try {
      if(hash(fs.readFileSync(selected))!==hash(fs.readFileSync(path.join(root,'usr/bin/bash.exe')))) return false
      for(const name of ['opsipc.dll','opsnt.dll']){
        if(hash(fs.readFileSync(path.join(target,'usr/bin',name)))!==receipt.files[name]) return false
      }
    } catch { return false }
    return treeMatches(target, record(m) ? m.tree : undefined)
  }
  let knownBad=false
  if(cache.has(key)) {
    if(generationIntact(readMarker())) return cache.get(key)!
    // Not a throw. A cached-but-mismatched generation takes the same quarantine + staging path as a
    // cold miss; throwing here bricked bash for the lifetime of a long-lived host process.
    knownBad=true
    cache.delete(key)
  }
  // One marker read and one judgement per call: a failed cache check already proved the generation
  // bad, so re-running the (expensive) judgement on the way to quarantine just doubles the work.
  const marker0=readMarker()
  const valid = !knownBad && fs.existsSync(selected) && record(marker0) && marker0.identity===identity && generationIntact(marker0)
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
        throw Error(`Bash IPC runtime at ${target} failed verification and could not be quarantined after retrying (${errorMessage(error)}). `
          +'A confined shell or another process may still be using it: stop any confined shell, then delete that directory and retry.')
      }
    }
    // Failed incomplete builds get a new staging directory and only complete copies are published.
    fs.mkdirSync(path.dirname(target),{recursive:true})
    const stage=fs.mkdtempSync(path.join(path.dirname(target),'stage-'))
    try {
      fs.cpSync(root,stage,{recursive:true,filter:name=>!['.git','node_modules'].includes(path.basename(name))})
      fs.writeFileSync(path.join(stage,'usr/bin/msys-2.0.dll'),patched)
      for(const [name,data] of Object.entries(proxyBytes))fs.writeFileSync(path.join(stage,'usr/bin',name),data)
      // Stat-only manifest: `generationIntact` re-checks this tree with `stat`, so recording a
      // sha256 per file here bought nothing and cost a full 174 MB read on every staging.
      fs.writeFileSync(path.join(stage,'.ops-ipc.json'),JSON.stringify({identity,source:root,msys:receipt.msysSha256,patchedSha256:patchedSha,files:receipt.files,tree:treeDigest(stage,false)})+'\n')
      try {renameWithRetry(stage,target)} catch(error){if(!fs.existsSync(marker))throw error}
    } finally {fs.rmSync(stage,{recursive:true,force:true})}
  }
  const result={file:selected,env:{PATH:privateRuntimePath(target)},runtime:identity}
  cache.set(key,result)
  return result
}
