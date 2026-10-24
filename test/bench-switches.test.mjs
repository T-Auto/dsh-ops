import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { renderConfigDump } from '@deepseek-ai/dsh-app-boot'
import { JSDOM } from 'jsdom'
import { assert, report, test, withTempDir, waitFor } from './lib/harness.mjs'
import { extractSwitches, planSwitchPatch, configureSwitches } from '../bench/setup/switches.mjs'
import { main as setup } from '../bench/setup.mjs'
import { compareSummaries } from '../bench/lib/compare-core.mjs'
import { main as compareMain, renderReport } from '../bench/compare.mjs'
import { renderPanel } from '../bench/report/panel.mjs'
import { switchesFromDump } from '../bench/lib/switches.mjs'

await test('switch parser validates repeatable names and replacement vocabulary', () => {
  assert.deepEqual(extractSwitches(['--dry-run', '--switch', 'ptc=false', '--switch=hide-official=all']).switches,
    { ptc: { enabled: false }, 'hide-official': { enabled: true, replaceTools: ['glob', 'grep', 'read'] } })
  for (const argv of [['--switch', 'oops'], ['--switch', 'ptc=maybe'], ['--switch', 'hide-official=write'], ['--switch', 'ptc', '--switch', 'ptc=false']]) assert.throws(() => extractSwitches(argv))
})

await test('planning is idempotent and preserves foreign rows plus inherited component settings', () => {
  const before = '# preserve me\n- id: unrelated\n  config:\n    value: 9\n'
  const switches = extractSwitches(['--switch', 'discovery', '--switch', 'hide-official=all']).switches
  const composed = [{ id: 'dsh-ops-discovery', config: { maxResults: 7, required: true, enabled: false } }]
  const plan = planSwitchPatch(before, switches, { composed })
  assert.ok(plan.text.startsWith(before))
  assert.deepEqual(parse(plan.text).find(row => row.id === 'dsh-ops-discovery').config, { maxResults: 7, required: true, enabled: true })
  assert.equal(planSwitchPatch(plan.text, switches, { composed }).changed, false)
  assert.throws(() => planSwitchPatch('- id: dsh-ops-ptc\n  disabled: true\n', { ptc: { enabled: true } }), /force/)
  assert.equal(parse(planSwitchPatch('- id: dsh-ops-ptc\n  disabled: true\n', { ptc: { enabled: true } }, { force: true }).text)[0].disabled, false)
  assert.throws(() => planSwitchPatch('- id: dsh-ops-ptc\n- id: dsh-ops-ptc\n', { ptc: { enabled: true } }), /Duplicate/)
})

await test('setup accepts switches in dry-run without launching a host or editing either profile', async () => {
  await withTempDir('switch-dry-', async dir => {
    const lines = [], example = path.join(dir, 'example.yml')
    fs.writeFileSync(example, '[]\n')
    const code = await setup(['--dsh-home', dir, '--plugin', 'none', '--no-pin', '--no-permission-mode', '--dry-run', '--switch', 'hide-official=all'], {
      entry: { file: 'fixture-dsh', kind: 'exe' }, overlay: path.join(dir, 'llm.yml'), overlayExample: example,
      invoke: () => { throw new Error('dry-run invoked host') }, out: line => lines.push(line), err: line => lines.push(line),
    })
    assert.equal(code, 0, lines.join('\n'))
    assert.match(lines.join('\n'), /candidate switches.*hide-official/)
    assert.equal(fs.existsSync(path.join(dir, 'profiles')), false)
  })
})

await test('candidate preparation preserves baseline and refuses blocked or unproven readiness', async () => {
  await withTempDir('switch-ready-', async dir => {
    for (const profile of ['base', 'cand']) fs.mkdirSync(path.join(dir, 'profiles', profile), { recursive: true })
    const base = path.join(dir, 'profiles/base/cordis.patch.yml'), cand = path.join(dir, 'profiles/cand/cordis.patch.yml')
    fs.writeFileSync(base, '# baseline sentinel\n[]\n'); fs.writeFileSync(cand, '[]\n')
    const calls = [], options = { candProfile: 'cand', force: false, dryRun: false }
    const context = { home: dir, prefix: [], overlay: path.join(dir, 'missing'), log: () => {}, invoke: args => {
      calls.push(args)
      assert.equal(args[args.indexOf('--profile') + 1], 'cand')
      return args.includes('--dump-config') ? { status: 0, stdout: fs.readFileSync(cand, 'utf8') }
        : { status: 0, stdout: '{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n' }
    } }
    configureSwitches(options, context, { ptc: { enabled: true } })
    assert.equal(fs.readFileSync(base, 'utf8'), '# baseline sentinel\n[]\n')
    assert.equal(calls.filter(args => args.includes('--json')).length, 1)
    const good = context.invoke
    for (const output of ['READINESS_BLOCKED', 'READY', '{"type":"turn_end","reason":"completed"}', '{"type":"status","phase":"turn_end","reason":{"kind":"failed"}}']) {
      context.invoke = args => args.includes('--dump-config') ? good(args) : { status: 0, stdout: output }
      assert.throws(() => configureSwitches(options, context, { ptc: { enabled: true } }), /issues\/207/)
    }
  })
})

