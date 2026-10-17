/**
 * The verifier gate: `bench/lib/verify.mjs`, the eight check types a task is
 * judged with, and the mutation self-check that proves the verifier can fail.
 *
 * A sweep's verdict is only as trustworthy as the check that produced it, so this
 * suite does not stop at "each check type can pass and fail". The second half is a
 * mutation self-check in the shape the eval-infra reference uses: for every check
 * type, build a tree the check must accept, then perturb the tree or the
 * expectation by the smallest amount that makes the answer wrong — a renamed file,
 * a swapped line, a one-byte drift, a lock sidecar that only nearly matches the
 * tolerated name — and require the verifier to notice *and name the reason*. A
 * verifier that cannot fail certifies nothing.
 *
 * Everything here is the harness's own arithmetic: no model, no server, no dsh, so
 * it runs in the ordinary `node test/run.mjs` gate on every platform. The one
 * `command` check spawns `process.execPath`, never a shell, so the suite does not
 * depend on the host's login shell either.
 *
 * @module dsh-ops/test/bench-verify
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { assert, report, test, withTempDir, TEST_HOME } from './lib/harness.mjs'

import { CHECK_TYPES, contentLines, countFiles, verifyWorkspace } from '../bench/lib/verify.mjs'

const LABEL = 'bench-verify'

/** The update-lock sidecar `ops_replace` leaves beside every file it edits. */
const lockName = (hex) => `.dsh-ops-update-${hex}.lock`

/** Write a workspace file, creating its parents. */
function write(dir, relative, text) {
  const target = path.join(dir, ...relative.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text, 'utf8')
}

/** The sha256 a fixture generator would have exported for a known byte string. */
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

// ---------------------------------------------------------------- vocabulary

await test('CHECK_TYPES is the exact vocabulary the tasks are written against', () => {
  assert.deepEqual(CHECK_TYPES, [
    'fileExists', 'fileMissing', 'fileEquals', 'fileContains',
    'fileLines', 'countFiles', 'contentHashes', 'command',
  ])
})

// ---------------------------------------------------------------- each check type, both directions

await test('verify covers each check type in both directions', async () => {
  await withTempDir('bench-verify', async (dir) => {
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'answer.txt'), '  42\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'list.txt'), 'a.txt\n\nb.txt\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'sub', 'KEEP_1.txt'), 'x', 'utf8')
    fs.writeFileSync(path.join(dir, 'sub', 'KEEP_2.md'), 'y', 'utf8')
    const exports = {
      sum: 42,
      matches: ['a.txt', 'b.txt'],
      count: 2,
      hashes: [{ name: 'KEEP_1.txt', sha256: sha('x') }, { name: 'KEEP_2.md', sha256: sha('y') }],
      tamperedHashes: [{ name: 'KEEP_1.txt', sha256: sha('changed') }, { name: 'KEEP_2.md', sha256: sha('y') }],
      missingHashes: [{ name: 'KEEP_1.txt', sha256: sha('x') }, { name: 'KEEP_9.txt', sha256: sha('z') }],
    }

    const pass = await verifyWorkspace(dir, [
      { type: 'fileExists', path: 'answer.txt' },
      { type: 'fileMissing', path: 'gone.txt' },
      { type: 'fileEquals', path: 'answer.txt', expect: 'sum' },
      { type: 'fileContains', path: 'answer.txt', text: '4' },
      { type: 'fileLines', path: 'list.txt', expect: 'matches' },
      { type: 'countFiles', dir: 'sub', prefix: 'KEEP_', expect: 'count' },
      { type: 'contentHashes', dir: 'sub', expect: 'hashes' },
      { type: 'command', command: 'node', args: ['-e', 'process.exit(0)'], exitCode: 0 },
    ], exports)
    assert.equal(pass.passed, true, JSON.stringify(pass.checks))

    const fail = await verifyWorkspace(dir, [
      { type: 'fileExists', path: 'gone.txt' },
      { type: 'fileMissing', path: 'answer.txt' },
      { type: 'fileEquals', path: 'answer.txt', text: '43' },
      { type: 'fileContains', path: 'answer.txt', text: 'zzz' },
      { type: 'fileLines', path: 'list.txt', lines: ['b.txt', 'a.txt'] },
      { type: 'countFiles', dir: 'sub', extension: '.txt', count: 5 },
      { type: 'contentHashes', dir: 'sub', expect: 'tamperedHashes' },
      { type: 'contentHashes', dir: 'sub', expect: 'missingHashes' },
      { type: 'contentHashes', dir: 'sub', expect: 'count' },
      { type: 'command', command: 'node', args: ['-e', 'process.exit(3)'], exitCode: 0 },
    ], exports)
    assert.equal(fail.passed, false)
    assert.equal(fail.checks.length, 10)
    assert.ok(fail.checks.every((check) => check.passed === false), 'every check above was written to fail')
    assert.ok(fail.checks.every((check) => check.detail.length <= 210), 'details must stay short')
    // The contentHashes failure modes must name themselves, not just "failed".
    assert.match(fail.checks[6].detail, /content changed: KEEP_1\.txt/)
    assert.match(fail.checks[7].detail, /missing: KEEP_9\.txt/)
    assert.match(fail.checks[8].detail, /non-empty fixture export/)
  })
})

