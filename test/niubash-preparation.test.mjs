/** Selection reads metadata only; the prepared runtime is built lazily, once per process and version. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { niubashPreparedRoot, prepareNiubash, prepareNiubashVersion, publishNiubashVersion, selectNiubash } from '../lib/niubash/runtime.js'
import { resolveShells } from '../lib/shells/resolve.js'
import { NIUBASH_FACES } from '../lib/niubash/faces.js'
import { NIUBASH_PIN, NIUBASH_EXECUTION_DIRECTORIES, NIUBASH_MANIFEST_SHA256, NIUBASH_PACKAGE_PATH } from '../lib/cli/niubash-payload.js'
import { syntheticNiubashTree } from './lib/niubash-distribution-fixture.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

const signal = new AbortController().signal
const pinned = Object.keys(NIUBASH_PIN.files)
const face = name => `winuxcmd/usr/bin/${name}.exe`
const generatedFaces = NIUBASH_FACES.map(face).filter(name => !Object.hasOwn(NIUBASH_PIN.files, name))
/** One synthetic payload and home per scenario, so the per-process memo never crosses tests. */
const fixture = root => {
  const source = syntheticNiubashTree(path.join(root, 'package', NIUBASH_PACKAGE_PATH))
  const env = { DSH_HOME: path.join(root, 'home') }
  return { source, env, file: path.join(source, 'niu.exe'), target: niubashPreparedRoot(env), prepare: () => prepareNiubash(path.join(source, 'niu.exe'), 'inherited', signal, { env }) }
}
/** Replace methods for the body only; every replacement throws when the code under test reaches it. */
async function forbidding(owner, names, body) {
  const saved = Object.fromEntries(names.map(name => [name, owner[name]]))
  for (const name of names) owner[name] = () => { throw Error(`forbidden ${name}`) }
  try { return await body() } finally { Object.assign(owner, saved) }
}
async function patched(owner, replacements, body) {
  const saved = Object.fromEntries(Object.keys(replacements).map(name => [name, owner[name]]))
  Object.assign(owner, replacements)
  try { return await body(saved) } finally { Object.assign(owner, saved) }
}
/** A complete prepared runtime: every pinned file and generated face at its size, every state directory. */
function assertPrepared(target) {
  for (const name of pinned) assert.equal(fs.statSync(path.join(target, name)).size, NIUBASH_PIN.sizes[name], name)
  for (const name of generatedFaces) assert.equal(fs.statSync(path.join(target, name)).size, NIUBASH_PIN.sizes['winuxcmd/usr/bin/winuxcmd.exe'], name)
  for (const name of NIUBASH_EXECUTION_DIRECTORIES) assert.ok(fs.statSync(path.join(target, name)).isDirectory(), name)
}
const READS = ['readFileSync', 'openSync', 'createReadStream']
const WRITES = ['writeFileSync', 'mkdirSync', 'mkdtempSync', 'copyFileSync', 'linkSync', 'renameSync', 'rmSync']

