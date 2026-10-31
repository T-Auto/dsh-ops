/**
 * P14's gate: the real-corpus, host-dispatched comparison. Shape and hash are the whole
 * contract — a number filed under a tree nobody described is not evidence — and this suite
 * proves the refusals without booting a host, so it runs in the default gate.
 *
 * @module dsh-ops/test/bench-calls
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { describe, treeHash, sampleHash, checkShape } from '../bench/calls/shape.mjs'
import { readManifest, loadManifests, expandRoot, resolveRoot, adaptCase, identityOf, compareIdentities } from '../bench/calls/corpora.mjs'
import { main, parseArgs, median, defaultWorker, coverageOf, converge, MAX_REPEAT } from '../bench/calls/index.mjs'

const LABEL = 'bench-calls'

/** Build a small tree with one binary-extension file and one nested directory. */
function buildTree(root) {
  fs.mkdirSync(path.join(root, 'nested', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n')
  fs.writeFileSync(path.join(root, 'nested', 'deep', 'b.txt'), 'world\n')
  fs.writeFileSync(path.join(root, 'nested', 'blob.dll'), Buffer.alloc(1000, 7))
  return root
}

await test('shape counts files, depth and binary bytes without reading contents', async () => {
  await withTempDir('calls-shape', async root => {
    buildTree(root)
    const shape = describe(root)
    assert.equal(shape.files, 3)
    assert.equal(shape.directories, 2)
    assert.equal(shape.maxDepth, 2)
    assert.equal(shape.binaryFiles, 1)
    assert.equal(shape.binaryBytes, 1000)
    assert.equal(shape.bytes, 'hello\n'.length + 'world\n'.length + 1000)
    assert.ok(shape.binaryBytesRatio > 0.9)
  })
})

await test('a corpus outside its declared shape is refused, and the ranges are honoured at both ends', () => {
  const shape = { files: 3, mebibytes: 0, maxDepth: 2, binaryBytesRatio: 0.99 }
  assert.equal(checkShape(shape, { files: [3, 3], maxDepth: [0, 2] }).ok, true)
  const verdict = checkShape(shape, { files: [4, 10], binaryBytesRatio: [0, 0.5] })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.problems.length, 2)
  assert.match(verdict.problems[0], /files=3 outside \[4, 10\]/)
  assert.throws(() => checkShape(shape, { files: [1] }), /must be \[min, max\]/)
  assert.throws(() => checkShape(shape, { nope: [0, 1] }), /not a measured field/)
})

await test('the tree hash is stable for one tree and changes with the input', async () => {
  await withTempDir('calls-hash', async root => {
    buildTree(root)
    const first = treeHash(root)
    assert.equal(treeHash(root), first)
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello again\n')
    assert.notEqual(treeHash(root), first)
  })
})

await test('a recorded identity expectation is a lock, not a note', async () => {
  await withTempDir('calls-expect', async root => {
    const tree = buildTree(path.join(root, 'tree'))
    const provenance = path.join(root, 'lock.json')
    fs.writeFileSync(provenance, '{"locked":true}')
    const template = '${root}/../lock.json'
    const pinned = { id: 'tiny', identity: { files: [template], expect: { [template]: 'a'.repeat(64) }, sample: 0 } }
    assert.throws(() => identityOf(pinned, tree, { repoRoot: root }), /is not the pinned version/)
    const actual = identityOf({ id: 'tiny', identity: { files: [template], sample: 0 } }, tree, { repoRoot: root }).files[0].sha256
    assert.equal(identityOf({ id: 'tiny', identity: { files: [template], expect: { [template]: actual }, sample: 0 } }, tree, { repoRoot: root }).files[0].sha256, actual)
  })
})

await test('the sample hash moves with content, not with the sampled rule', async () => {
  await withTempDir('calls-sample', async root => {
    buildTree(root)
    const first = sampleHash(root, { count: 2 })
    assert.equal(first.files, 2)
    assert.ok(first.bytes > 0)
    assert.equal(sampleHash(root, { count: 2 }).hash, first.hash)
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n')
    assert.notEqual(sampleHash(root, { count: 2 }).hash, first.hash)
    assert.equal(sampleHash(root, { count: 0 }).hash, null)
    assert.throws(() => sampleHash(root, { count: -1 }), /non-negative/)
  })
})

await test('a corpus identity is its provenance files plus a content sample, and differences are named', async () => {
  await withTempDir('calls-identity', async root => {
    const tree = buildTree(path.join(root, 'tree'))
    const provenance = path.join(root, 'lock.json')
    fs.writeFileSync(provenance, '{"locked":true}')
    const manifest = { id: 'tiny', identity: { files: ['${root}/../lock.json'], sample: 4 } }
    const current = identityOf(manifest, tree, { repoRoot: root })
    assert.equal(current.files.length, 1)
    assert.match(current.files[0].path, /lock\.json$/)
    assert.equal(current.combined.length, 64)
    assert.deepEqual(compareIdentities(current, current), [])

    const movedLock = JSON.parse(JSON.stringify(current))
    movedLock.files[0].sha256 = 'f'.repeat(64)
    assert.match(compareIdentities(current, movedLock)[0], /lock\.json differs/)

    const movedTree = JSON.parse(JSON.stringify(current))
    movedTree.sample.hash = 'e'.repeat(64)
    assert.match(compareIdentities(current, movedTree)[0], /tree sample differs/)

    assert.match(compareIdentities(current, { files: [], sample: { hash: null } }).join(' '), /identity file not in baseline/)
    assert.throws(() => identityOf({ id: 'tiny', identity: { files: ['${root}/missing.lock'], sample: 0 } }, tree, { repoRoot: root }), /identity file missing/)
  })
})

await test('a baseline with a different corpus version is refused before any host boots', async () => {
  await withTempDir('calls-baseline', async root => {
    const tree = buildTree(path.join(root, 'tree'))
    const manifest = {
      id: 'tiny', class: 'test', file: path.join(root, 'tiny.json'),
      roots: [path.join(root, 'absent')], shape: { files: [1, 10], maxDepth: [0, 3] },
      identity: { sample: 4 },
      cases: [{ id: 'grep-miss', tool: 'grep', args: { pattern: 'needle', path: '.' } }],
    }
    const io = { out: () => {}, err: () => {}, manifests: [manifest] }
    const matching = path.join(root, 'matching.json')
    const identity = identityOf(manifest, tree, { repoRoot: root })
    fs.writeFileSync(matching, JSON.stringify({ format: 'dsh-ops-calls-v1', corpora: [{ id: 'tiny', identity }] }))
    assert.equal(await main(['--dry-run', '--corpus', 'tiny', '--root', tree, '--baseline', matching], io), 0)

    const drifted = path.join(root, 'drifted.json')
    fs.writeFileSync(drifted, JSON.stringify({ format: 'dsh-ops-calls-v1', corpora: [{ id: 'tiny', identity: { ...identity, sample: { ...identity.sample, hash: 'a'.repeat(64) } } }] }))
    const lines = []
    assert.equal(await main(['--dry-run', '--corpus', 'tiny', '--root', tree, '--baseline', drifted], { ...io, err: line => lines.push(line) }), 1)
    assert.match(lines.join('\n'), /not the same software version/)
    assert.match(lines.join('\n'), /tree sample differs/)
  })
})

await test('a manifest with a typo, a duplicate id or an unknown tool fails by name', async () => {
  await withTempDir('calls-manifest', async root => {
    const write = (name, document) => {
      const file = path.join(root, name)
      fs.writeFileSync(file, JSON.stringify(document))
      return file
    }
    const base = { id: 'tiny', roots: ['${repo}/node_modules'], identity: { sample: 4 }, cases: [{ id: 'grep-miss', tool: 'grep', args: { pattern: 'x', path: '.' } }] }
    assert.throws(() => readManifest(write('bare.json', { ...base, identity: undefined })), /identity is required/)
    assert.throws(() => readManifest(write('ident.json', { ...base, identity: { files: [], sample: 0 } })), /identity needs files or a positive sample/)
    assert.equal(readManifest(write('ok.json', base)).id, 'tiny')
    assert.throws(() => readManifest(write('typo.json', { ...base, colour: 'red' })), /unknown field "colour"/)
    assert.throws(() => readManifest(write('dup.json', { ...base, cases: [base.cases[0], base.cases[0]] })), /duplicate case id/)
    assert.throws(() => readManifest(write('tool.json', { ...base, cases: [{ id: 'x', tool: 'sed', args: { pattern: 'x' } }] })), /unknown tool "sed"/)
    assert.throws(() => readManifest(write('range.json', { ...base, id: 'Tiny' })), /lower-case/)
    // A directory load must be all-or-nothing: the broken files above are in `root`, so
    // only the clean subdirectory is loadable.
    const clean = path.join(root, 'clean')
    fs.mkdirSync(clean)
    fs.copyFileSync(path.join(root, 'ok.json'), path.join(clean, 'ok.json'))
    assert.deepEqual(loadManifests(clean).map(manifest => manifest.id), ['tiny'])
  })
})

await test('roots expand only the three documented placeholders and must exist', async () => {
  await withTempDir('calls-roots', async root => {
    const manifest = { id: 'tiny', roots: ['${repo}/node_modules'] }
    assert.equal(expandRoot('${repo}/src', { repoRoot: root, home: root, env: {} }), path.join(root, 'src'))
    assert.equal(expandRoot('${home}/x', { repoRoot: root, home: root, env: {} }), path.join(root, 'x'))
    assert.throws(() => expandRoot('${env:DSH_OPS_CALLS_MISSING}/x', { repoRoot: root, env: {} }), /is not set/)
    assert.throws(() => resolveRoot(manifest, { repoRoot: root, home: root, env: {} }), /no corpus root exists/)
    assert.throws(() => resolveRoot(manifest, { repoRoot: root, override: path.join(root, 'absent') }), /does not exist/)
    assert.equal(resolveRoot(manifest, { repoRoot: root, override: root }), root)
  })
})

await test('one logical query maps to the two projections without inventing arguments', () => {
  const name = logical => `ops_${logical}`
  const grep = { id: 'g', tool: 'grep', args: { pattern: 'needle', path: '.' } }
  assert.deepEqual(adaptCase(grep, 'official', name), { name: 'grep', args: { pattern: 'needle', path: '.' } })
  assert.deepEqual(adaptCase(grep, 'candidate', name), { name: 'ops_grep', args: { pattern: 'needle', path: '.', outputMode: 'summary' } })
  const glob = { id: 'p', tool: 'glob', args: { pattern: '**/*.ts', path: '.' } }
  assert.deepEqual(adaptCase(glob, 'official', name).args, { pattern: '**/*.ts', path: '.' })
  assert.deepEqual(adaptCase(glob, 'candidate', name).args, { pattern: ['**/*.ts'], path: '.', outputMode: 'paths', sort: 'path', limit: 100 })
  assert.equal(adaptCase({ ...glob, candidate: { limit: 5 } }, 'candidate', name).args.limit, 5)
  assert.throws(() => adaptCase(grep, 'nope', name), /unknown projection/)
})

await test('bounded grep preserves the shared include filter and changes only OPS arguments', () => {
  const item = { tool: 'grep', args: { pattern: '^export ', path: '.', include: '**/*.ts' },
    candidate: { outputMode: 'content', limit: 5, exactTotal: false } }
  assert.deepEqual(adaptCase(item, 'official').args, item.args)
  assert.deepEqual(adaptCase(item, 'candidate', name => `ops_${name}`).args,
    { pattern: '^export ', path: '.', glob: ['**/*.ts'], outputMode: 'content', limit: 5, exactTotal: false })
})

await test('in-budget corpora pair exact and bounded hits, over-budget ones keep the coverage baseline', () => {
  // The eight-case matrix answers #384 only where a scan can complete: `exactTotal=true` needs a
  // full count, and a corpus past the 10,000-file / 256 MiB budget never produces one — its hit
  // pair would compare two partial scans. The over-budget corpora therefore keep the coverage
  // baseline (one unfiltered miss, one extension glob) plus the filename and no-match globs, and
  // declare no hit pair. This is the completeness contract for both groups.
  const overBudget = new Set(['rust-runtime'])
  const manifests = loadManifests()
  assert.equal(manifests.filter(manifest => overBudget.has(manifest.id)).length, overBudget.size,
    'both over-budget corpora are shipped')
  for (const manifest of manifests) {
    assert.ok(manifest.cases.some(item => item.id === 'grep-miss'), `${manifest.id}: keeps the unfiltered no-hit scan`)
    assert.equal(manifest.cases.find(item => item.id === 'glob-name')?.tool, 'glob', `${manifest.id}: has an exact-basename glob`)
    assert.equal(manifest.cases.find(item => item.id === 'glob-miss')?.tool, 'glob', `${manifest.id}: has a no-match glob`)
    const globs = manifest.cases.filter(item => item.tool === 'glob')
    assert.equal(globs.length, 3, `${manifest.id}: one extension, one basename and one no-match glob`)
    const hits = manifest.cases.filter(item => item.id.startsWith('grep-hit-'))
    if (overBudget.has(manifest.id)) {
      assert.deepEqual(hits, [], `${manifest.id}: a budgeted scan cannot support a hit pair`)
      assert.equal(manifest.cases.length, 4, `${manifest.id}: four coverage cases`)
      continue
    }
    for (const limit of [5, 50]) {
      const exact = manifest.cases.find(item => item.id === `grep-hit-${limit}-exact`)
      const bounded = manifest.cases.find(item => item.id === `grep-hit-${limit}-bounded`)
      assert.ok(exact && bounded, `${manifest.id}: missing #384 pair at limit ${limit}`)
      assert.deepEqual(exact.args, bounded.args)
      assert.ok(exact.args.include, `${manifest.id}: the pair keeps the shared include filter`)
      assert.deepEqual(exact.candidate, { outputMode: 'content', limit, exactTotal: true })
      assert.deepEqual(bounded.candidate, { ...exact.candidate, exactTotal: false })
    }
    assert.equal(manifest.cases.length, 8, `${manifest.id}: eight cases, one per question`)
  }
})

await test('argv rejects a missing destination, a bad repeat and an unknown projection', () => {
  assert.throws(() => parseArgs([]), /--out is required/)
  assert.throws(() => parseArgs(['--out', 'x', '--repeat', '0']), /1\.\.10/)
  assert.throws(() => parseArgs(['--out', 'x', '--repeat', String(MAX_REPEAT + 1)]), /1\.\./)
  assert.throws(() => parseArgs(['--out', 'x', '--projection', 'official,nope']), /unknown projection/)
  assert.throws(() => parseArgs(['--out', 'x', '--root', 'y']), /exactly one --corpus/)
  assert.throws(() => parseArgs(['--out', 'x', '--warmup', '6']), /0\.\.5/)
  assert.equal(parseArgs(['--out', 'x', '--warmup', '0']).warmup, 0)
  assert.equal(parseArgs(['--out', 'x']).warmup, 1)
  assert.throws(() => parseArgs(['--out', 'x', '--wat', 'y']), /unknown flag/)
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['--dry-run']).dryRun, true)
  assert.deepEqual(parseArgs(['--out', 'x', '--corpus', 'a', '--corpus', 'a', '--projection', 'candidate,official,candidate']).projections, ['candidate', 'official'])
  assert.match(defaultWorker(), /dsh-ops-worker/)
  assert.equal(parseArgs(['--out', 'x', '--plugin-root', '/tmp/checkout']).pluginRoot, '/tmp/checkout')
  assert.ok(defaultWorker('/tmp/checkout').startsWith(path.join('/tmp/checkout', 'native')))
})

