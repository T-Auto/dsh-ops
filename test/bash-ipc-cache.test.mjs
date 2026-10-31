/**
 * The Bash IPC cache as state an operator can see and the plugin can bound (#466).
 *
 * These cases are deliberately filesystem-only: the sweep and the report must be assertable
 * without staging a 412 MB MSYS payload, and without waiting for Windows to release a directory.
 * The identity itself is exercised against the real pinned payload in `bash-ipc-roots`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { markManaged, withLifecycleLock, recoverBashLifecycleLock } from '../lib/bash-ipc-lifecycle.js'
import { bashIpcInventory, bashIpcRoot, reclaimBashGenerations } from '../lib/bash-ipc.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

const generation = (seed) => seed.repeat(24).slice(0, 24)

/** Seed one directory with a single file of `bytes` bytes, so sizes are exact. */
function seed(directory, bytes) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'payload.bin'), Buffer.alloc(bytes))
  markManaged(directory)
}

await test('the report names every cache entry exactly once and separates reclaimable bytes', async () => {
  await withTempDir('bash-ipc-report', (home) => {
    const root = bashIpcRoot(home)
    const current = generation('a'), previous = generation('b'), oldest = generation('c')
    const entries = [[current, 11], [previous, 13], [oldest, 17], [`${oldest}.bad-m1`, 19], ['stage-x', 23]]
    entries.forEach(([name, bytes], index) => {
      seed(path.join(root, name), bytes)
      const when = new Date(Date.UTC(2026, 0, 5 - index))
      fs.utimesSync(path.join(root, name), when, when)
    })
    fs.writeFileSync(path.join(root, 'ignore-me.txt'), 'not a directory')

    // `now` is pinned so the staging tree's age is a fact of the fixture, not of the wall clock
    // (a CI runner and a developer machine may run this years apart) (#512).
    const report = bashIpcInventory({ home, current, now: () => Date.UTC(2026, 0, 10) })
    assert.equal(report.root, root)
    assert.equal(report.current, current)
    assert.equal(report.generations, 3)
    assert.deepEqual(report.entries.map((entry) => entry.kind),
      ['generation', 'generation', 'generation', 'quarantine', 'staging'])
    assert.deepEqual(report.entries.filter((entry) => entry.current).map((entry) => entry.name), [current])
    assert.equal(report.entries.every((entry) => entry.files === 2), true)
    assert.equal(report.totalBytes, 11 + 13 + 17 + 19 + 23 + entries.length * 14)
    // One previous generation is retained; only the older one, plus the interrupted staging copy
    // (older than the one-hour TTL by the pinned clock), is scheduled for reclamation.
    assert.equal(report.reclaimableBytes, 17 + 14 + 23 + 14)
    assert.equal(report.entries.some((entry) => entry.name === 'ignore-me.txt'), false)
  })
})

await test('a sweep keeps the current and one previous generation, and removes the rest', async () => {
  await withTempDir('bash-ipc-sweep', (home) => {
    const root = bashIpcRoot(home)
    const names = ['a', 'b', 'c', 'd'].map(generation)
    // Oldest first, so the newest stale generation is the one retained beside the current one.
    names.forEach((name, index) => {
      seed(path.join(root, name), 10 * (index + 1))
      const when = new Date(Date.UTC(2026, 0, index + 1))
      fs.utimesSync(path.join(root, name), when, when)
    })
    const quarantine = `${names[0]}.bad-m1`, staging = 'stage-live'
    seed(path.join(root, quarantine), 3)
    seed(path.join(root, staging), 5)

    const logged = []
    const result = reclaimBashGenerations(root, names[3], { log: (line) => logged.push(line) })
    assert.deepEqual(result.kept, [names[2]], 'the newest stale generation is the retained predecessor')
    assert.deepEqual(result.removed.sort(), [names[0], names[1]].sort())
    assert.equal(result.bytes, 10 + 20 + 28)
    assert.equal(logged.length, 2)
    for (const name of names.slice(0, 2)) assert.equal(fs.existsSync(path.join(root, name)), false, name)
    for (const name of [names[2], names[3], quarantine, staging]) assert.equal(fs.existsSync(path.join(root, name)), true, name)
  })
})

