import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { tryWslRead } from '../lib/execution/wsl-worker.js'
import { workerEnvelope } from '../lib/execution/protocol.js'

/**
 * Issue #576: the optional WSL read delegated after driving one wsl.exe call
 * per drive mapping, one more for the payload sha256, and a last one for the
 * worker, so a small read paid four WSL startups for one result. The
 * preparation must be a single fixed /bin/sh -c script whose text never
 * interpolates data: every drive root and the payload path travel as
 * positional arguments, so no Windows path can alter the command shape. The
 * digest check and the Windows fallback stay exactly as strict as before.
 */
const unc = '\\\\wsl.localhost\\Ubuntu'

/** Stage a fake installed package with receipt-verified workers for both targets. */
function stagePackage(dir) {
  const version = '9.9.9-merge'
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }))
  const digests = {}
  for (const [target, name] of [['win32-x64', 'dsh-ops-worker.exe'], ['linux-x64', 'dsh-ops-worker']]) {
    const file = path.join(dir, 'runtime', target, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `payload-${target}`)
    digests[target] = createHash('sha256').update(`payload-${target}`).digest('hex')
    fs.writeFileSync(path.join(dir, 'runtime', target, 'provenance.json'),
      JSON.stringify({ target, version, executable: name, sha256: digests[target] }))
  }
  return digests
}

/** Record every spawn and answer the merged preparation or the worker delegation. */
function fakeSubprocess(answers) {
  const calls = []
  return {
    calls,
    spawn: (spec) => {
      calls.push(spec)
      const prepare = spec.argv[4] === '/bin/sh' && spec.argv[5] === '-c'
      const answer = prepare ? answers.prepare(calls.length) : answers.worker
      return {
        done: Promise.resolve({ exitCode: answer.exitCode ?? 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: answer.stdout ?? '', lossy: false }) },
          stderr: { readFrom: () => ({ text: answer.stderr ?? '', lossy: false }) },
        },
      }
    },
  }
}

async function attemptWith(dir, subprocess, digests, windowsWorker, payloadLinux, extraArgs = {}) {
  const envelope = workerEnvelope('file', { tool: 'glob', args: { path: `${unc}\\project\\*.txt` },
    root: `${unc}\\project`, deny_roots: ['C:\\Users\\pc\\.ssh', 'D:\\private\\creds'], ...extraArgs })
  return tryWslRead(subprocess, windowsWorker, envelope, 'C:\\', new AbortController().signal, () => true, undefined,
    { platform: 'win32', packageRoot: dir, env: { DSH_OPS_WSL_READS: '1', SystemRoot: 'C:\\Windows' } })
}

