/** Real-worker regressions for the grep definitions output mode. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('grep-definitions')
const run = async (root, args) => envelopeOf(await callTool('grep', { path: root, pattern: 'greet', ...args }, { root }), assert)

await test('definitions returns declaration lines and keeps references out of the page', () => {
  return withTempDir('grep-definitions', async root => {
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src/greet.ts'), 'export function greet(name) {\n  return name\n}\nconst call = greet("a")\n')
    fs.writeFileSync(path.join(root, 'src/calls.ts'), 'greet("b")\nconst other = greet("c")\n')
    fs.writeFileSync(path.join(root, 'notes.md'), 'greet is described here in prose\n')
    const value = await run(root, { outputMode: 'definitions' })
    assert.equal(value.status, 'completed')
    assert.equal(value.items.length, 1, JSON.stringify(value))
    assert.equal(value.items[0].line, 1)
    assert.equal(value.items[0].kind, 'function')
    assert.ok(value.items[0].path.endsWith('greet.ts'))
    assert.match(value.items[0].text, /function greet/)
    // Five lines contain the identifier; one is a declaration. `matched` counts
    // every matching line, `total` counts the returned declarations.
    assert.equal(value.matched, 5)
    assert.equal(value.total, 1)
    assert.equal(value.complete, true)
    assert.equal(value.omitted, 0)
  })
})

await test('definitions pages the declaration domain, not the reference domain', () => {
  return withTempDir('grep-definitions-pages', async root => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'function greet() {}\n')
    fs.writeFileSync(path.join(root, 'b.ts'), 'const greet = 1\n')
    fs.writeFileSync(path.join(root, 'c.ts'), 'greet()\n')
    const first = await run(root, { outputMode: 'definitions', limit: 1 })
    assert.equal(first.items.length, 1, JSON.stringify(first))
    assert.equal(first.total, 2)
    assert.equal(first.omitted, 1)
    assert.equal(first.nextOffset, 1)
    assert.equal(typeof first.continuation, 'string')
    const last = await run(root, { outputMode: 'definitions', limit: 1, continuation: first.continuation })
    assert.equal(last.items.length, 1, JSON.stringify(last))
    assert.equal(last.items[0].kind, 'variable')
    assert.equal(last.complete, true)
    assert.equal(last.omitted, 0)
  })
})

await test('definitions refuses shapes it cannot classify and reports a reference-only scan honestly', () => {
  return withTempDir('grep-definitions-refusals', async root => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'function greet() {}\n')
    for (const args of [{ multiline: true }, { beforeContext: 1 }, { afterContext: 1 }]) {
      const refusal = envelopeOf(await callTool('grep', { path: root, pattern: 'greet', outputMode: 'definitions', ...args }, { root }), assert)
      assert.equal(refusal.status, 'error', JSON.stringify(refusal))
      assert.equal(refusal.error.code, 'INVALID_ARGUMENT', JSON.stringify(refusal))
    }
    fs.rmSync(path.join(root, 'a.ts'))
    fs.writeFileSync(path.join(root, 'calls.ts'), 'greet("a")\ngreet("b")\n')
    const value = await run(root, { outputMode: 'definitions' })
    assert.equal(value.items.length, 0, JSON.stringify(value))
    assert.equal(value.matched, 2)
    assert.equal(value.total, 0)
    assert.equal(value.complete, true)
  })
})

await test('content mode keeps returning every matching line', () => {
  return withTempDir('grep-definitions-content', async root => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'function greet() {}\ngreet()\n')
    const value = await run(root, {})
    assert.equal(value.items.length, 2, JSON.stringify(value))
    assert.equal(value.matched, 2)
  })
})

report('grep-definitions')
