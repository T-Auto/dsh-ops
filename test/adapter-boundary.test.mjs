import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

const source = path.join(PACKAGE_ROOT, 'src')
const adapter = path.join(source, 'adapter', 'dsh')
// The adapter's three facets: host types, the lazy host loader, and the browser
// value seam. Nothing else may name a DSH module.
const EXEMPT = new Set(['types.ts', 'host.ts', 'browser.ts'].map(name => path.resolve(path.join(adapter, name))))

await test('all host-facing DSH imports converge through the project adapter', () => {
  const offenders = []
  const upstream = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?(['"])(@deepseek-ai\/[^'"]+)\1|^\s*import\s*\(\s*(['"])(@deepseek-ai\/[^'"]+)\3\s*\)/gmu
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (/\.(?:ts|tsx)$/u.test(entry.name) && !EXEMPT.has(path.resolve(file))) {
        const text = fs.readFileSync(file, 'utf8')
        for (const match of text.matchAll(upstream)) offenders.push(`${path.relative(PACKAGE_ROOT, file)} -> ${match[2]}`)
      }
    }
  }
  visit(source)
  assert.deepEqual(offenders, [], `upstream imports escaped the adapter:\n${offenders.join('\n')}`)
})

await test('the browser seam exports the native controls and nothing else', () => {
  const text = fs.readFileSync(path.join(adapter, 'browser.ts'), 'utf8')
  const names = [...text.matchAll(/^export .* from '([^']+)'/gmu)].map(match => match[1])
  assert.deepEqual(names, ['@deepseek-ai/dsh-client-ui-primitives'])
})

await test('the adapter keeps scope discovery lazy', () => {
  const text = fs.readFileSync(path.join(adapter, 'host.ts'), 'utf8')
  assert.match(text, /async function loadScopes/u)
  assert.match(text, /return import\('@deepseek-ai\/dsh-scope'\)/u)
  assert.doesNotMatch(text, /^import .*dsh-scope/m)
})

report('adapter-boundary')