await test('a dry run describes the corpus and boots nothing, and a shape break exits 1', async () => {
  await withTempDir('calls-dry', async root => {
    const tree = buildTree(path.join(root, 'tree'))
    const manifest = {
      id: 'tiny', class: 'test', file: path.join(root, 'tiny.json'),
      roots: [path.join(root, 'absent')], shape: { files: [1, 10], maxDepth: [0, 3] },
      identity: { files: [path.join(tree, 'a.txt')], sample: 4 },
      cases: [{ id: 'grep-miss', tool: 'grep', args: { pattern: 'needle', path: '.' } }],
    }
    const lines = []
    const io = { out: line => lines.push(line), err: line => lines.push(line), manifests: [manifest] }
    assert.equal(await main(['--dry-run', '--corpus', 'tiny', '--root', tree], io), 0)
    assert.match(lines.join('\n'), /files=3/)
    assert.match(lines.join('\n'), /dry run, no host booted/)
    assert.equal(await main(['--dry-run', '--corpus', 'nope', '--root', tree], io), 2)
    assert.equal(await main(['--dry-run', '--corpus', 'tiny', '--root', tree], { ...io, manifests: [{ ...manifest, shape: { files: [1000, 2000] } }] }), 1)
    assert.match(lines.join('\n'), /outside its declared shape/)
  })
})

