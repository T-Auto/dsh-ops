/**
 * The shipped PTC engine must start and answer with nothing installed beyond the package itself.
 *
 * `engine/ptc` reaches Everything through `es.exe` and the strict cross-check through the `ast-grep`
 * CLI. Both are optional: neither is committed (the repository ships no binaries), so a clean clone
 * has neither. What must not happen is a throw on import or a crash on the degraded path — an
 * optional dependency that turns into an exception is worse than one that reports absence, because
 * the caller cannot tell "not installed" from "broken".
 *
 * @module dsh-ops/test/ptc-engine
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, TEST_HOME, test } from './lib/harness.mjs'
import { inprocLocate, esCandidates, sgCrossCheck } from '../lib/ptc/engine.js'

const FIXTURE = [
  'export function alpha(value: string) {',
  '  return value.length',
  '}',
  '',
  'export class Beta {',
  '  gamma() { return 1 }',
  '}',
].join('\n')

await test('the engine imports without a worker, a grammar bundle or a CLI', () => {
  assert.equal(typeof inprocLocate, 'function')
  assert.equal(typeof esCandidates, 'function')
  assert.equal(typeof sgCrossCheck, 'function')
})

await test('locate answers in-process against a real file', () => {
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'ptc-engine-'))
  try {
    fs.writeFileSync(path.join(dir, 'fixture.ts'), FIXTURE)
    const located = inprocLocate({ symbol: 'alpha', file: 'fixture.ts' }, dir)
    assert.equal(located.status, 'ok')
    assert.ok(Array.isArray(located.hits) && located.hits.length >= 1, JSON.stringify(located))
    assert.ok(located.hits[0].lines[0] >= 1, 'a hit carries a 1-based line range')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await test('a missing Everything path is a value, not a throw', () => {
  const previous = process.env.PTC_ES
  process.env.PTC_ES = path.join(TEST_HOME, 'definitely-not-installed', 'es.exe')
  try {
    const listed = esCandidates(process.cwd())
    assert.ok(Array.isArray(listed), 'esCandidates must always answer with a list')
  } finally {
    if (previous === undefined) delete process.env.PTC_ES
    else process.env.PTC_ES = previous
  }
})

await test('a missing ast-grep CLI degrades the cross-check instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'ptc-sg-'))
  try {
    const file = path.join(dir, 'fixture.ts')
    fs.writeFileSync(file, FIXTURE)
    const checked = sgCrossCheck(file, 'return $A', 'ts', 1, path.join(dir, 'no-such-ast-grep'), 2_000)
    assert.equal(checked.agree, false, 'without the CLI the cross-check cannot agree')
    assert.equal(checked.status === 'ok', false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

report('ptc-engine')