await test('mount-time selection reads no payload bytes and writes nothing, in every mode', async () => withTempDir('niu-select', async root => {
  const { file, env, target } = fixture(root)
  const options = { bundleRoot: path.join(root, 'package'), env, platform: 'win32', arch: 'x64' }
  await forbidding(fs, [...READS, ...WRITES], () => forbidding(fs.promises, ['readFile', 'open', 'copyFile', 'mkdir'], () => {
    for (const mode of ['minimal', 'standard', 'ptc', 'cordis']) {
      const { bash } = resolveShells({}, options)
      assert.equal(bash.available, true, bash.detail)
      assert.equal(bash.file, file, `${mode}: selection names the payload the operator chose`)
    }
  }))
  assert.equal(fs.existsSync(path.dirname(target)), false, 'selection prepares nothing')
}))
await test('selection rejects an incomplete or resized payload and names the member; unlisted paths are ignored', async () => withTempDir('niu-select-reject', async root => {
  const { source, file } = fixture(root)
  fs.writeFileSync(path.join(source, 'notes.txt'), 'operator notes')
  assert.equal(selectNiubash(file), file)
  const member = path.join(source, pinned.at(-1))
  fs.renameSync(member, `${member}.aside`)
  assert.throws(() => selectNiubash(file), error => error.message.startsWith('EXECUTOR_UNAVAILABLE:') && error.message.includes(`Incomplete Niubash payload: ${pinned.at(-1)}`))
  fs.renameSync(`${member}.aside`, member)
  fs.appendFileSync(file, 'x')
  assert.throws(() => selectNiubash(file), /EXECUTOR_UNAVAILABLE:.*size mismatch: niu\.exe/)
  fs.truncateSync(file, NIUBASH_PIN.sizes['niu.exe'])
  for (const wrong of ['niu.exe', path.join(source, 'bash.exe')]) assert.throws(() => selectNiubash(wrong), /absolute niu\.exe path/)
  assert.equal(selectNiubash(file), file)
}))
await test('first command builds one complete private copy; concurrent first calls share it', async () => withTempDir('niu-first', async root => {
  const { source, target, prepare } = fixture(root)
  const copyFile = fs.promises.copyFile
  let copies = 0
  const runtimes = await patched(fs.promises, { copyFile: (...args) => { copies++; return copyFile(...args) } },
    () => Promise.all([prepare(), prepare(), prepare()]))
  assert.equal(copies, pinned.length, 'one build copies each pinned file once')
  const executable = path.join(target, 'niu.exe')
  for (const runtime of runtimes) {
    assert.equal(runtime.file, executable)
    assert.equal(runtime.env.NIU_ROOT, path.join(target, 'winuxcmd'))
    assert.equal(runtime.env.PATH.split(path.delimiter).at(-1), 'inherited')
  }
  assertPrepared(target)
  for (const name of pinned) assert.notEqual(fs.statSync(path.join(source, name)).ino, fs.statSync(path.join(target, name)).ino, name)
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [NIUBASH_MANIFEST_SHA256], 'no scratch remains')
}))
await test('later commands only check existence: no reads, writes or hashing', async () => withTempDir('niu-steady', async root => {
  const { target, prepare } = fixture(root)
  await prepare()
  await forbidding(fs, [...READS, ...WRITES, 'lstatSync', 'readdirSync'], () => forbidding(fs.promises,
    ['readFile', 'open', 'copyFile', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'readdir'], async () => {
      for (const runtime of await Promise.all([prepare(), prepare()])) assert.equal(runtime.file, path.join(target, 'niu.exe'))
    }))
}))
await test('files the shell writes into its state directories never make a version look damaged', async () => withTempDir('niu-state', async root => {
  const { source, target, prepare } = fixture(root)
  await prepare()
  const before = fs.statSync(path.join(target, 'niu.exe')).ino
  for (const name of NIUBASH_EXECUTION_DIRECTORIES) fs.writeFileSync(path.join(target, name, 'runtime-state'), 'written by bash')
  fs.mkdirSync(path.join(target, 'winuxcmd/var/tmp/nested'), { recursive: true })
  assert.equal(await prepareNiubashVersion(source, target), path.join(target, 'niu.exe'), 'a fresh process reuses it')
  assert.equal(fs.statSync(path.join(target, 'niu.exe')).ino, before, 'not rebuilt')
  for (const name of NIUBASH_EXECUTION_DIRECTORIES) assert.equal(fs.readFileSync(path.join(target, name, 'runtime-state'), 'utf8'), 'written by bash')
}))
await test('a missing or resized prepared member is rebuilt once; a failed rebuild reports both causes and cleans up', async () => withTempDir('niu-repair', async root => {
  const { source, target, prepare } = fixture(root)
  await prepare()
  const executable = path.join(target, 'niu.exe')
  fs.unlinkSync(path.join(target, face('cat')))
  assert.equal(await prepareNiubashVersion(source, target), executable)
  assert.ok(fs.existsSync(path.join(target, face('cat'))), 'a missing face is restored')
  fs.appendFileSync(executable, 'corrupt')
  assert.equal(await prepareNiubashVersion(source, target), executable)
  assert.equal(fs.statSync(executable).size, NIUBASH_PIN.sizes['niu.exe'])
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [NIUBASH_MANIFEST_SHA256], 'the damaged version is retired')
  fs.appendFileSync(executable, 'corrupt again')
  let copies = 0
  await patched(fs.promises, { copyFile: async () => { copies++; throw Object.assign(Error('fresh copy refused'), { code: 'EIO' }) } }, () =>
    assert.rejects(prepareNiubashVersion(source, target), /EXECUTOR_UNAVAILABLE:.*repair failed: existing version:.*size mismatch.*fresh preparation:.*fresh copy refused/))
  assert.equal(copies, 1, 'exactly one fresh attempt')
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [], 'the failed scratch and the damaged version are both cleaned')
}))
await test('a version another profile retired is rebuilt once on the next call without evicting other pins', async () => withTempDir('niu-recover', async root => {
  const { target, prepare } = fixture(root)
  await prepare()
  const other = path.join(path.dirname(target), 'f'.repeat(64)); fs.mkdirSync(other)
  fs.rmSync(target, { recursive: true })
  assert.equal((await prepare()).file, path.join(target, 'niu.exe'))
  assert.ok(fs.existsSync(other), 'recovery keeps the other profile\'s version')
  assertPrepared(target)
}))
await test('a failed first preparation is not remembered; the next call tries again', async () => withTempDir('niu-retry', async root => {
  const { target, prepare } = fixture(root)
  await patched(fs.promises, { copyFile: async () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }) } }, () =>
    assert.rejects(prepare(), /EXECUTOR_UNAVAILABLE:.*disk full/))
  assert.equal((await prepare()).file, path.join(target, 'niu.exe'))
}))
await test('the first preparation in a process retires obsolete versions and leftovers once, leaving busy and foreign ones', async () => withTempDir('niu-retire', async root => {
  const { target, prepare } = fixture(root)
  const parent = path.dirname(target), older = 'a'.repeat(64), busy = 'b'.repeat(64)
  const obsolete = [older, `${older}.broken-x`, `${NIUBASH_MANIFEST_SHA256}.stage-x`, `${older}.retired-x`]
  const kept = [busy, `${'c'.repeat(64)}.stage-live`, 'unrelated']
  for (const name of [...obsolete, ...kept]) fs.mkdirSync(path.join(parent, name), { recursive: true })
  const renameSync = fs.renameSync
  let busyAttempts = 0
  await patched(fs, { renameSync: (from, to) => {
    if (from === path.join(parent, busy)) { busyAttempts++; throw Object.assign(Error('image in use'), { code: 'EBUSY' }) }
    return renameSync(from, to)
  } }, () => prepare())
  assert.equal(busyAttempts, 1)
  assert.deepEqual(fs.readdirSync(parent).sort(), [NIUBASH_MANIFEST_SHA256, ...kept].sort())
}))
await test('publication backs off asynchronously only for Windows sharing refusals and recognizes a racing winner', async () => withTempDir('niu-publication', async root => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const from = path.join(root, `${code}-scratch`), to = path.join(root, code)
    fs.mkdirSync(from)
    let attempts = 0, clock = 0
    const waits = []
    assert.equal(await publishNiubashVersion(from, to, { platform: 'win32', now: () => clock,
      wait: async ms => { waits.push(ms); clock += ms }, rename: async (a, b) => {
        if (++attempts <= 3) throw Object.assign(Error('temporary scanner handle'), { code })
        fs.renameSync(a, b)
      } }), true)
    assert.deepEqual(waits, [50, 100, 200]); assert.ok(fs.existsSync(to))
  }
  assert.equal(await publishNiubashVersion(path.join(root, 'loser'), path.join(root, 'EBUSY'), {
    rename: async () => { throw Object.assign(Error('winner'), { code: 'EEXIST' }) },
    wait: () => { throw Error('must not wait after a winner publishes') } }), false)
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  let refusals = 0
  try {
    await publishNiubashVersion(path.join(root, 'held'), path.join(root, 'held-target'), { platform: 'win32',
      rename: async () => { if (++refusals < 4) throw Object.assign(Error('held'), { code: 'EBUSY' }) } })
  } finally { clearInterval(timer) }
  assert.ok(ticks > 0, 'the event loop keeps running while publication waits')
}))
await test('persistent publication refusal is bounded and named; unrelated errors never retry', async () => withTempDir('niu-publication-fail', async root => {
  const from = path.join(root, 'scratch'), to = path.join(root, 'target')
  let clock = 0, attempts = 0
  await assert.rejects(publishNiubashVersion(from, to, { platform: 'win32', now: () => clock,
    wait: async ms => { clock += ms }, rename: async () => { attempts++; throw Object.assign(Error('locked'), { code: 'EPERM' }) } }),
  error => error.message.startsWith('EXECUTOR_UNAVAILABLE: Niubash version publication rename failed') && error.message.includes(from) && error.message.includes(to))
  assert.equal(clock, 10000); assert.ok(attempts > 3)
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOSPC']]) {
    let calls = 0
    await assert.rejects(publishNiubashVersion(from, to, { platform, wait: () => { throw Error('must not retry unrelated errors') },
      rename: async () => { calls++; throw Object.assign(Error(code), { code }) } }), /publication rename failed/)
    assert.equal(calls, 1)
  }
}))
const childPrepare = (source, target, barrier) => new Promise((resolve, reject) => {
  const module = new URL('../lib/niubash/runtime.js', import.meta.url).href
  const code = `import fs from 'node:fs'; import path from 'node:path';
    import {prepareNiubashVersion} from ${JSON.stringify(module)};
    const [source,target,barrier]=process.argv.slice(1), rename=fs.promises.rename;
    fs.promises.rename=async(from,to)=>{
      if(to===target){
        fs.writeFileSync(path.join(barrier,String(process.pid)),'ready');
        const deadline=Date.now()+60000;
        while(fs.readdirSync(barrier).length<2){
          if(Date.now()>deadline)throw Error('second preparer did not reach publication');
          await new Promise(r=>setTimeout(r,10));
        }
      }
      return rename(from,to);
    };
    await prepareNiubashVersion(source,target);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, source, target, barrier],
    { cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve() : reject(Error(stderr || `preparer exited ${code}`)))
})
await test('two independent processes publish the same complete version; the loser leaves no scratch', async () => withTempDir('niu-race', async root => {
  const { source, target } = fixture(root), barrier = path.join(root, 'barrier')
  fs.mkdirSync(barrier); fs.mkdirSync(path.dirname(target), { recursive: true })
  const results = await Promise.allSettled([childPrepare(source, target, barrier), childPrepare(source, target, barrier)])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  assertPrepared(target)
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [NIUBASH_MANIFEST_SHA256])
}))
await test('a builder whose scratch the winner retired uses the published winner and retires nothing twice', async () => withTempDir('niu-interrupted', async root => {
  const { source, target, prepare } = fixture(root)
  await prepare()
  const existsSync = fs.existsSync, renameSync = fs.renameSync
  let hidden = false, retirements = 0
  const hideTargetOnce = candidate => { if (candidate === target && !hidden) { hidden = true; return false } return existsSync(candidate) }
  const busyScratch = (from, to) => {
    if (String(from).startsWith(`${target}.stage-`)) { retirements++; throw Object.assign(Error('busy'), { code: 'EBUSY' }) }
    return renameSync(from, to)
  }
  const retiredByWinner = async () => { throw Object.assign(Error('scratch retired by the winner'), { code: 'ENOENT' }) }
  const attempt = async () => assert.equal(await prepareNiubashVersion(source, target), path.join(target, 'niu.exe'))
  await patched(fs, { existsSync: hideTargetOnce, renameSync: busyScratch }, () => patched(fs.promises, { copyFile: retiredByWinner }, attempt))
  assert.equal(retirements, 1)
}))
await test('scratch cleanup failure cannot replace the publication diagnostic', async () => withTempDir('niu-cleanup', async root => {
  const { source, target } = fixture(root), rmSync = fs.rmSync, warnings = []
  const refuseCleanup = (file, options) => { if (String(file).includes('.stage-')) throw Error('cleanup refused'); return rmSync(file, options) }
  const refusePublication = async () => { throw Object.assign(Error('publication refused'), { code: 'EINVAL' }) }
  const attempt = () => assert.rejects(prepareNiubashVersion(source, target), /EXECUTOR_UNAVAILABLE:.*publication rename failed.*publication refused/)
  await patched(console, { error: text => warnings.push(text) }, () =>
    patched(fs, { rmSync: refuseCleanup }, () => patched(fs.promises, { rename: refusePublication }, attempt)))
  assert.equal(warnings.length, 1); assert.match(warnings[0], /could not retire.*preparation scratch/)
}))
await test('filesystems without hardlinks prepare faces as independent copies', async () => withTempDir('niu-copy-faces', async root => {
  const { target, prepare } = fixture(root)
  await patched(fs.promises, { link: async () => { throw Object.assign(Error('hardlinks unsupported'), { code: 'ENOTSUP' }) } }, () => prepare())
  assertPrepared(target)
  assert.equal(fs.statSync(path.join(target, face('cat'))).nlink, 1)
}))
await test('a bashPath naming the prepared root is refused when damaged, never repaired, then reused like any version', async () => withTempDir('niu-prepared-path', async root => {
  const { source, target, env } = fixture(root)
  await prepareNiubashVersion(source, target)
  const executable = path.join(target, 'niu.exe'), obsolete = path.join(path.dirname(target), 'a'.repeat(64))
  const direct = () => prepareNiubash(executable, '', signal, { env })
  fs.appendFileSync(executable, 'x')
  await assert.rejects(direct(), /EXECUTOR_UNAVAILABLE:.*size mismatch/)
  assert.ok(fs.existsSync(target), 'no repair without a separate source')
  fs.truncateSync(executable, NIUBASH_PIN.sizes['niu.exe'])
  fs.mkdirSync(obsolete)
  assert.equal((await direct()).file, executable, 'the refusal was not remembered')
  assert.equal(fs.existsSync(obsolete), false, 'the first successful use retires obsolete versions here too')
  await forbidding(fs, ['lstatSync', 'readdirSync'], async () => assert.equal((await direct()).file, executable, 'later calls only check existence'))
}))
await test('a complete prepared version never authorizes an incomplete source', async () => withTempDir('niu-bad-source', async root => {
  const { target, prepare } = fixture(root)
  await prepare()
  const invalid = path.join(root, 'invalid'); fs.mkdirSync(invalid); fs.writeFileSync(path.join(invalid, 'niu.exe'), 'untrusted')
  await assert.rejects(prepareNiubashVersion(invalid, target), /Incomplete Niubash payload/)
}))
await test('a prepared root inside the workspace, directly or through a link, is refused before any preparation', async () => withTempDir('niu-workspace', async root => {
  const { file } = fixture(root)
  const inside = { DSH_HOME: path.join(root, 'home') }
  await assert.rejects(prepareNiubash(file, '', signal, { workspaceRoot: root, env: inside }), /outside the session workspace/)
  await withTempDir('niu-alias', async aliasRoot => {
    const alias = path.join(aliasRoot, 'alias')
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(prepareNiubash(file, '', signal, { workspaceRoot: root, env: { DSH_HOME: path.join(alias, 'home') } }), /outside the session workspace/)
  })
  assert.equal(fs.existsSync(path.join(root, 'home')), false)
}))
report('niubash-preparation')
