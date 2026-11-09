/** Version preparation is independent of command lifetime and process count. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { niubashPreparedRoot, prepareNiubash, prepareNiubashVersion, publishNiubashVersion, verifiedNiubash } from '../lib/niubash/runtime.js'
import { NIUBASH_FACES } from '../lib/niubash/faces.js'
import { NIUBASH_PIN, NIUBASH_EXECUTION_DIRECTORIES, verifyNiubashTree } from '../lib/cli/niubash-payload.js'
import { assert, test, report, withTempDir, skipSuite } from './lib/harness.mjs'

const file = process.env.DSH_OPS_TEST_NIUBASH
if (!file) skipSuite('niubash-preparation', 'requires frozen DSH_OPS_TEST_NIUBASH')
const source = path.dirname(file)
const snapshot = root => {
  const result = {}
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) walk(name)
      else { const stat = fs.statSync(path.join(root, name)); result[name] = [stat.size, stat.mtimeMs, stat.nlink] }
    }
  }
  walk(''); return result
}
const childPrepare = (source, target, barrier) => new Promise((resolve, reject) => {
  const module = new URL('../lib/niubash/runtime.js', import.meta.url).href
  const code = `import fs from 'node:fs'; import path from 'node:path';
    import {prepareNiubashVersion} from ${JSON.stringify(module)};
    const [source,target,barrier]=process.argv.slice(1), rename=fs.renameSync;
    fs.renameSync=(from,to)=>{
      if(to===target){
        fs.writeFileSync(path.join(barrier,String(process.pid)),'ready');
        const deadline=Date.now()+60000, wait=new Int32Array(new SharedArrayBuffer(4));
        while(fs.readdirSync(barrier).length<2){
          if(Date.now()>deadline)throw Error('second preparer did not reach publication');
          Atomics.wait(wait,0,0,10);
        }
      }
      return rename(from,to);
    };
    prepareNiubashVersion(source,target);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, source, target, barrier],
  { cwd: path.dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolve() : reject(Error(stderr || `preparer exited ${code}`)))
})

await test('Windows publication tolerates only temporary scanner sharing refusals and recognizes a racing winner', async () => withTempDir('niu-publication', async root => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const from = path.join(root, `${code}-scratch`), to = path.join(root, code)
    fs.mkdirSync(from); fs.writeFileSync(path.join(from, 'payload'), 'complete')
    let attempts = 0, clock = 0
    const waits = []
    assert.equal(publishNiubashVersion(from, to, { platform: 'win32', now: () => clock,
      wait: ms => { waits.push(ms); clock += ms }, rename: (a, b) => {
        if (++attempts <= 3) throw Object.assign(Error('temporary scanner handle'), { code })
        fs.renameSync(a, b)
      } }), true)
    assert.deepEqual(waits, [50, 100, 200]); assert.equal(attempts, 4)
    assert.equal(fs.readFileSync(path.join(to, 'payload'), 'utf8'), 'complete')
    assert.equal(publishNiubashVersion(from, to, { rename: () => { throw Object.assign(Error('winner'), { code: 'EEXIST' }) },
      wait: () => { throw Error('must not wait after a winner publishes') } }), false)
  }
}))
await test('persistent publication failure is bounded and names the failed rename; unrelated errors never retry', async () => withTempDir('niu-publication-fail', async root => {
  const from = path.join(root, 'scratch'), to = path.join(root, 'target')
  let clock = 0, attempts = 0
  assert.throws(() => publishNiubashVersion(from, to, { platform: 'win32', now: () => clock,
    wait: ms => { clock += ms }, rename: () => { attempts++; throw Object.assign(Error('locked'), { code: 'EPERM' }) } }),
  error => error.message.startsWith('EXECUTOR_UNAVAILABLE: Niubash version publication rename failed') && error.message.includes(from) && error.message.includes(to))
  assert.equal(clock, 10000); assert.ok(attempts > 3)
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOSPC']]) {
    let calls = 0
    assert.throws(() => publishNiubashVersion(from, to, { platform,
      wait: () => { throw Error('must not retry unrelated errors') },
      rename: () => { calls++; throw Object.assign(Error(code), { code }) } }), /publication rename failed/)
    assert.equal(calls, 1)
  }
}))
await test('version preparation is idempotent, complete and does not hardlink the source', async () => withTempDir('niu-version', async root => {
  const target = niubashPreparedRoot({ DSH_HOME: root })
  const before = snapshot(source), read = fs.readFileSync
  let scratchReads = 0, selected
  fs.readFileSync = (file, ...args) => {
    if (String(file).startsWith(`${target}.stage-`)) scratchReads++
    return read(file, ...args)
  }
  try { selected = prepareNiubashVersion(source, target) } finally { fs.readFileSync = read }
  assert.equal(scratchReads, 0, 'cold preparation copies verified source bytes without rehashing all generated faces')
  const prepared = snapshot(target)
  assert.equal(prepareNiubashVersion(source, target), selected)
  assert.equal(verifiedNiubash(file, '', { DSH_HOME: root }).file, selected, 'selection honors the supplied home')
  assert.deepEqual(snapshot(target), prepared)
  assert.deepEqual(snapshot(source), before)
  for (const face of NIUBASH_FACES) assert.ok(fs.statSync(path.join(target, `winuxcmd/usr/bin/${face}.exe`)).isFile())
  for (const name of NIUBASH_EXECUTION_DIRECTORIES) assert.ok(fs.statSync(path.join(target, name)).isDirectory())
  for (const name of Object.keys(NIUBASH_PIN.files)) {
    assert.notEqual(fs.statSync(path.join(source, name)).ino, fs.statSync(path.join(target, name)).ino, name)
  }
  assert.equal(verifyNiubashTree(target, true), selected)
  const face = path.join(target, 'winuxcmd/usr/bin/cat.exe')
  fs.unlinkSync(face)
  assert.throws(() => prepareNiubashVersion(source, target), /Incomplete Niubash argv0 faces/)
  fs.writeFileSync(face, 'untrusted')
  assert.throws(() => prepareNiubashVersion(source, target), /checksum mismatch/)
}))
await test('scratch cleanup failure cannot replace the publication rename diagnostic', async () => withTempDir('niu-cleanup-diagnostic', async root => {
  const rename = fs.renameSync, remove = fs.rmSync, warn = console.error, warnings = []
  const target = path.join(root, 'prepared')
  fs.renameSync = () => { throw Object.assign(Error('publication refused'), { code: 'EINVAL' }) }
  fs.rmSync = (file, options) => {
    if (String(file).startsWith(`${target}.stage-`)) throw Error('cleanup refused')
    return remove(file, options)
  }
  console.error = text => warnings.push(text)
  try { assert.throws(() => prepareNiubashVersion(source, target), /EXECUTOR_UNAVAILABLE:.*publication rename failed.*publication refused/) }
  finally { fs.renameSync = rename; fs.rmSync = remove; console.error = warn }
  assert.equal(warnings.length, 1); assert.match(warnings[0], /preparation scratch.*cleanup refused/)
}))
await test('filesystems without hardlinks prepare command faces by independent copies once', async () => withTempDir('niu-copy-faces', async root => {
  const target = path.join(root, 'prepared'), link = fs.linkSync
  fs.linkSync = () => { throw Object.assign(Error('hardlinks unsupported'), { code: 'ENOTSUP' }) }
  try { prepareNiubashVersion(source, target) } finally { fs.linkSync = link }
  assert.equal(verifyNiubashTree(target, true), path.join(target, 'niu.exe'))
  assert.equal(fs.statSync(path.join(target, 'winuxcmd/usr/bin/cat.exe')).nlink, 1)
  assert.equal(fs.statSync(path.join(target, 'winuxcmd/usr/bin/winuxcmd.exe')).nlink, 1)
}))
await test('two independent preparers safely publish the same complete version', async () => withTempDir('niu-race', async root => {
  const target = path.join(root, 'prepared'), barrier = path.join(root, 'barrier')
  fs.mkdirSync(barrier)
  const results = await Promise.allSettled([childPrepare(source, target, barrier), childPrepare(source, target, barrier)])
  for (const result of results) if (result.status === 'rejected') throw result.reason
  fs.rmSync(barrier, { recursive: true })
  assert.equal(verifyNiubashTree(target, true), path.join(target, 'niu.exe'))
  assert.deepEqual(fs.readdirSync(root), ['prepared'], 'the losing scratch directory is removed')
}))
await test('consecutive and concurrent invocation preparation is read-only and creates no execution trees', async () => {
  const selected = verifiedNiubash(file)
  const root = path.dirname(selected.file), before = snapshot(root), original = snapshot(source)
  const operations = ['mkdtemp', 'copyFile', 'link', 'chmod', 'rm', 'readdir', 'readFile']
  const saved = Object.fromEntries(operations.map(key => [key, fs.promises[key]]))
  for (const key of operations) fs.promises[key] = async () => { throw Error(`per-call filesystem mutation/verification: ${key}`) }
  try {
    const run = () => prepareNiubash(selected.file, 'inherited', new AbortController().signal)
    assert.equal((await run()).file, selected.file)
    assert.equal((await run()).file, selected.file)
    assert.deepEqual((await Promise.all([run(), run()])).map(value => value.file), [selected.file, selected.file])
  } finally { Object.assign(fs.promises, saved) }
  assert.deepEqual(snapshot(root), before)
  assert.deepEqual(snapshot(source), original)
})
await test('workspace-contained and junction-hidden payloads are refused before host workspace labeling', async () => withTempDir('niu-workspace', async root => {
  const payload = path.join(root, 'payload'); fs.mkdirSync(payload)
  const signal = new AbortController().signal
  await assert.rejects(prepareNiubash(path.join(payload, 'niu.exe'), '', signal, { workspaceRoot: root }), /outside the session workspace/)
  await withTempDir('niu-alias', async aliasRoot => {
    const alias = path.join(aliasRoot, 'alias')
    fs.symlinkSync(payload, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(prepareNiubash(path.join(alias, 'niu.exe'), '', signal, { workspaceRoot: root }), /outside the session workspace/)
  })
}))
report('niubash-preparation')