// ---------------------------------------------------------------- the tolerated sidecar

await test('contentHashes ignores the replace update-lock sidecars and nothing else', async () => {
  await withTempDir('bench-verify-lock', async (dir) => {
    const exports = { hashes: [{ name: 'core.js', sha256: sha('renamed') }] }
    const check = [{ type: 'contentHashes', dir: '.', expect: 'hashes' }]
    fs.writeFileSync(path.join(dir, 'core.js'), 'renamed', 'utf8')

    // The candidate's `ops_replace` leaves these beside every file it edits: one per
    // path, created on first use and never unlinked. They are tool state, not content.
    fs.writeFileSync(path.join(dir, lockName('a'.repeat(64))), '', 'utf8')
    const tolerated = await verifyWorkspace(dir, check, exports)
    assert.equal(tolerated.passed, true, 'a 64-hex update-lock sidecar must not fail a byte-exact check')

    // The tolerance is the documented shape only: a near miss is a real unexpected file.
    fs.writeFileSync(path.join(dir, lockName('abc')), '', 'utf8')
    const nearMiss = await verifyWorkspace(dir, check, exports)
    assert.equal(nearMiss.passed, false, 'only `.dsh-ops-update-<64 hex>.lock` is tolerated')
    assert.match(nearMiss.checks[0].detail, /unexpected: \.dsh-ops-update-abc\.lock/)
  })
})

// ---------------------------------------------------------------- refusal, not guessing

await test('a failing check does not stop the sweep', async () => {
  await withTempDir('bench-verify', async (dir) => {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'content', 'utf8')
    const verdict = await verifyWorkspace(dir, [
      { type: 'fileEquals', path: 'real.txt', text: 'other' },
      { type: 'fileExists', path: 'real.txt' },
    ], {})
    assert.equal(verdict.checks.length, 2, 'both checks must have run')
    assert.equal(verdict.checks[1].passed, true)
    assert.equal(verdict.passed, false)
  })
})

await test('a check that throws is recorded, and the checks after it still run', async () => {
  await withTempDir('bench-verify', async (dir) => {
    fs.writeFileSync(path.join(dir, 'real.txt'), 'x', 'utf8')
    const verdict = await verifyWorkspace(dir, [
      { type: 'fileEquals', path: 'real.txt', expect: 'missingKey' },
      { type: 'fileExists', path: 'real.txt' },
    ], {})
    assert.equal(verdict.passed, false)
    assert.equal(verdict.checks.length, 2, 'a throwing check must not abort the sweep')
    assert.match(verdict.checks[0].detail, /fixture exports have no key/)
    assert.equal(verdict.checks[1].passed, true)
  })
})

await test('verify rejects a command it cannot run instead of passing it', async () => {
  await withTempDir('bench-verify', async (dir) => {
    const verdict = await verifyWorkspace(dir, [{ type: 'command', command: 'definitely-not-a-real-binary-xyz', exitCode: 0 }], {})
    assert.equal(verdict.passed, false)
    assert.match(verdict.checks[0].detail, /no exit code/)
  })
})

// ---------------------------------------------------------------- helpers