await test('WSL read preparation is one fixed positional-parameter shell call plus the worker (#576)', async () => {
  if (process.platform !== 'win32') {
    console.log('  (POSIX host: merged WSL preparation needs real Windows drive roots; this check needs Windows)')
    return
  }
  await withTempDir('wsl-prepare-merge', async (dir) => {
    const digests = stagePackage(dir)
    const windowsWorker = path.join(dir, 'runtime', 'win32-x64', 'dsh-ops-worker.exe')
    const payloadLinux = path.posix.join('/mnt/c', path.win32.relative('C:\\', path.join(dir, 'runtime', 'linux-x64', 'dsh-ops-worker')).replaceAll('\\', '/'))
    const mergedOutput = [
      'C:\\\t/mnt/c',
      'D:\\\t/mnt/d',
      `${digests['linux-x64']}  ${payloadLinux}`,
    ].join('\n') + '\n'
    const subprocess = fakeSubprocess({
      prepare: () => ({ stdout: mergedOutput }),
      worker: { stdout: JSON.stringify({ status: 'completed', pageComplete: true, items: ['/project/a.txt'] }) },
    })
    const attempt = await attemptWith(dir, subprocess, digests, windowsWorker, payloadLinux)
    assert.equal(attempt.handled, true, JSON.stringify(attempt))
    assert.deepEqual(attempt.value.items, [`${unc}\\project\\a.txt`])
    // #576: exactly one preparation call and one worker delegation.
    assert.equal(subprocess.calls.length, 2,
      `expected 2 wsl.exe invocations, saw ${subprocess.calls.length}: ${subprocess.calls.map(c => c.argv.join(' ')).join(' || ')}`)
    const prepare = subprocess.calls[0]
    assert.equal(prepare.argv[4], '/bin/sh')
    assert.equal(prepare.argv[5], '-c')
    const script = prepare.argv[6]
    // The script is fixed text: it names its tools and interpolates nothing.
    assert.ok(script.includes('wslpath') && script.includes('sha256sum'), script)
    assert.ok(!script.includes('C:'), script)
    assert.ok(!script.includes(dir), script)
    // Data travels as positional arguments behind the $0 placeholder, in the
    // order drive roots first and the payload path last.
    assert.equal(prepare.argv[7], 'dsh-ops')
    assert.deepEqual(prepare.argv.slice(8), ['C:\\', 'D:\\', path.join(dir, 'runtime', 'linux-x64', 'dsh-ops-worker')])
    // The delegation runs the receipt-verified Linux worker with mapped roots.
    assert.equal(subprocess.calls[1].argv[4], payloadLinux)
    const delegated = JSON.parse(subprocess.calls[1].stdio.stdin.data)
    assert.deepEqual(delegated.request.deny_roots, ['/mnt/c/Users/pc/.ssh', '/mnt/d/private/creds'])
    assert.equal(delegated.request.root, '/project')
  })
})

await test('a mismatched payload digest still falls back to the Windows worker (#576)', async () => {
  if (process.platform !== 'win32') {
    console.log('  (POSIX host: the digest fallback check needs real Windows drive roots; this check needs Windows)')
    return
  }
  await withTempDir('wsl-prepare-digest', async (dir) => {
    const digests = stagePackage(dir)
    const windowsWorker = path.join(dir, 'runtime', 'win32-x64', 'dsh-ops-worker.exe')
    const payloadLinux = path.posix.join('/mnt/c', path.win32.relative('C:\\', path.join(dir, 'runtime', 'linux-x64', 'dsh-ops-worker')).replaceAll('\\', '/'))
    const mergedOutput = [
      'C:\\\t/mnt/c',
      'D:\\\t/mnt/d',
      `${'0'.repeat(64)}  ${payloadLinux}`,
    ].join('\n') + '\n'
    const subprocess = fakeSubprocess({
      prepare: () => ({ stdout: mergedOutput }),
      worker: { stdout: '{}' },
    })
    const attempt = await attemptWith(dir, subprocess, digests, windowsWorker, payloadLinux)
    assert.equal(attempt.handled, false)
    assert.equal(subprocess.calls.length, 1, 'a digest mismatch must not start a worker delegation')
  })
})

await test('a failing preparation script still falls back to the Windows worker (#576)', async () => {
  if (process.platform !== 'win32') {
    console.log('  (POSIX host: the preparation fallback check needs real Windows drive roots; this check needs Windows)')
    return
  }
  await withTempDir('wsl-prepare-fail', async (dir) => {
    const digests = stagePackage(dir)
    const windowsWorker = path.join(dir, 'runtime', 'win32-x64', 'dsh-ops-worker.exe')
    const payloadLinux = path.posix.join('/mnt/c', path.win32.relative('C:\\', path.join(dir, 'runtime', 'linux-x64', 'dsh-ops-worker')).replaceAll('\\', '/'))
    const subprocess = fakeSubprocess({
      prepare: () => ({ exitCode: 9, stdout: '' }),
      worker: { stdout: '{}' },
    })
    const attempt = await attemptWith(dir, subprocess, digests, windowsWorker, payloadLinux)
    assert.equal(attempt.handled, false)
    assert.equal(subprocess.calls.length, 1)
  })
})

report('wsl-prepare-merge')