await test('a partly valid corpus selection refuses every unknown id before resolving inputs', async () => {
  const lines = []
  const code = await main(['--dry-run', '--corpus', 'known', '--corpus', 'typo', '--corpus', 'another-typo'], {
    manifests: [{ id: 'known', roots: ['missing'], cases: [] }], out: () => {}, err: line => lines.push(line),
  })
  assert.equal(code, 2)
  assert.match(lines.join('\n'), /unknown corpus.*typo.*another-typo/)
})

await test('an existing report path is refused before anything is measured', async () => {
  await withTempDir('calls-overwrite', async root => {
    const output = path.join(root, 'report.json')
    fs.writeFileSync(output, 'previous evidence')
    const lines = []
    assert.equal(await main(['--out', output], { out: line => lines.push(line), err: line => lines.push(line), manifests: [] }), 2)
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous evidence')
    assert.match(lines.join('\n'), /refusing to overwrite/)
  })
})

await test('a series is steady only when its tail is flat, and the first touch is kept separate', () => {
  assert.deepEqual(converge([]), { steadyMs: null, convergedAt: null })
  assert.deepEqual(converge([30000, 4800, 1150]), { steadyMs: 1150, convergedAt: 3 })
  assert.deepEqual(converge([2000, 1000]), { steadyMs: 1000, convergedAt: 2 })
  assert.deepEqual(converge([100, 102, 99]), { steadyMs: 100, convergedAt: 1 })
})

await test('coverage facts come from the search notice, and a plain result has none', () => {
  const notice = ['changed=0', '[Notice: scanComplete=false; pageComplete=true; scannedFiles=1024; skippedFiles=127; skipReasons={"oversized":4}; matchedObserved=0.]', '[Notice: 0 items displayed; complete=false; TruncatedBy: scan-budget; nextOffset=0; matched=0.]'].join('\n')
  assert.deepEqual(coverageOf(notice), { scannedFiles: 1024, scanComplete: false, skippedFiles: 127, truncatedBy: 'scan-budget',
    matchedObserved: 0, matchedTotal: null, displayedItems: 0 })
  assert.equal(coverageOf('scannedFiles=20; matchedObserved=5; matchedTotal=15; 5 items displayed').matchedTotal, 15)
  assert.equal(coverageOf('scannedFiles=20; matchedObserved=1; matchedTotal=1; 1 item displayed').displayedItems, 1)
  assert.equal(coverageOf('src/a.ts:3: needle'), null)
})

await test('the median is the paired statistic and an even count averages the middle pair', () => {
  assert.equal(median([]), null)
  assert.equal(median([5]), 5)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([1, 2, 3, 10]), 2.5)
})

report(LABEL)
