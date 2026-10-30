import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import { ConfigError, resolveHidingConfig } from '../lib/config.js'
import { OFFICIAL_REPLACEMENTS, platformSurface } from '../lib/official-tool-catalog.js'
import { Config } from '../lib/components/hide-official/index.js'
import { assert, PACKAGE_ROOT, report, test } from './lib/harness.mjs'
import { officialToolHidingMountChecks } from './lib/official-tool-hiding.mjs'

await test('replacement config defaults empty, copies and deduplicates explicit selections', () => {
  assert.deepEqual(resolveHidingConfig(), { replaceTools: [] })
  const raw = { replaceTools: ['read', 'grep', 'read'] }
  const result = resolveHidingConfig(raw)
  raw.replaceTools.push('glob')
  assert.deepEqual(result, { replaceTools: ['read', 'grep'] })
})
await test('invalid configuration names its key or unsupported selection', () => {
  for (const config of [null, [], false]) assert.throws(() => resolveHidingConfig(config), /hiding config/)
  for (const replaceTools of [null, true, 'read', {}, 1]) {
    assert.throws(() => resolveHidingConfig({ replaceTools }), /replaceTools must be an array/)
  }
  for (const tool of ['write', 'edit', 'str_replace_editor', 'bash', 'ops_read', 'run_code', 'toString', '', null, {}]) {
    assert.throws(() => resolveHidingConfig({ replaceTools: [tool] }), /replaceTools contains unsupported tool/)
  }
  assert.throws(() => resolveHidingConfig({ replacementTools: ['read'] }), error => error instanceof ConfigError && /unknown hiding key: replacementTools/.test(error.message))
})
await test('legacy blanket settings are validated but never authorize replacements', () => {
  for (const scope of ['takeover', 'extended', 'off', undefined, null]) {
    assert.deepEqual(resolveHidingConfig({ strict: true, scope, additionalOfficialTools: ['read', 'write', 'subagent'] }), { replaceTools: [] })
    assert.deepEqual(resolveHidingConfig({ scope, replaceTools: ['grep'] }), { replaceTools: ['grep'] })
  }
  assert.throws(() => resolveHidingConfig({ strict: false }), /strict/)
  assert.throws(() => resolveHidingConfig({ scope: 'all' }), /scope/)
  for (const value of ['read', [''], ['ops_read']]) {
    assert.throws(() => resolveHidingConfig({ additionalOfficialTools: value }), /additionalOfficialTools/)
  }
})
await test('the real Cordis loader consumes the component Standard Schema validator', async () => {
  const ctx = new Context()
  ctx.logger.level = 0
  let received
  try {
    await ctx.plugin({ Config, apply(_ctx, value) { received = value } }, { strict: true, replaceTools: ['read', 'read'] })
    assert.deepEqual(received, { replaceTools: ['read'] })
    let invalidMounted = false
    await assert.rejects(async () => await ctx.plugin({ Config, apply() { invalidMounted = true } }, { unknownSelection: true }), /unknown hiding key: unknownSelection/)
    assert.equal(invalidMounted, false)
    const error = Config['~standard'].validate({ replaceTools: ['write'] })
    assert.match(error.issues[0].message, /unsupported tool: "write"/)
  } finally { await ctx.fiber.dispose() }
})
await test('the merged row declares per-preset replacement preferences without a Compatibility row', () => {
  const document = parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  const rows = document.flatMap(item => item.insert)
  // The legacy hide-official row is no longer inserted; Compatibility is one
  // switch, so the bundle must not carry a per-tool replacement selection.
  assert.equal(rows.some(row => row.name === 'dsh-ops/hide-official'), false)
  assert.equal(rows.some(row => row.id === 'dsh-ops-compat'), false)
  const merged = rows.find(row => row.id === 'dsh-ops')
  assert.ok(merged)
  assert.equal(merged.config.global.hideOfficialTools, true)
  assert.equal(Object.hasOwn(merged.config, 'replaceTools'), false, 'the bundle selects no blanket per-tool replacements')
  assert.deepEqual(resolveHidingConfig({ replaceTools: [] }), { replaceTools: [] }, 'the retained legacy validator still resolves an empty selection')
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.deepEqual(platformSurface(platform), { retainedCommand: platform === 'win32' ? 'pwsh' : 'bash', shellDefaultEnabled: true })
  }
})
await test('only reviewed read workflows have mappings; mutation and transport tools do not', () => {
  assert.deepEqual(OFFICIAL_REPLACEMENTS, { read: 'ops_inspect_local_file', glob: 'ops_glob', grep: 'ops_grep' })
  assert.ok(Object.isFrozen(OFFICIAL_REPLACEMENTS))
})
await test('both component references list the reviewed mappings and explain deliberate workflow differences', () => {
  for (const file of ['docs/component-reference.md', 'docs/组件参考.md']) {
    const text = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8')
    const block = /<!-- hide-official-scope:start -->([\s\S]*?)<!-- hide-official-scope:end -->/u.exec(text)
    assert.ok(block, file)
    const rows = block[1].split('\n').filter(line => /^\| \x60/.test(line)).map(line => line.split('|').slice(1, 3).map(cell => cell.trim().replaceAll('\x60', '')))
    assert.deepEqual(rows, Object.entries(OFFICIAL_REPLACEMENTS), file)
    for (const term of ['replaceTools', 'expectedRevision', 'CAS', 'Rust', 'ripgrep', 'StandardSchemaV1']) assert.ok(text.includes(term), file + ': ' + term)
  }
})
await officialToolHidingMountChecks()
report('official-tool-hiding')
