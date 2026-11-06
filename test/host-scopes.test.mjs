import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, test, report, PACKAGE_ROOT } from './lib/harness.mjs'
import { chooseScopeSource } from '../lib/adapter/dsh/host.js'

// `@deepseek-ai/dsh-scope` tags a context with `Symbol('dsh.scope')` and keeps
// ancestry in a module-private WeakMap, so two loaded copies cannot read each
// other. A `link:`ed checkout resolves the copy installed inside this package
// while the host runs its own, which is the case this choice has to avoid.
const asUrl = file => pathToFileURL(file).href
const ownCopy = asUrl(path.join(PACKAGE_ROOT, 'node_modules', '@deepseek-ai', 'dsh-scope', 'lib', 'index.js'))
const hostCopy = asUrl('/opt/dsh/profiles/node_modules/@deepseek-ai/dsh-scope/lib/index.js')

await test('a copy installed inside this package is never taken for the host instance', () => {
  assert.equal(chooseScopeSource(ownCopy, hostCopy), hostCopy)
  assert.equal(chooseScopeSource(ownCopy), ownCopy, 'without a host copy the plugin keeps what it can resolve')
})

await test('an already host-owned resolution is kept, never redirected', () => {
  assert.equal(chooseScopeSource(hostCopy, hostCopy), hostCopy)
  assert.equal(chooseScopeSource(hostCopy, undefined), hostCopy)
  assert.equal(chooseScopeSource(hostCopy, ownCopy), hostCopy, 'a packaged install already resolves the host tree')
})

report('host-scopes')
