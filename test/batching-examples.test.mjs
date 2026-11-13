/** Execute the shipped teaching programs against canonical worker returns. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { renderToolsSdk } from '@deepseek-ai/dsh-tool-executor-ptc'
import { definition } from '../lib/projections/ptc/contract.js'
import { loadBatchingGuidance } from '../lib/ptc/batching-guidance.js'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
import { assert, test, report, withTempDir, PACKAGE_ROOT } from './lib/harness.mjs'
requireWorker('batching-examples')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const blocks = [...loadBatchingGuidance().matchAll(/```ts\r?\n([\s\S]*?)```/gu)].map(match => match[1])
const program = heading => blocks.find(block => block.startsWith('// plan: ' + heading))
function sdk(root) {
  return Object.fromEntries(['glob', 'grep', 'read_files', 'stat', 'inspect_local_file', 'edit_file'].map(name => {
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
}
const execute = (heading, tools) => new AsyncFunction('tools', program(heading))(tools)

await test('every shipped program typechecks against the generated discriminated SDK', async () => {
  await withTempDir('teaching-types', async root => {
    const file = path.join(root, 'examples.ts')
    const sdkPath = path.join(PACKAGE_ROOT, 'lib/ptc/sdk').replaceAll('\\', '/')
    fs.writeFileSync(file, `declare const tools: import(${JSON.stringify(sdkPath)}).OpsSdk;\n`
      + blocks.map((block, index) => `async function example${index}() {\n${block}\n}`).join('\n'))
    const compilation = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler })
    const errors = ts.getPreEmitDiagnostics(compilation)
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n',
    }))
  })
})

await test('reconnaissance and search examples consume real glob strings and grep paths', async () => {
  await withTempDir('teaching-shapes', async root => {
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'empty'))
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
    fs.writeFileSync(path.join(root, 'src', 'policy.ts'), 'export const batchingGuidance = true\nexport const VERSION = 1\n')
    const tools = sdk(root)
    const listing = await execute('top-level directory list', tools)
    assert.deepEqual(listing.status, ['completed', 'completed', 'completed'])
    assert.deepEqual(listing.dirs.map(item => path.basename(item)).sort(), ['empty', 'src'])
    assert.deepEqual(listing.src.map(item => path.basename(item)), ['policy.ts'])
    assert.equal(listing.manifestLines, 1)
    const search = await execute('find the batching sites', tools)
    assert.equal(search.search.status, 'completed'); assert.equal(search.search.scanComplete, true)
    assert.equal(search.search.complete, true); assert.equal(search.reads.length, 1)
    assert.equal(search.reads[0].status, 'completed'); assert.equal(search.reads[0].lines, 2)
    const failed = await execute('find the batching sites', { ...tools,
      ops_grep: args => tools.ops_grep({ ...args, pattern: '[' }) })
    assert.equal(failed.search.status, 'error'); assert.equal(typeof failed.search.error.code, 'string')
    assert.deepEqual(failed.reads, [], 'no hits were available; this is an explicit search failure, not an empty success')
    const edit = await execute('read the revision', tools)
    assert.equal(edit.status, 'completed'); assert.equal(edit.changed, 1)
    assert.match(fs.readFileSync(path.join(root, 'src', 'policy.ts'), 'utf8'), /VERSION = 2/)
  })
})

await test('paging example reports completion and retains a real failure', async () => {
  await withTempDir('teaching-pages', async root => {
    fs.writeFileSync(path.join(root, 'events.jsonl'), 'event\n'.repeat(401))
    const tools = sdk(root)
    const read = await execute('read every page', tools)
    assert.equal(read.lines, 401); assert.equal(read.complete, true); assert.equal(read.error, undefined)
    fs.unlinkSync(path.join(root, 'events.jsonl'))
    const failed = await execute('read every page', tools)
    assert.equal(failed.complete, false); assert.equal(typeof failed.error.code, 'string')
  })
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
