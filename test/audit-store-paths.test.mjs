/** Public paths cannot address private audit records; trusted lifecycle APIs still can. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, callWorker, request, envelopeOf, requireWorker } from './lib/boundary.mjs'

requireWorker('audit-store-paths')
const content = 'reserved needle\n'
const hash = value => createHash('sha256').update(value).digest('hex')
const call = async (root, tool, args, options = {}) =>
  envelopeOf(await callTool(tool, args, { root, writeRoots: [root], ...options }), assert)
const denied = value => {
  assert.equal(value.status, 'error', JSON.stringify(value))
  assert.equal(value.error.code, 'PATH_RESTRICTED', JSON.stringify(value))
  assert.equal(value.error.effectState, 'none', JSON.stringify(value))
  assert.equal(value.error.retryable, false)
}
const snapshot = root => fs.readdirSync(root, { recursive: true }).sort().map(name => {
  const file = path.join(root, name)
  return [name, fs.statSync(file).isFile() ? fs.readFileSync(file).toString('hex') : null]
})
const variants = [
  ['lowercase ancestor', ['.dsh-ops', 'record.txt']],
  ['mixed-case nested ancestor', ['nested', '.DsH-OpS', 'deep', 'record.txt']],
  ['uppercase final component', ['final', '.DSH-OPS']],
]
const fixture = (parts, body) => withTempDir('audit-paths', async root => {
  const target = path.join(root, ...parts), ordinary = path.join(root, 'ordinary.txt')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  fs.writeFileSync(ordinary, content)
  await body(root, target, ordinary)
})
const operations = [
  ['write_file', (target) => ({ path: target, content: 'changed', expectedRevision: hash(content) })],
  ['edit_file', (target) => ({ path: target, edits: [{ oldText: 'needle', newText: 'changed' }], expectedRevision: hash(content) })],
  ['copy source', (target, ordinary, root) => ({ path: target, to: path.join(root, 'copied.txt'), expectedRevision: hash(content) })],
  ['copy destination', (target, ordinary) => ({ path: ordinary, to: target, expectedRevision: hash(content) })],
  ['move source', (target, ordinary, root) => ({ path: target, to: path.join(root, 'moved.txt'), expectedRevision: hash(content) })],
  ['move destination', (target, ordinary) => ({ path: ordinary, to: target, expectedRevision: hash(content) })],
  ['remove', target => ({ path: target, expectedRevision: hash(content) })],
  ['inspect_local_file', target => ({ path: target })],
  ['stat', target => ({ path: target })],
  ['diff', target => ({ path: target, content: 'changed' })],
  ['read_table', target => ({ path: target })],
  ['read_docx', target => ({ path: target })],
  ['read_pdf', target => ({ path: target })],
  ['grep', target => ({ path: target, pattern: 'needle' })],
  ['replace', target => ({ path: target, pattern: 'needle', replacement: 'changed' })],
]

for (const [label, parts] of variants) {
  for (const [operation, args] of operations) {
    await test(`${operation} refuses ${label} without filesystem effects`, async () => {
      await fixture(parts, async (root, target, ordinary) => {
        // Destinations must be absent so no-clobber cannot mask the reserved-path error.
        if (operation.endsWith('destination')) fs.unlinkSync(target)
        const before = snapshot(root)
        const value = await call(root, operation.split(' ')[0], args(target, ordinary, root))
        assert.deepEqual(snapshot(root), before, JSON.stringify(value))
        denied(value)
      })
    })
  }
  await test(`read_files refuses ${label} per item while retaining ordinary neighbors`, async () => {
    await fixture(parts, async (root, target, ordinary) => {
      const before = snapshot(root)
      const value = await call(root, 'read_files', { files: [{ path: ordinary }, { path: target }, { path: ordinary }] }, { readOnly: true })
      assert.equal(value.status, 'partial')
      assert.equal(value.complete, false)
      assert.equal(value.failed, 1)
      assert.equal(value.pending, 0)
      denied(value.items[1])
      assert.deepEqual(value.items[1].items, [])
      assert.equal(value.items[0].revision, hash(content))
      assert.equal(value.items[2].revision, hash(content))
      assert.deepEqual(snapshot(root), before)
    })
  })
  for (const operation of ['write_file', 'stat']) {
    await test(`${operation} refuses missing ${label} rather than accepting absent`, async () => {
      await fixture(parts, async (root, target) => {
        fs.unlinkSync(target)
        const before = snapshot(root)
        const args = operation === 'stat' ? { path: target } : { path: target, content, expectedRevision: 'absent' }
        denied(await call(root, operation, args))
        assert.deepEqual(snapshot(root), before)
      })
    })
  }
}

for (const spelling of ['.dsh-ops', '.DsH-OpS']) {
  await test(`glob refuses an explicitly requested ${spelling} directory`, async () => {
    await fixture([spelling, 'record.txt'], async (root, target) => {
      const before = snapshot(root)
      denied(await call(root, 'glob', { path: path.dirname(target), pattern: ['**/*'] }))
      denied(await call(root, 'grep', { path: path.dirname(target), pattern: 'needle' }))
      denied(await call(root, 'replace', { path: path.dirname(target), pattern: 'needle', replacement: 'changed' }))
      assert.deepEqual(snapshot(root), before)
    })
  })
}

