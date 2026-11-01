/** Publication and result projections must not depend on built-in preset policy. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'

await test('generic publication and file/PTC projections do not import modes', () => {
  const visit = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? visit(file) : [file]
  })
  for (const area of ['publication', 'file', 'ptc', 'consumer', 'projections', 'execution']) {
    for (const file of visit(path.join(PACKAGE_ROOT, 'src', area)).filter(file => file.endsWith('.ts'))) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /from\s+['"][^'"]*\/(?:modes|presets)\//u, path.relative(PACKAGE_ROOT, file))
    }
  }
})
await test('discovery controller does not reach back into consumers or preset products', () => {
  const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'src/discovery/controller.ts'), 'utf8')
  assert.doesNotMatch(source, /from\s+['"][^'"]*\/(?:modes|presets|integration|consumer)\//u)
})
report('publication-boundary')