await test('an interrupted staging copy is reclaimed by age, a fresh one is kept, and offline cleanup removes both (#512)', async () => {
  await withTempDir('bash-ipc-staging-sweep', (home) => {
    const root = bashIpcRoot(home)
    const current = generation('a')
    seed(path.join(root, current), 1)
    // Two hours old: the host that was copying it was killed before it could publish or clean up.
    const interrupted = 'stage-interrupted'
    seed(path.join(root, interrupted), 7)
    const when = new Date(Date.now() - 2 * 60 * 60 * 1000)
    fs.utimesSync(path.join(root, interrupted), when, when)
    // Just created: a cooperating staging process holds the lifecycle lock, so a sweep never runs
    // beside it; the TTL is the second guard for a sibling that is still crashing its way out.
    const live = 'stage-being-written'
    seed(path.join(root, live), 9)

    const now = () => Date.now()
    const preview = reclaimBashGenerations(root, current, { now, dryRun: true })
    assert.deepEqual(preview.removed, [interrupted], 'the preview names the stale copy')
    assert.equal(fs.existsSync(path.join(root, interrupted)), true, 'a preview removes nothing')

    const result = reclaimBashGenerations(root, current, { now })
    assert.deepEqual(result.removed, [interrupted])
    assert.equal(fs.existsSync(path.join(root, interrupted)), false, 'the interrupted copy is gone')
    assert.equal(fs.existsSync(path.join(root, live)), true, 'a fresh copy is left for its stager')

    // clean-cache runs only after an operator confirms every host and shell stopped, so it does not
    // need the age bound: stagingTtlMs: 0 removes an interrupted tree of any age.
    const forced = reclaimBashGenerations(root, current, { now, stagingTtlMs: 0 })
    assert.deepEqual(forced.removed, [live])
    assert.equal(fs.existsSync(path.join(root, live)), false)
  })
})

await test('a generation that cannot be renamed is kept intact, never half-deleted', async () => {
  await withTempDir('bash-ipc-in-use', (home) => {
    const root = bashIpcRoot(home)
    const current = generation('a'), retained = generation('b'), inUse = generation('c'), older = generation('d')
    const entries = [[current, 1], [retained, 2], [inUse, 3], [older, 4]]
    entries.forEach(([name, size], index) => {
      seed(path.join(root, name), size)
      const when = new Date(Date.UTC(2026, 0, 4 - index))
      fs.utimesSync(path.join(root, name), when, when)
    })
    const removedCalls = []
    const result = reclaimBashGenerations(root, current, {
      rename: (from, to) => {
        if (path.basename(from) === inUse) throw Object.assign(new Error('EPERM: in use'), { code: 'EPERM' })
        fs.renameSync(from, to)
      },
      remove: (target) => { removedCalls.push(target); fs.rmSync(target, { recursive: true, force: true }) },
      log: () => {},
    })
    assert.deepEqual(result.kept.sort(), [retained, inUse].sort())
    assert.deepEqual(result.removed, [older])
    assert.equal(fs.existsSync(path.join(root, inUse)), true)
    assert.equal(fs.existsSync(path.join(root, retained)), true)
    assert.equal(fs.existsSync(path.join(root, older)), false)
    assert.equal(removedCalls.length, 1, 'a refused rename must not be followed by a delete')
  })
})

await test('a sweep interrupted between rename and delete is finished by the next one', async () => {
  await withTempDir('bash-ipc-stale', (home) => {
    const root = bashIpcRoot(home)
    const current = generation('a'), stale = `${generation('b')}.stale-m1`
    seed(path.join(root, current), 1)
    seed(path.join(root, stale), 2)
    const result = reclaimBashGenerations(root, current, { log: () => {} })
    assert.deepEqual(result.removed, [stale])
    assert.equal(result.bytes, 16)
    assert.equal(fs.existsSync(path.join(root, stale)), false)
  })
})

