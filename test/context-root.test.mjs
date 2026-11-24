import fs from 'node:fs'
import path from 'node:path'
import { rootOf } from '../lib/adapter/dsh/root.js'
import { acquireResultAdmission } from '../lib/publication/result-admission.js'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const ROOT = Symbol.for('cordis.root')
// Cordis 4.2 shape: no `root` property; an undeclared read throws, the symbol key resolves.
const strictContext = (root, extra = {}) => new Proxy({ ...extra, [ROOT]: root }, {
  get(target, prop) {
    if (typeof prop === 'symbol' || prop in target) return target[prop]
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
})

await test('rootOf resolves the Cordis 4.2 symbol root without touching undeclared properties', () => {
  const root = {}
  assert.equal(rootOf(strictContext(root)), root)
})

await test('rootOf keeps the Cordis 4.1 root property', () => {
  const root = {}
  assert.equal(rootOf({ root }), root)
})

await test('rootOf treats a context with no root as its own root', () => {
  const alone = {}
  assert.equal(rootOf(alone), alone)
  const strictAlone = strictContext(undefined)
  assert.equal(rootOf(strictAlone), strictAlone)
})

await test('a plugin entry point runs against a context that refuses undeclared property reads', () => {
  const root = {}, listeners = []
  const ctx = strictContext(root, { on: (name, listener) => { listeners.push(name); return () => {} } })
  const admission = acquireResultAdmission(ctx)
  assert.ok(listeners.length > 0)
  admission.dispose()
})

await test('no source file reads ctx.root directly', () => {
  const offenders = []
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (/\.(?:ts|tsx)$/u.test(entry.name) && /\bctx\.root\b/u.test(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')))
        offenders.push(path.relative(PACKAGE_ROOT, file))
    }
  }
  visit(path.join(PACKAGE_ROOT, 'src'))
  assert.deepEqual(offenders, [])
})

report('context-root')
