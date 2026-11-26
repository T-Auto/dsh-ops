/** Execute the shipped teaching programs against canonical worker returns. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { renderToolsSdk } from '@deepseek-ai/dsh-tool-executor-ptc'
import { definition } from '../lib/projections/ptc/contract.js'
import { loadBatchingGuidance, renderBatchingGuidance } from '../lib/ptc/batching-guidance.js'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
import { assert, test, report, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
requireWorker('batching-examples')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const source = loadBatchingGuidance()
const surface = { loader: true, resident: [], loadable: [] }
const blocks = mode => [...renderBatchingGuidance(source, { ...surface, outputMode: mode })
  .matchAll(/```ts\r?\n([\s\S]*?)```/gu)].map(match => match[1])
  .filter(block => block.startsWith('// plan: ') && !block.startsWith('// plan: <operation>'))
const headings = ['load glob/read_files/stat', 'top-level directory list', 'find the batching sites',
  'read the revision', 'read every page of the event log']
const blockFor = (mode, heading) => blocks(mode).find(block => block.startsWith('// plan: ' + heading))
function sdk(root) {
  const tools = Object.fromEntries(['glob', 'grep', 'read_files', 'stat', 'inspect_local_file', 'edit_file'].map(name => {
    // The host resolves relative paths before the raw worker boundary.
    const tool = definition(name, async args => {
      const resolved = name === 'read_files'
        ? { ...args, files: args.files.map(file => ({ ...file, path: path.resolve(root, file.path) })) }
        : { ...args, path: path.resolve(root, args.path ?? '.') }
      return envelopeOf(await callTool(name, resolved, { root }), assert)
    })
    return [tool.name, async args => {
      const value = await tool.execute(args, {})
      assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], `${name}: ${JSON.stringify(value)}`)
      return value
    }]
  }))
  tools.ops_load_sdk = async ({ tools: names }) => ({ status: 'completed', data: { tools: names } })
  return tools
}
const OUTPUT_MODES = ['inspect', 'return', 'console']
const OUTPUT_MARKERS = { inspect: 'inspect(', return: 'return (', console: 'console.log(' }
async function execute(mode, heading, tools) {
  const code = blockFor(mode, heading)
  assert.ok(code, `missing rendered block for ${mode}: ${heading}`)
  assert.equal(code.includes('show('), false, `unrendered show marker for ${mode}: ${heading}`)
  assert.ok(code.includes(OUTPUT_MARKERS[mode]), `missing ${mode} output marker for ${heading}`)
  const outputs = []
  const capture = (...values) => outputs.push(values.length === 1 ? values[0] : values)
  let returned
  if (mode === 'inspect') {
    returned = await new AsyncFunction('tools', 'inspect', code)(tools, capture)
  } else if (mode === 'console') {
    returned = await new AsyncFunction('tools', 'console', code)(tools, { log: capture })
  } else {
    returned = await new AsyncFunction('tools', code)(tools)
  }
  if (mode === 'return') assert.notEqual(returned, undefined, `return mode produced no value for ${heading}`)
  else assert.equal(outputs.length, 1, `${mode} mode output count for ${heading}`)
  return { value: mode === 'return' ? returned : outputs[0], code }
}

await test('every shipped program typechecks against the generated discriminated SDK', async () => {
  await withTempDir('teaching-types', async root => {
    const file = path.join(root, 'examples.ts')
    const sdkPath = path.join(PACKAGE_ROOT, 'lib/ptc/sdk').replaceAll('\\', '/')
    fs.writeFileSync(file, `declare const tools: import(${JSON.stringify(sdkPath)}).OpsSdk; declare const inspect: (...values: unknown[]) => void;\n`
      + ['inspect', 'return', 'console'].flatMap(mode => blocks(mode).map((block, index) => `async function example${mode}${index}() {\n${block}\n}`)).join('\n'))
    const compilation = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler })
    const errors = ts.getPreEmitDiagnostics(compilation)
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n',
    }))
  })
})

await test('all five shipped plan blocks execute in every output mode', async () => {
  for (const mode of OUTPUT_MODES) {
    await withTempDir(`teaching-${mode}`, async root => {
      fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'empty'))
      fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
      fs.writeFileSync(path.join(root, 'src', 'policy.ts'), 'export const batchingGuidance = true\nexport const VERSION = 1\n')
      fs.writeFileSync(path.join(root, 'events.jsonl'), 'event\n'.repeat(401))
      const tools = sdk(root)

      assert.equal(blocks(mode).length, headings.length, mode)
      for (const heading of headings) assert.ok(blockFor(mode, heading), `missing heading in ${mode}: ${heading}`)

      const loaded = await execute(mode, 'load glob/read_files/stat', tools)
      assert.deepEqual(loaded.value, { loaded: ['glob', 'read_files', 'stat'], headLines: 1 })

      const listing = await execute(mode, 'top-level directory list', tools)
      assert.deepEqual(listing.value.status, ['completed', 'completed', 'completed'])
      assert.deepEqual(listing.value.dirs.map(item => path.basename(item)).sort(), ['empty', 'src'])
      assert.deepEqual(listing.value.src.map(item => path.basename(item)), ['policy.ts'])
      assert.equal(listing.value.manifestLines, 1)

      const search = await execute(mode, 'find the batching sites', tools)
      assert.equal(search.value.search.status, 'completed')
      assert.equal(search.value.search.scanComplete, true)
      assert.equal(search.value.search.complete, true)
      assert.equal(search.value.reads.length, 1)
      assert.equal(search.value.reads[0].status, 'completed')
      assert.equal(search.value.reads[0].lines, 2)
      const failedSearch = await execute(mode, 'find the batching sites', { ...tools,
        ops_grep: args => tools.ops_grep({ ...args, pattern: '[' }) })
      assert.equal(failedSearch.value.search.status, 'error')
      assert.equal(typeof failedSearch.value.search.error.code, 'string')
      assert.deepEqual(failedSearch.value.reads, [], 'search failure does not fan out reads')

      const edit = await execute(mode, 'read the revision', tools)
      assert.equal(edit.value.status, 'completed')
      assert.equal(edit.value.changed, 1)
      assert.match(fs.readFileSync(path.join(root, 'src', 'policy.ts'), 'utf8'), /VERSION = 2/)
      const failedEdit = await execute(mode, 'read the revision', {
        ...tools, ops_stat: async () => ({ status: 'error', error: { code: 'STAT_FAILED' } }),
      })
      assert.equal(failedEdit.value.status, 'error')
      assert.equal(failedEdit.value.error.code, 'STAT_FAILED')

      const read = await execute(mode, 'read every page of the event log', tools)
      assert.equal(read.value.lines, 401)
      assert.equal(read.value.complete, true)
      assert.equal(read.value.error, undefined)
      fs.unlinkSync(path.join(root, 'events.jsonl'))
      const failedRead = await execute(mode, 'read every page of the event log', tools)
      assert.equal(failedRead.value.complete, false)
      assert.equal(typeof failedRead.value.error.code, 'string')
    })
  }
})

await test('each search mode and multi-file failure validates against its generated SDK shape', async () => {
  await withTempDir('sdk-return-modes', async root => {
    fs.writeFileSync(path.join(root, 'one.ts'), 'export const needle = 1\nneedle\n')
    fs.writeFileSync(path.join(root, 'two.ts'), 'needle\n')
    const tools = sdk(root)
    for (const outputMode of ['paths', 'details']) {
      const result = await tools.ops_glob({ pattern: ['*.ts'], outputMode })
      assert.equal(result.status, 'completed')
      for (const item of result.data.items) assert.equal(typeof (outputMode === 'paths' ? item : item.path), 'string')
    }
    for (const outputMode of ['content', 'files_with_matches', 'count', 'summary', 'definitions']) {
      const result = await tools.ops_grep({ pattern: 'needle', outputMode })
      assert.equal(result.status, 'completed', outputMode)
      if (outputMode === 'summary') { assert.deepEqual(result.data.items, []); assert.equal(result.data.matches, 3) }
      else for (const item of result.data.items) {
        assert.equal(typeof item.path, 'string')
        if (outputMode === 'count') assert.equal(typeof item.count, 'number')
        if (['content', 'definitions'].includes(outputMode)) { assert.equal(typeof item.text, 'string'); assert.equal(typeof item.line, 'number') }
        if (outputMode === 'definitions') assert.equal(typeof item.kind, 'string')
      }
    }
    const read = await tools.ops_read_files({ files: [{ path: 'one.ts', limit: 1 }, { path: 'two.ts' }, { path: 'missing' }] })
    assert.equal(read.status, 'error'); assert.equal(read.data.items[0].complete, false)
    assert.equal(read.data.items[0].nextOffset, 2); assert.equal(read.data.items[1].complete, true)
    assert.equal(typeof read.data.items[2].error.code, 'string')
  })
})

await test('the host-rendered SDK retains typed modes and excludes unrelated search metadata', () => {
  const schemas = ['inspect_local_file', 'glob', 'grep', 'read_files', 'stat'].map(name => {
    const tool = definition(name, async () => null)
    return { ...tool, output: tool.output.schema }
  })
  const text = renderToolsSdk(schemas)
  assert.match(text, /paths \(default\): string\[\]/)
  assert.match(text, /files_with_matches: \{path\}\[\]/)
  for (const tool of schemas.filter(tool => ['ops_glob', 'ops_grep'].includes(tool.name))) {
    for (const branch of tool.output.oneOf) {
      for (const key of ['revision', 'bytes', 'lineCount', 'dryRun']) assert.equal(key in branch.properties.data.properties, false)
      assert.notDeepEqual(branch.properties.data.properties.items.items, {})
    }
  }
  console.log(`  host SDK (five loaded APIs, shared PTC projection): ${Buffer.byteLength(text)} bytes`)
})

report('batching-examples')
