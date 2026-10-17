/** #180/#113: a tool call's directory belongs to its session, not the host process. */
import path from 'node:path'
import { assert, report, test } from './lib/harness.mjs'
import { sessionWorkdir } from '../lib/session-shells.js'

const cwd = path.resolve('session workspace')
const session = { header: { cwd } }

await test('relative workdirs resolve against the session workspace', () => {
  for (const workdir of ['.', 'retest-dir', './retest-dir', 'nested/../retest-dir', ' child ']) {
    assert.equal(sessionWorkdir({ workdir }, session), path.resolve(cwd, workdir), workdir)
  }
})

await test('omitted and blank workdirs retain the session default', () => {
  for (const workdir of [undefined, null, '', '   ']) {
    assert.equal(sessionWorkdir({ workdir }, session), cwd)
  }
})

await test('absolute paths and invalid argument types retain their existing handling', () => {
  const absolute = path.resolve('chosen directory')
  assert.equal(sessionWorkdir({ workdir: absolute }, session), absolute)
  assert.equal(sessionWorkdir({ workdir: 5 }, session), 5)
})

await test('rooted paths use the session root without an ambient Windows drive cwd', () => {
  const rooted = `${path.sep}child`
  assert.equal(sessionWorkdir({ workdir: rooted }, session), path.join(path.parse(cwd).root, 'child'))
  if (process.platform === 'win32') {
    const session = { header: { cwd: 'D:\\session\\workspace' } }
    assert.equal(sessionWorkdir({ workdir: '\\child' }, session), 'D:\\child')
    assert.equal(sessionWorkdir({ workdir: 'D:child' }, session), 'D:\\session\\workspace\\child')
    assert.throws(() => sessionWorkdir({ workdir: 'C:child' }, session), /invalid workdir:.*absolute path/)
    assert.throws(() => sessionWorkdir({ workdir: 'child' }, { header: { cwd: '\\workspace' } }), /absolute session/)
  }
})

await test('a relative workdir cannot fall back to the process cwd without a valid session root', () => {
  for (const cwd of [undefined, '', 'relative-session-root']) {
    assert.throws(() => sessionWorkdir({ workdir: 'child' }, { header: { cwd } }), /invalid workdir:.*absolute session/)
  }
})

report('bash-workdir')