await test('candidate switch conditions differ across sweeps, never across the two arms of one sweep', () => {
  const switches = { ptc: { enabled: true } }
  const base = { results: [], switches: {}, candidateSwitches: switches }
  const cand = { results: [], switches, candidateSwitches: switches }
  assert.doesNotThrow(() => compareSummaries(base, cand))
  assert.throws(() => compareSummaries(base, { ...cand, candidateSwitches: { ptc: { enabled: false } } }), /Candidate switches differ/)
  assert.match(renderReport(compareSummaries(base, cand)), /Candidate switches/)
})

await test('dynamic and non-mapping configuration is refused before candidate planning', () => {
  for (const config of [{ expression: 'dynamic()' }, [true], 'unknown', 9]) {
    assert.throws(() => planSwitchPatch('[]\n', { panel: { enabled: true } }, {
      force: true, composed: [{ id: 'dsh-ops-panel', config }],
    }), /manual|mapping|dynamic/)
  }
})

await test('panel and shell activation respect legacy switches and explicit overrides', () => {
  for (const [name, key] of [['panel', 'capture'], ['shell', 'publishBashTool']]) {
    const before = `- id: dsh-ops-${name}\n  disabled: false\n  config:\n    ${key}: false\n    custom: 700\n`
    assert.equal(switchesFromDump(before)[name].enabled, false)
    assert.throws(() => planSwitchPatch(before, { [name]: { enabled: true } }), /force/)
    const plan = planSwitchPatch(before, { [name]: { enabled: true } }, { force: true })
    assert.equal(parse(plan.text)[0].config[key], true)
    assert.equal(parse(plan.text)[0].config.custom, 700)
    assert.equal(switchesFromDump(plan.text)[name].enabled, true)
  }
})

await test('unevaluated and malformed activation config remains unknown in archived facts', () => {
  for (const name of ['panel', 'shell', 'discovery']) {
    for (const config of ['!!js dynamic()', '[]', 'false']) {
      assert.equal(switchesFromDump(`- id: dsh-ops-${name}\n  config: ${config}\n`)[name].enabled, null)
    }
    assert.equal(switchesFromDump(`- id: dsh-ops-${name}\n  disabled: true\n  config: !!js dynamic()\n`)[name].enabled, false)
  }
})

await test('official host composition retains inherited settings and applies only candidate switches', async () => {
  await withTempDir('switch-compose-', async dir => {
    const baseConfig = path.join(dir, 'base.yml'), candidatePatch = path.join(dir, 'candidate.yml')
    fs.writeFileSync(baseConfig, JSON.stringify([
      { id: 'dsh-ops-panel', name: 'panel-fixture', disabled: true, config: { capture: false, maxFrames: 17 } },
      { id: 'dsh-ops-hide-official', name: 'hide-fixture', disabled: true, config: { replaceTools: [] } },
    ]))
    const render = patches => renderConfigDump('dsh', baseConfig, patches, line => { throw new Error(line) })
    const baseline = render([]), wanted = extractSwitches(['--switch', 'panel', '--switch', 'hide-official=all']).switches
    const plan = planSwitchPatch('[]\n', wanted, { composed: parse(baseline) })
    fs.writeFileSync(candidatePatch, plan.text)
    const candidate = render([{ label: 'candidate', patches: parse(fs.readFileSync(candidatePatch, 'utf8')) }])
    assert.deepEqual(switchesFromDump(candidate), wanted)
    assert.equal(parse(candidate).find(row => row.id === 'dsh-ops-panel').config.maxFrames, 17)
    assert.equal(render([]), baseline)
  })
})

await test('CLI refuses differing candidate switches and the panel renders the archived set', async () => {
  await withTempDir('switch-report-', async dir => {
    const files = ['base', 'cand'].map(side => path.join(dir, `${side}.json`))
    const switches = { ptc: { enabled: true } }, lines = []
    for (const [index, file] of files.entries()) fs.writeFileSync(file, JSON.stringify({ format: 'dsh-ops-bench-summary-v1', results: [], candidateSwitches: { ptc: { enabled: index === 0 } } }))
    assert.equal(await compareMain([...files, '--out', '-'], { out: line => lines.push(line), err: line => lines.push(line) }), 2)
    assert.match(lines.join('\n'), /Candidate switches differ/)
    assert.match(lines.join('\n'), /"enabled":true/)
    assert.match(lines.join('\n'), /"enabled":false/)
    const arms = { base: { label: 'base', profile: 'base', profileHash: 'a', switches: {} }, cand: { label: 'cand', profile: 'cand', profileHash: 'b', switches } }
    const run = { schemaVersion: 1, meta: { arms }, arms, results: [] }
    const file = path.join(dir, 'run.json'); fs.writeFileSync(file, JSON.stringify(run))
    const panel = renderPanel({ runJsonPath: file, outDir: dir })
    const dom = new JSDOM(fs.readFileSync(panel.htmlPath, 'utf8'), { runScripts: 'dangerously', beforeParse(window) {
      window.fetch = async () => ({ ok: true, json: async () => run })
    } })
    try { await waitFor(() => {
      const failure = dom.window.document.getElementById('fallback-error').textContent
      assert.equal(failure, '')
      return dom.window.document.body.textContent.includes('Candidate switches: {"ptc":{"enabled":true}}')
    }) }
    finally { dom.window.close() }
  })
})

report('bench-switches')
