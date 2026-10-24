/** Conditions govern actual routing, archives and pairing; no model request is made. */
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { parse } from 'yaml'
import { JSDOM } from 'jsdom'
import { renderConfigDump } from '@deepseek-ai/dsh-app-boot'
import { assert, test, report, withTempDir, waitFor } from './lib/harness.mjs'
import { main as runMain, parseRunArgs, dumpProfileConfig } from '../bench/run.mjs'
import { main as compareMain, renderReport } from '../bench/compare.mjs'
import { compareSummaries } from '../bench/lib/compare-core.mjs'
import { planConditions, conditionOf, writeConditionPatch, assertEffectiveCondition } from '../bench/lib/condition.mjs'
import { runSession } from '../bench/run/session.mjs'
import { validateRun } from '../bench/run/seal.mjs'
import { renderPanel } from '../bench/report/panel.mjs'

const route = { provider: 'bench-server', model: 'old-model', reasoningEffort: 'off' }
const overlayText = JSON.stringify([{ id: 'agent-default-model', config: route }])
const entry = { kind: 'js', file: path.join(path.sep, 'fake', 'dsh.js') }
const task = { id: 'condition-fixture', title: 'condition fixture', prompt: 'Write answer.txt', repeat: 1, timeoutMs: 1000,
  fixture: { generator: 'grepTree', params: { dirs: 1, filesPerDir: 1, linesPerFile: 1, needleFiles: 1 } },
  verify: [{ type: 'fileExists', path: 'answer.txt' }] }
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const sink = () => { const lines = []; return { lines, out: line => lines.push(line), err: line => lines.push(line) } }

await test('repeatable CLI flags form a Cartesian matrix and malformed efforts fail before work', () => {
  const options = parseRunArgs(['--model', 'a', '--model', 'b', '--reasoning-effort', 'low', '--reasoning-effort', 'high'])
  const values = planConditions(options, 'overlay', () => overlayText)
  assert.deepEqual(values.map(value => [value.model, value.reasoningEffort]), [['a', 'low'], ['a', 'high'], ['b', 'low'], ['b', 'high']])
  assert.ok(values.every(value => value.provider === route.provider))
  assert.throws(() => parseRunArgs(['--reasoning-effort', 'medium']), /off, low, high, max/)
  assert.throws(() => parseRunArgs(['--model', '--reasoning-effort', 'high']), /needs a value/)
  assert.deepEqual(planConditions(parseRunArgs([]), null, () => { throw new Error('must not read'); }), [null])
  assert.equal(conditionOf({ meta: { model: 'legacy-label' } }), null)
  const expected = { ...route, reasoningEffort: 'high' }
  assert.throws(() => assertEffectiveCondition(overlayText, expected), /does not match requested/)
  assert.throws(() => assertEffectiveCondition(JSON.stringify([{ id: 'agent-default-model', disabled: true, config: expected }]), expected), /does not match requested/)
  assert.doesNotThrow(() => assertEffectiveCondition(JSON.stringify([{ id: 'agent-default-model', config: expected }]), expected))
})

await test('the final patch replaces the complete route while preserving the input overlay', () => withTempDir('conditions-patch', root => {
  const overlay = path.join(root, 'llm.patch.yml')
  fs.writeFileSync(overlay, overlayText)
  const condition = planConditions(parseRunArgs(['--model', 'DeepSeek-V4.1-Flash', '--reasoning-effort', 'high']), overlay)[0]
  const file = writeConditionPatch(path.join(root, 'run'), condition)
  assert.deepEqual(parse(fs.readFileSync(file, 'utf8')), [{ id: 'agent-default-model', config: condition }])
  assert.equal(fs.readFileSync(overlay, 'utf8'), overlayText)
  assert.throws(() => writeConditionPatch(path.join(root, 'run'), condition), /EEXIST/)
  assert.throws(() => planConditions(parseRunArgs(['--model', 'x']), null), /provider/)
}))