await test('unrecognized retired names and junction roots/candidates are never traversed or removed', async () => {
  await withTempDir('bash-ipc-links', home => {
    const root=bashIpcRoot(home), outside=path.join(home,'outside')
    seed(outside,123)
    fs.mkdirSync(root,{recursive:true})
    const arbitrary='notes.stale-please-keep'
    seed(path.join(root,arbitrary),5)
    const linked=generation('c')+'.stale-m1'
    fs.symlinkSync(outside,path.join(root,linked),process.platform==='win32'?'junction':'dir')
    const report=bashIpcInventory({home,current:generation('a')})
    assert.equal(report.entries.some(e=>e.name===linked),false)
    const result=reclaimBashGenerations(root,generation('a'))
    assert.deepEqual(result.removed,[])
    assert.equal(fs.existsSync(path.join(root,arbitrary)),true)
    assert.equal(fs.readFileSync(path.join(outside,'payload.bin')).length,123)
    const other=path.join(home,'linked-home')
    fs.symlinkSync(home,other,process.platform==='win32'?'junction':'dir')
    assert.equal(bashIpcInventory({home:other}).entries.length,0)
    assert.throws(()=>reclaimBashGenerations(bashIpcRoot(other),generation('a')),/symlink|junction/)
  })
})

await test('a real second process lease preserves an old generation even after that process exits', async () => {
  await withTempDir('bash-ipc-process-lease', async home => {
    const root=bashIpcRoot(home), current=generation('a'), old=generation('b')
    seed(path.join(root,current),1);seed(path.join(root,old),2)
    const helper=new URL('../lib/bash-ipc-lifecycle.js',import.meta.url).href
    const script='import {withLifecycleLock,leaseGeneration} from '+JSON.stringify(helper)+';withLifecycleLock('+JSON.stringify(root)+',()=>leaseGeneration('+JSON.stringify(path.join(root,old))+'));console.log("leased");setInterval(()=>{},1000)'
    const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']})
    try{
      await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('lease child exited '+code)))})
      assert.deepEqual(reclaimBashGenerations(root,current,{retain:0}).kept,[old])
      assert.deepEqual(reclaimBashGenerations(root,current,{retain:0,confirmedStopped:true,dryRun:true}).kept,[old],'offline confirmation must not override live owner evidence')
    }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve))}
    assert.deepEqual(reclaimBashGenerations(root,current,{retain:0}).kept,[old],'dead host does not prove its descendants are idle')
  })
})

await test('legacy directories are retained; offline preview writes nothing and requires a recognized marker', async () => {
  await withTempDir('bash-ipc-legacy',home=>{
    const root=bashIpcRoot(home),current=generation('a'),old=generation('b'),unknown=generation('c')
    for(const name of [current,old,unknown]){fs.mkdirSync(path.join(root,name),{recursive:true});fs.writeFileSync(path.join(root,name,'payload'),'x')}
    fs.writeFileSync(path.join(root,old,'.ops-ipc.json'),JSON.stringify({identity:old,files:{},tree:{}}))
    assert.equal(reclaimBashGenerations(root,current,{retain:0}).removed.length,0)
    assert.deepEqual(reclaimBashGenerations(root,current,{retain:0,confirmedStopped:true,dryRun:true}).removed,[old])
    assert.equal(fs.existsSync(path.join(root,old)),true)
    assert.deepEqual(reclaimBashGenerations(root,current,{retain:0,confirmedStopped:true}).removed,[old])
    assert.equal(fs.existsSync(path.join(root,unknown)),true)
    withLifecycleLock(root,()=>assert.throws(()=>recoverBashLifecycleLock(root,{confirmedStopped:true}),/still alive/))
    fs.mkdirSync(path.join(root,'.ops-lifecycle-lock'))
    recoverBashLifecycleLock(root,{confirmedStopped:true})
    assert.equal(fs.existsSync(path.join(root,'.ops-lifecycle-lock')),false)
  })
})
report('bash-ipc-cache')