await test('reserved ancestors above the session cwd are not an alternate entrance', async () => {
  await fixture(['.DsH-OpS', 'workspace', 'record.txt'], async (root, target) => {
    const before = snapshot(root), cwd = path.dirname(target)
    denied(await call(cwd, 'inspect_local_file', { path: target }))
    denied(await call(cwd, 'write_file', { path: target, content: 'changed', expectedRevision: hash(content) }))
    assert.deepEqual(snapshot(root), before)
  })
})

await test('ordinary search excludes hidden audit directories without introducing a coverage gap', async () => {
  await withTempDir('audit-search', async root => {
    fs.writeFileSync(path.join(root, 'visible.txt'), content)
    for (const name of ['.dsh-ops', 'nested/.DsH-OpS', '.dsh-ops-backup']) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
      fs.writeFileSync(path.join(root, name, 'record.txt'), content)
    }
    const before = snapshot(root)
    for (const [tool, args] of [
      ['glob', { pattern: ['**/*'] }],
      ['grep', { pattern: 'needle' }],
    ]) {
      const value = await call(root, tool, { path: root, ...args })
      assert.equal(value.status, 'completed', JSON.stringify(value))
      assert.equal(value.complete, true, JSON.stringify(value))
      assert.equal(value.items.length, 1)
      assert.ok(JSON.stringify(value.items).includes('visible.txt'))
      assert.equal(value.skipReasons?.['invalid-path'] ?? 0, 0)
    }
    assert.deepEqual(snapshot(root), before)
    const replaced = await call(root, 'replace', { path: root, pattern: 'needle', replacement: 'changed' })
    assert.equal(replaced.status, 'completed', JSON.stringify(replaced))
    assert.equal(fs.readFileSync(path.join(root, 'visible.txt'), 'utf8'), 'reserved changed\n')
    for (const [name, bytes] of before) {
      if (bytes !== null && name !== 'visible.txt') assert.equal(fs.readFileSync(path.join(root, name)).toString('hex'), bytes)
    }
  })
})

await test('near names remain usable through real write/edit/read/stat/copy/move/remove/search calls', async () => {
  await withTempDir('audit-near', async root => {
    const dir = path.join(root, '.dsh-ops-backup'); fs.mkdirSync(dir)
    const target = path.join(dir, '.dsh-ops.json')
    assert.equal((await call(root, 'write_file', { path: target, content, expectedRevision: 'absent' })).status, 'completed')
    assert.equal((await call(root, 'edit_file', { path: target, expectedRevision: hash(content), edits: [{ oldText: 'needle', newText: 'changed' }] })).status, 'completed')
    const revision = hash('reserved changed\n')
    assert.equal((await call(root, 'stat', { path: target })).revision, revision)
    assert.equal((await call(root, 'inspect_local_file', { path: target })).revision, revision)
    assert.equal((await call(root, 'read_files', { files: [{ path: target }] })).items[0].revision, revision)
    assert.equal((await call(root, 'diff', { path: target, content })).status, 'completed')
    assert.equal((await call(root, 'grep', { path: target, pattern: 'changed' })).items.length, 1)
    assert.equal((await call(root, 'glob', { path: dir, pattern: ['**/*'] })).status, 'completed')
    const copy = path.join(dir, 'copied'), moved = path.join(dir, 'moved')
    assert.equal((await call(root, 'copy', { path: target, to: copy, expectedRevision: revision })).status, 'completed')
    assert.equal((await call(root, 'move', { path: copy, to: moved, expectedRevision: revision })).status, 'completed')
    assert.equal((await call(root, 'remove', { path: moved, expectedRevision: revision })).status, 'completed')
    assert.equal(fs.existsSync(copy), false)
    assert.equal(fs.existsSync(moved), false)
  })
})