await test('an unapplied condition is refused before a measured session starts', () => withTempDir('conditions-refuse', async root => {
  const tasksDir = path.join(root, 'tasks'), overlay = path.join(root, 'llm.yml'), output = sink()
  fs.mkdirSync(tasksDir); fs.writeFileSync(path.join(tasksDir, 'condition.task.json'), JSON.stringify(task)); fs.writeFileSync(overlay, overlayText)
  let sessions = 0
  const code = await runMain(['--out', path.join(root, 'run'), '--llm-patch', overlay, '--model', 'new-model', '--reasoning-effort', 'high'], {
    ...output, tasksDir, installSignals: false, resolveEntry: () => entry,
    dumpProfileConfig: () => overlayText,
    runSession: () => { sessions++; throw new Error('must not run') },
  })
  assert.equal(code, 1)
  assert.equal(sessions, 0)
  assert.match(output.lines.join('\n'), /Composed agent-default-model route does not match requested condition/)
}))

await test('matrix show prints every condition without allocating output or invoking a host', () => withTempDir('conditions-show', async root => {
  const tasksDir = path.join(root, 'tasks'), out = path.join(root, 'matrix'), output = sink()
  fs.mkdirSync(tasksDir); fs.writeFileSync(path.join(tasksDir, 'condition.task.json'), JSON.stringify(task))
  assert.equal(await runMain(['--show', '--out', out, '--no-llm-patch', '--provider', 'p', '--model', 'a', '--model', 'b', '--reasoning-effort', 'high'], {
    ...output, tasksDir, resolveEntry: () => { throw new Error('must not invoke host') },
  }), 0)
  assert.equal(fs.existsSync(out), false)
  assert.equal(output.lines.filter(line => line.startsWith('[matrix] ') && /\/2:/.test(line)).length, 2)
}))

await test('interrupting one sweep stops the remaining matrix conditions', () => withTempDir('conditions-interrupt', async root => {
  const tasksDir = path.join(root, 'tasks'), out = path.join(root, 'matrix'), output = sink()
  fs.mkdirSync(tasksDir); fs.writeFileSync(path.join(tasksDir, 'condition.task.json'), JSON.stringify(task))
  let sweeps = 0
  const code = await runMain(['--out', out, '--no-llm-patch', '--provider', 'p', '--model', 'a', '--model', 'b', '--no-report'], {
    ...output, tasksDir, installSignals: false, resolveEntry: () => entry,
    dumpProfileConfig: (_entry, _profile, context) => fs.readFileSync(context.conditionPatch, 'utf8'),
    sweep: (_spec, options) => {
      sweeps++; options.interrupt.stopped = true
      return { interrupted: true, failures: [], completedSessions: 0, plannedSessions: 2, pairs: 1, noise: null }
    },
  })
  assert.equal(code, 1)
  assert.equal(sweeps, 1, 'an interrupt applies to the whole matrix, including conditions not yet started')
  assert.equal(json(path.join(out, 'matrix.json')).groups.length, 1)
}))