await test('helpers count files and lines the way the checks claim', () => {
  assert.deepEqual(contentLines(' a \n\n b\n'), ['a', 'b'])
  assert.deepEqual(contentLines('a\r\nb\r\n'), ['a', 'b'])
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'bench-count-'))
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'A_1.txt'), '', 'utf8')
  fs.writeFileSync(path.join(dir, 'B_2.md'), '', 'utf8')
  fs.writeFileSync(path.join(dir, 'nested', 'A_3.txt'), '', 'utf8')
  assert.equal(countFiles(dir, {}), 3)
  assert.equal(countFiles(dir, { prefix: 'A_' }), 2)
  assert.equal(countFiles(dir, { extension: '.txt' }), 2)
  assert.equal(countFiles(dir, { prefix: 'A_', extension: '.txt' }), 2)
  assert.equal(countFiles(path.join(dir, 'nested'), {}), 1)
  assert.equal(countFiles(path.join(dir, 'absent'), {}), 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- mutation self-check

/**
 * One "the verifier must have teeth here" sample. `setup` builds the honest tree
 * and returns the fixture exports it needs; `check` is the check the honest tree
 * must pass; `mutate` applies the smallest change that makes the answer wrong —
 * on the tree, or by returning a replacement check when the drift is in the
 * expectation — and must return a check only when it mutated one.
 *
 * `detail` is the reason the failure must name, so a sample cannot be satisfied by
 * a verifier that fails for an unrelated reason (or by an exception).
 */
const MUTATIONS = [
  {
    type: 'fileExists',
    looks: 'the name is taken by a directory, so no file was written',
    setup: (dir) => write(dir, 'answer.txt', '42\n'),
    check: () => ({ type: 'fileExists', path: 'answer.txt' }),
    mutate: (dir) => {
      fs.rmSync(path.join(dir, 'answer.txt'))
      fs.mkdirSync(path.join(dir, 'answer.txt'))
    },
    detail: /file not found/,
  },
  {
    type: 'fileExists',
    looks: 'the answer file was renamed instead of written',
    setup: (dir) => write(dir, 'answer.txt', '42\n'),
    check: () => ({ type: 'fileExists', path: 'answer.txt' }),
    mutate: (dir) => fs.renameSync(path.join(dir, 'answer.txt'), path.join(dir, 'answer.txt.bak')),
    detail: /file not found/,
  },
  {
    type: 'fileMissing',
    looks: 'the "deleted" name is a directory still holding the payload',
    setup: () => {},
    check: () => ({ type: 'fileMissing', path: 'scratch' }),
    mutate: (dir) => write(dir, 'scratch/kept.txt', 'still here\n'),
    detail: /unexpectedly present/,
  },
  {
    type: 'fileEquals',
    looks: 'the expectation drifts one byte from what the model wrote',
    setup: (dir) => {
      write(dir, 'answer.txt', '42\n')
      return { answer: '42' }
    },
    check: (exports) => ({ type: 'fileEquals', path: 'answer.txt', expect: 'answer' }),
    mutate: () => ({ type: 'fileEquals', path: 'answer.txt', text: '43' }),
    detail: /expected 43 \/ got 42/,
  },
  {
    type: 'fileEquals',
    looks: 'a second answer left behind, so the file is not the answer',
    setup: (dir) => write(dir, 'answer.txt', '42\n'),
    check: () => ({ type: 'fileEquals', path: 'answer.txt', text: '42' }),
    mutate: (dir) => write(dir, 'answer.txt', '42\n43\n'),
    detail: /got 42\\n43/,
  },
  {
    type: 'fileContains',
    looks: 'the needle differs from the file by letter case only',
    setup: (dir) => write(dir, 'report.txt', 'Total: 5 files\n'),
    check: () => ({ type: 'fileContains', path: 'report.txt', text: 'Total: 5' }),
    mutate: () => ({ type: 'fileContains', path: 'report.txt', text: 'total: 5' }),
    detail: /does not contain/,
  },
  {
    type: 'fileContains',
    looks: 'the check file is empty and the answer went to a different file',
    setup: (dir) => write(dir, 'report.txt', 'Total: 5 files\n'),
    check: () => ({ type: 'fileContains', path: 'report.txt', text: 'Total: 5' }),
    mutate: (dir) => {
      write(dir, 'report.txt', '')
      write(dir, 'answer.txt', 'Total: 5 files\n')
    },
    detail: /does not contain/,
  },
  {
    type: 'fileLines',
    looks: 'the same two lines in the wrong order',
    setup: (dir) => {
      write(dir, 'list.txt', 'a.txt\nb.txt\n')
      return { lines: ['a.txt', 'b.txt'] }
    },
    check: (exports) => ({ type: 'fileLines', path: 'list.txt', expect: 'lines' }),
    mutate: (dir) => write(dir, 'list.txt', 'b.txt\na.txt\n'),
    detail: /expected 2 line\(s\)/,
  },
  {
    type: 'fileLines',
    looks: 'one line short, so the count differs by one',
    setup: (dir) => write(dir, 'list.txt', 'a.txt\nb.txt\n'),
    check: () => ({ type: 'fileLines', path: 'list.txt', lines: ['a.txt', 'b.txt'] }),
    mutate: () => ({ type: 'fileLines', path: 'list.txt', lines: ['a.txt'] }),
    detail: /expected 1 line\(s\)/,
  },
  {
    type: 'countFiles',
    looks: 'a matching name that is a directory, not a file',
    setup: (dir) => {
      write(dir, 'sub/KEEP_1.txt', 'x')
      write(dir, 'sub/KEEP_2.md', 'y')
    },
    check: () => ({ type: 'countFiles', dir: 'sub', prefix: 'KEEP_', count: 2 }),
    mutate: (dir) => {
      fs.rmSync(path.join(dir, 'sub', 'KEEP_2.md'))
      write(dir, 'sub/KEEP_2.md/inner.txt', 'y')
    },
    detail: /expected 2 file\(s\) \/ got 1/,
  },
  {
    type: 'countFiles',
    looks: 'the count is off by one',
    setup: (dir) => {
      write(dir, 'sub/KEEP_1.txt', 'x')
      write(dir, 'sub/KEEP_2.md', 'y')
    },
    check: () => ({ type: 'countFiles', dir: 'sub', prefix: 'KEEP_', count: 2 }),
    mutate: () => ({ type: 'countFiles', dir: 'sub', prefix: 'KEEP_', count: 3 }),
    detail: /expected 3 file\(s\) \/ got 2/,
  },
  {
    type: 'contentHashes',
    looks: 'a byte-identical rename is still a rename',
    setup: (dir) => {
      write(dir, 'core.js', 'renamed')
      return { hashes: [{ name: 'core.js', sha256: sha('renamed') }] }
    },
    check: (exports) => ({ type: 'contentHashes', dir: '.', expect: 'hashes' }),
    mutate: (dir) => fs.renameSync(path.join(dir, 'core.js'), path.join(dir, 'core2.js')),
    detail: /missing: core\.js, unexpected: core2\.js/,
  },
  {
    type: 'contentHashes',
    looks: 'an in-place rewrite of the same length',
    setup: (dir) => {
      write(dir, 'core.js', 'renamed')
      return { hashes: [{ name: 'core.js', sha256: sha('renamed') }] }
    },
    check: (exports) => ({ type: 'contentHashes', dir: '.', expect: 'hashes' }),
    mutate: (dir) => write(dir, 'core.js', 'renamec'),
    detail: /content changed: core\.js/,
  },
  {
    type: 'contentHashes',
    looks: 'a lock sidecar that only nearly matches the tolerated name',
    setup: (dir) => {
      write(dir, 'core.js', 'renamed')
      return { hashes: [{ name: 'core.js', sha256: sha('renamed') }] }
    },
    check: (exports) => ({ type: 'contentHashes', dir: '.', expect: 'hashes' }),
    mutate: (dir) => write(dir, lockName('abc'), ''),
    detail: /unexpected: \.dsh-ops-update-abc\.lock/,
  },
  {
    type: 'command',
    looks: 'a command that prints a passing test line and exits 1',
    setup: () => {},
    check: () => ({ type: 'command', command: 'node', args: ['-e', 'process.exit(0)'], exitCode: 0 }),
    mutate: () => ({ type: 'command', command: 'node', args: ['-e', "console.log('# pass 3'); process.exit(1)"], exitCode: 0 }),
    detail: /expected exit 0 \/ got 1/,
  },
  {
    type: 'command',
    looks: 'a command the harness can never spawn',
    setup: () => {},
    check: () => ({ type: 'command', command: 'node', args: ['-e', 'process.exit(0)'], exitCode: 0 }),
    mutate: () => ({ type: 'command', command: 'definitely-not-a-real-binary-xyz', exitCode: 0 }),
    detail: /no exit code/,
  },
  {
    type: 'command',
    looks: 'the precondition that had to fail now exits 0',
    setup: () => {},
    check: () => ({ type: 'command', command: 'node', args: ['-e', 'process.exit(1)'], exitCode: 1 }),
    mutate: () => ({ type: 'command', command: 'node', args: ['-e', 'process.exit(0)'], exitCode: 1 }),
    detail: /expected exit 1 \/ got 0/,
  },
]

await test('mutation self-check: every check type catches a near miss that would look like a pass', async () => {
  // Every type must have at least one sample: a type with no mutation is a type
  // nobody has proved the verifier can fail on.
  for (const type of CHECK_TYPES) {
    assert.ok(MUTATIONS.some((sample) => sample.type === type), `no mutation sample covers ${type}`)
  }
  assert.deepEqual([...new Set(MUTATIONS.map((sample) => sample.type))].sort(), [...CHECK_TYPES].sort())
  for (const sample of MUTATIONS) {
    await withTempDir(`bench-mutate-${sample.type}`, async (dir) => {
      const exports = sample.setup(dir) ?? {}
      const honest = sample.check(exports)
      const before = await verifyWorkspace(dir, [honest], exports)
      assert.equal(before.passed, true, `${sample.type}: the honest tree must pass first — ${before.checks[0].detail}`)
      const mutated = sample.mutate(dir, exports) ?? honest
      const after = await verifyWorkspace(dir, [mutated], exports)
      assert.equal(after.passed, false, `${sample.type}: ${sample.looks} — the check passed anyway`)
      assert.match(after.checks[0].detail, sample.detail, `${sample.type}: the failure must name its reason`)
    })
  }
})

report(LABEL)