await test('relative batch source, destination and protect paths retain PATH_RESTRICTED', async () => {
  await withTempDir('audit-relative', async root => {
    fs.writeFileSync(path.join(root, 'ordinary.txt'), content)
    for (const reserved of ['.dsh-ops', 'nested/.DsH-OpS/record.txt']) {
      for (const args of [
        { operations: [{ op: 'remove', path: reserved }] },
        { operations: [{ op: 'copy', path: 'ordinary.txt', to: reserved }] },
        { operations: [{ op: 'move', path: reserved, to: 'moved' }] },
        { operations: [{ op: 'remove', path: 'ordinary.txt' }], protect: [reserved] },
      ]) denied(await call(root, 'batch', { action: 'plan', ...args }))
    }
    assert.equal(fs.readFileSync(path.join(root, 'ordinary.txt'), 'utf8'), content)
  })
})

await test('public write cannot plant a forged pending manifest for batch resume (#329)', async () => {
  await withTempDir('audit-forgery', async root => {
    const victim = path.join(root, 'victim.txt'); fs.writeFileSync(victim, content)
    const plan = await call(root, 'batch', { action: 'plan', operations: [{ op: 'remove', path: 'victim.txt' }] })
    assert.equal(plan.status, 'planned', JSON.stringify(plan))
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.dsh-ops', `${plan.id}.000000.json`), 'utf8'))
    const id = `j-${randomUUID()}`, target = path.join(root, '.dsh-ops', `${id}.000000.json`)
    manifest.id = id
    const before = snapshot(root)
    denied(await call(root, 'write_file', { path: target, content: JSON.stringify(manifest), expectedRevision: 'absent' }))
    assert.deepEqual(snapshot(root), before)
    const resumed = await call(root, 'batch', { action: 'resume', id })
    assert.equal(resumed.error.code, 'NOT_FOUND', JSON.stringify(resumed))
    assert.equal(fs.readFileSync(victim, 'utf8'), content)
  })
})

await test('trusted batch plan/resume and legacy result put/page/release retain audit access', async () => {
  await withTempDir('audit-lifecycle', async root => {
    const victim = path.join(root, 'victim.txt'); fs.writeFileSync(victim, content)
    const plan = await call(root, 'batch', { action: 'plan', operations: [{ op: 'remove', path: 'victim.txt' }] })
    assert.equal(plan.status, 'planned', JSON.stringify(plan))
    const done = await call(root, 'batch', { action: 'resume', id: plan.id })
    assert.equal(done.status, 'completed', JSON.stringify(done))
    assert.equal(done.done, 1)
    assert.equal(fs.existsSync(victim), false)
    assert.equal((await call(root, 'batch', { action: 'resume', id: plan.id })).done, 1)
    const audit = await call(root, 'result', { action: 'page', id: plan.id }, { readOnly: true })
    assert.equal(audit.complete, true)
    assert.equal(audit.items[0].state, 'completed')
    fs.writeFileSync(victim, content)
    const run = await call(root, 'batch', { action: 'run', operations: [{ op: 'copy', path: 'victim.txt', to: 'copy.txt' }] })
    assert.equal(run.status, 'completed', JSON.stringify(run))
    assert.equal(fs.readFileSync(path.join(root, 'copy.txt'), 'utf8'), content)
    const stored = await call(root, 'result', { action: 'put', items: [{ trusted: true }] })
    assert.ok(stored.id?.startsWith('r-'), JSON.stringify(stored))
    const page = await call(root, 'result', { action: 'page', id: stored.id }, { readOnly: true })
    assert.deepEqual(page.items, [{ trusted: true }])
    assert.equal((await call(root, 'result', { action: 'release', id: stored.id })).status, 'released')
    assert.ok(fs.readdirSync(path.join(root, '.dsh-ops')).some(name => name.startsWith(plan.id)))
  })
})

await test('trusted session cache put/page/release remains independent of the public path guard', async () => {
  await withTempDir('audit-cache', async root => {
    const cache = path.join(root, 'cache'); fs.mkdirSync(cache, { mode: 0o700 })
    const invoke = async args => envelopeOf(await callWorker(JSON.stringify({
      version: 1, requestId: 'audit-cache', component: 'ptc',
      budget: { timeoutMs: 30000, maxBytes: 131072 },
      storage: { root: cache, authorityId: 'a'.repeat(64), allowedTools: ['result', 'batch'] },
      request: request('result', args, { root, writeRoots: [] }),
    })), assert)
    const stored = await invoke({ action: 'put', items: [{ trusted: 'cache' }] })
    assert.equal(stored.status, 'completed', JSON.stringify(stored))
    assert.ok(stored.id.startsWith('ref://'))
    assert.deepEqual((await invoke({ action: 'page', id: stored.id })).items, [{ trusted: 'cache' }])
    assert.equal((await invoke({ action: 'release', id: stored.id })).status, 'released')
    assert.equal(fs.existsSync(path.join(root, '.dsh-ops')), false)
  })
})

report('audit-store-paths')