await test('a complete matrix uses identical routing patches in both arms and archives each condition', () => withTempDir('conditions-matrix', async root => {
  const tasksDir = path.join(root, 'tasks'), out = path.join(root, 'matrix'), overlay = path.join(root, 'llm.yml')
  fs.mkdirSync(tasksDir); fs.writeFileSync(path.join(tasksDir, 'condition.task.json'), JSON.stringify(task)); fs.writeFileSync(overlay, overlayText)
  const baseConfig = path.join(root, 'base.yml')
  fs.writeFileSync(baseConfig, JSON.stringify([{ id: 'agent-default-model', name: 'fixture-router', config: route }]))
  const calls = [], dumps = [], output = sink()
  const patches = args => args.flatMap((arg, index) => arg === '--patch' ? [args[index + 1]] : [])
  const run = await runMain(['--out', out, '--llm-patch', overlay, '--model', 'a', '--model', 'b', '--reasoning-effort', 'low', '--reasoning-effort', 'high', '--seal'], {
    ...output, tasksDir, installSignals: false, resolveEntry: () => entry, now: () => Date.UTC(2026, 9, 25),
    dumpProfileConfig: (entry, profile, context) => dumpProfileConfig(entry, profile, { ...context, run(_command, args) {
      const files = patches(args)
      assert.equal(files.length, 2)
      assert.equal(files[0], overlay)
      const stdout = renderConfigDump('dsh', baseConfig, files.map(file => ({ label: path.basename(file), patches: parse(fs.readFileSync(file, 'utf8')) })), line => { throw new Error(line) })
      const config = parse(stdout)[0].config
      dumps.push({ profile, files, config })
      return { status: 0, stdout, stderr: 'diagnostic is not configuration' }
    } }),
    runSession: (spec, options) => runSession(spec, { ...options, workspaceRoot: root, spawn(_command, args, processOptions) {
      const files = patches(args), config = parse(fs.readFileSync(files[1], 'utf8'))[0].config
      calls.push({ arm: spec.arm, files, config })
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123
      setImmediate(() => {
        fs.writeFileSync(path.join(processOptions.cwd, 'answer.txt'), 'done')
        child.stdout.end(JSON.stringify({ type: 'status', phase: 'step_end', step: 1, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }) + '\n')
        child.stderr.end(); setImmediate(() => child.emit('close', 0))
      })
      return child
    } }),
  })
  assert.equal(run, 0, output.lines.join('\n'))
  assert.equal(calls.length, 8); assert.equal(dumps.length, 8)
  const manifest = json(path.join(out, 'matrix.json'))
  assert.equal(manifest.groups.length, 4)
  for (const [index, group] of manifest.groups.entries()) {
    const left = calls[index * 2], right = calls[index * 2 + 1]
    assert.deepEqual(left.files, right.files)
    assert.deepEqual(left.config, group.condition)
    assert.deepEqual(left.files, dumps[index * 2].files)
    const sealed = json(path.join(out, group.directory, 'run.json'))
    assert.deepEqual(sealed.meta.condition, group.condition)
    assert.equal(sealed.meta.model, group.condition.model)
    assert.equal(validateRun(sealed).ok, true)
    for (const side of ['base', 'cand']) {
      assert.deepEqual(json(path.join(out, group[side])).condition, group.condition)
      const dump = fs.readFileSync(path.join(path.dirname(path.join(out, group[side])), 'dump-config.txt'), 'utf8')
      assert.deepEqual(parse(dump)[0].config, group.condition)
    }
    const paths = ['base', 'cand'].map(side => path.join(path.dirname(path.join(out, group[side])), 'dump-config.txt'))
    assert.deepEqual(fs.readFileSync(paths[0]), fs.readFileSync(paths[1]))
  }
  const reportOut = sink()
  assert.equal(await compareMain(['--matrix', out, '--json'], reportOut), 0)
  const combined = JSON.parse(reportOut.lines[0])
  assert.equal(combined.comparableAcrossConditions, false)
  assert.equal(combined.comparisons.length, 4)
  assert.equal(combined.totals, undefined)
  const markdown = sink()
  assert.equal(await compareMain(['--matrix', out], markdown), 0)
  assert.match(markdown.lines[0], /Cross-condition results are not comparable/)
  assert.equal(markdown.lines[0].match(/^## Condition /gm).length, 4)
  assert.equal(markdown.lines[0].match(/^# /gm).length, 1)
  const mismatch = sink()
  assert.equal(await compareMain([path.join(out, manifest.groups[0].base), path.join(out, manifest.groups[1].cand)], mismatch), 2)
  assert.match(mismatch.lines.join('\n'), /"reasoningEffort":"low"/)
  assert.match(mismatch.lines.join('\n'), /"reasoningEffort":"high"/)
  const left = json(path.join(out, manifest.groups[0].base)), right = json(path.join(out, manifest.groups[0].cand))
  delete left.condition; delete right.condition
  assert.equal(compareSummaries(left, right).condition, null)
  assert.match(renderReport(compareSummaries(left, right)), /Condition: unknown/)
  assert.throws(() => compareSummaries(left, { ...right, condition: manifest.groups[0].condition }), /Conditions differ.*unknown/)
  const docPath = path.join(out, manifest.groups[0].directory, 'run.json')
  const panel = renderPanel({ runJsonPath: docPath, outDir: path.dirname(docPath) })
  const dom = new JSDOM(fs.readFileSync(panel.htmlPath, 'utf8'), { runScripts: 'dangerously', beforeParse(window) {
    window.fetch = async () => ({ ok: true, json: async () => json(docPath) })
  } })
  try { await waitFor(() => dom.window.document.body.textContent.includes('"reasoningEffort":"low"')); }
  finally { dom.window.close() }
}))

report('bench-conditions')
