import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { parse, main } from '../bench/gates/index.mjs'
import { verdict, fullAcceptance, verifyReads, verifyEmittedReads, lowerBound, schemaMeasurement } from '../bench/gates/metrics.mjs'
import { READ_CASES, readFixture } from '../bench/gates/fixtures.mjs'
import { prepareBaseline } from '../bench/gates/prepare-baseline.mjs'
import { formatReport } from '../bench/gates/report.mjs'
import { baselineProvenance } from '../bench/gates/provenance.mjs'

await test('benchmark evidence requires an explicit destination and named supported tasks', () => {
  assert.throws(() => parse([]), /--output is required/)
  assert.throws(() => parse(['--output']), /incomplete/)
  assert.throws(() => parse(['--output', 'evidence.json', '--task', 'BM-06']), /Unknown benchmark/)
  assert.throws(() => parse(['--output', 'evidence.json', '--paid-model', 'yes']), /Unknown/)
  assert.equal(parse(['--help']).help, true)
  assert.deepEqual(parse(['--output', 'evidence.json', '--task', 'BM-01', '--task', 'BM-01']).tasks, ['BM-01'])
  assert.throws(() => baselineProvenance(), /missing baseline is not a pass/)
})
await test('partial, blocked, failed and duplicate gate sets never claim full acceptance', () => {
  const complete = ['BM-01', 'BM-02', 'BM-03', 'BM-04', 'BM-05'].map(id => ({ id, status: 'passed' }))
  assert.equal(fullAcceptance(complete), true)
  assert.equal(verdict([]), false)
  assert.equal(fullAcceptance(complete.slice(0, 4)), false)
  assert.equal(fullAcceptance(Array(5).fill(complete[0])), false)
  assert.equal(fullAcceptance([...complete, complete[0]]), false)
  assert.equal(fullAcceptance([...complete, { id: 'BM-06', status: 'passed' }]), false)
  for (const status of ['blocked', 'failed', 'skipped', undefined]) assert.equal(fullAcceptance([...complete.slice(0, 4), { id: 'BM-05', status }]), false)
})
await test('a rerun cannot overwrite existing evidence, and a missing worker fails before creating it', async () => {
  await withTempDir('bench-gates', async root => {
    const output = path.join(root, 'report.json'), lines = [], io = { out: line => lines.push(line), err: line => lines.push(line) }
    fs.writeFileSync(output, 'previous evidence')
    assert.equal(await main(['--output', output], io), 2)
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous evidence')
    assert.match(lines.join('\n'), /Refusing to overwrite/)
    const missingOutput = path.join(root, 'not-created.json')
    assert.equal(await main(['--output', missingOutput, '--worker', path.join(root, 'missing-worker')], io), 2)
    assert.equal(fs.existsSync(missingOutput), false)
  })
})
await test('parallel baseline reads compare by requested file, rejecting missing or incorrect logical data', () => {
  const files = ['a', 'b', 'c'].map((path, index) => ({ path, expected: [{ line: index + 1, text: path }] }))
  const records = [...files].reverse().map(file => ({ arguments: { path: file.path }, result: { isError: false, value: { items: file.expected } } }))
  const run = { committed: [1, 2, 3], results: records }
  verifyReads(run, files, 'baseline')
  assert.throws(() => verifyReads({ ...run, results: [records[0], records[0], records[2]] }, files, 'baseline'), /each requested file/)
  const wrong = structuredClone(run); wrong.results[0].result.value.items[0].text = 'truncated'
  assert.throws(() => verifyReads(wrong, files, 'baseline'), /requested logical lines/)
  const official = { ...run, results: records.map(row => ({ arguments: { file_path: row.arguments.path }, result: { isError: false, value: { lines: row.result.value.items.map(item => ({ number: item.line, text: item.text })) } } })) }
  verifyReads(official, files, 'official')
})
await test('schema accounting includes full descriptions and every contract field in provider order', () => {
  const base = { name: 'example', description: 'full description', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } } } }
  const small = schemaMeasurement([base]), large = schemaMeasurement([base, { ...base, name: 'second', description: 'This full description must remain counted.' }])
  assert.equal(small.bytes, Buffer.byteLength(small.json))
  assert.equal(JSON.parse(small.json)[0].parameters.properties.limit.maximum, 100)
  assert.ok(large.tokens > small.tokens)
  assert.deepEqual(JSON.parse(large.json).map(tool => tool.name), ['example', 'second'])
})
await test('the primary workload is declared before measurement and retains short/long-content sensitivities', async () => {
  assert.equal(READ_CASES.filter(item => item.primary).length, 1)
  const primary = READ_CASES.find(item => item.primary)
  assert.equal(primary.limit, 50); assert.equal(primary.first, true)
  assert.ok(READ_CASES.some(item => item.limit === 8 && item.style === 'typescript'))
  await withTempDir('bench-gates', async root => {
    const files = readFixture(root, primary)
    assert.equal(files.length, 3); assert.ok(files.every(file => file.expected.length === 50 && file.offset === 1))
    const long = readFixture(root, READ_CASES.find(item => item.style === 'long-lines'))
    assert.ok(long.every(file => file.expected.every(line => line.text.length > 600)))
  })
})
await test('baseline materialization is immutable and source tampering fails provenance before execution', async () => {
  await withTempDir('baseline-blobs', async root => {
    const directory = path.join(root, 'baseline')
    const prepared = prepareBaseline(directory)
    assert.ok(prepared.files > 10)
    assert.ok(fs.existsSync(path.join(directory, 'native', 'Cargo.lock')))
    assert.throws(() => prepareBaseline(directory), /Refusing to overwrite/)
    const file = path.join(directory, 'lib', 'file', 'contract.js')
    fs.appendFileSync(file, '\n// changed')
    assert.throws(() => baselineProvenance(directory, path.join(root, 'unexecuted-worker')), /Baseline source differs/)
  })
})
await test('emitted-text verification catches loss hidden by unchanged canonical data and computes the lower bound', async () => {
  await withTempDir('visible-lines', async root => {
    const files = readFixture(root, READ_CASES.find(item => item.primary))
    const rendered = files.map(file => '=== FILE: ' + JSON.stringify(file.path) + ' (Lines 1-50 of 70) ===\n' + file.expected.map(row => row.line + '|' + row.text).join('\n')).join('\n')
    const run = { committed: [{ text: rendered }] }
    verifyEmittedReads(run, files, 'candidate')
    assert.throws(() => verifyEmittedReads({ committed: [{text: rendered.replace('1|export const value1 = 1000;', '')}] }, files, 'candidate'), /all emitted/)
    const facts = lowerBound(files, {baseline:{outputBytes:8883},official:{outputBytes:5457}})
    assert.equal(facts.sourceUtf8Bytes, 4320)
    assert.equal(facts.comparisons.official.sourceAloneExceedsTarget, true)
    assert.equal(facts.comparisons.baseline.sourceAloneExceedsTarget, false)
    assert.throws(() => { READ_CASES[0].limit = 1 }, TypeError)
  })
})
await test('human-readable reports retain failed and blocked gates and the limited historical probe', () => {
  const text = formatReport({platform:'win32',arch:'x64',hostVersion:'0.2.0-rc.2',node:'v24',passed:false,fullAcceptance:false,gates:[{id:'BM-03',status:'failed'},{id:'BM-04',status:'blocked',reason:'PDF unavailable'}]})
  assert.match(text, /BM-03 \| failed/); assert.match(text, /BM-04 \| blocked/)
  assert.match(text, /All five gates accepted: false/); assert.match(text, /hostAuthorityExercised=false/)
})
await test('reports distinguish the approved subset score from complete startup cost', () => {
  const text=formatReport({platform:'win32',arch:'x64',hostVersion:'0.2.0-rc.2',node:'v24',passed:true,fullAcceptance:false,gates:[{
    id:'BM-03',status:'passed',names:['bash','discover_tools','read'],measurement:{tokens:660,bytes:3219},
    gatedNames:['discover_tools','read'],gatedMeasurement:{tokens:241,bytes:1094},wholeStartupMessages:{tokens:786,bytes:3293}
  }]})
  assert.ok(text.includes('gated file/discovery schema 241 tokens / 1094 bytes'))
  assert.ok(text.includes('full default schema 660 tokens / 3219 bytes'))
  assert.match(text,/Bash remains resident; full-default readiness is required/)
  assert.match(text,/Whole startup message JSON: 786 tokens/)
})
await test('the timeout arm names its missing devDependency instead of failing opaquely', async () => {
  // The policy is a devDependency only the timeout arm needs, so `boot` loads it there and must
  // report the package by name. Without this the arm dies with a bare ERR_MODULE_NOT_FOUND that
  // says nothing about `npm ci` or about dropping the arm from the run.
  const { mountTimeoutPolicy } = await import('../bench/gates/host.mjs')
  const mounted = []
  const ctx = { async plugin(plugin) { mounted.push(plugin) } }
  await assert.rejects(
    mountTimeoutPolicy(ctx, async () => { const error = new Error('Cannot find package'); error.code = 'ERR_MODULE_NOT_FOUND'; throw error }),
    error => /@deepseek-ai\/dsh-tool-call-timeout-policy/.test(error.message) && /npm ci/.test(error.message) && /ERR_MODULE_NOT_FOUND/.test(error.message))
  assert.deepEqual(mounted, [], 'a missing policy must not leave a half-mounted plugin behind')
  const policy = { inject: ['tools'], apply() {} }
  await mountTimeoutPolicy(ctx, async spec => {
    assert.equal(spec, '@deepseek-ai/dsh-tool-call-timeout-policy', 'the loader is asked for the policy by name')
    return policy
  })
  assert.equal(mounted.length, 1, 'a present policy is mounted once')
  assert.deepEqual(mounted[0], { inject: policy.inject, apply: policy.apply })
})
report('bench-gates')
