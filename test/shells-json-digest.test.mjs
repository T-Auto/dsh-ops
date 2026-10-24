import fs from 'node:fs/promises'
import path from 'node:path'
import { getEncoding } from 'js-tiktoken'
import { createJsonDigestProjection, jsonDigest } from '../lib/shells/json-digest.js'
import { hostForeground, renderHostBash } from '../lib/shells/host-contract.js'
import { hostBashDefinition } from '../lib/shells/host-tool.js'
import { bashToolDefinition } from '../lib/shells.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const raw = JSON.stringify({ items: Array.from({ length: 1200 }, (_, index) => ({ index, status: index === 1199 ? 'failed' : 'ok', name: 'item name '.repeat(8) })) })
const call = (extra = {}) => ({ token: Symbol('call'), signal: new AbortController().signal, ...extra })
const value = file => hostForeground({ exitCode: 0, timedOut: false, timeoutMs: 1000,
  stdout: { text: raw.slice(-65536), truncated: true, spillPath: file }, stderr: { text: 'stderr is preserved', truncated: false } })
const outcome = value => ({ isError: false, value, content: [{ type: 'text', text: renderHostBash(value) }] })

await test('large JSON has bounded samples, error examples, recovery and measured token reduction', () => {
  const text = jsonDigest(raw, '/private/original.log')
  assert.match(text, /lossy samples, not an exhaustive error check/)
  assert.match(text, /"length":1200/); assert.match(text, /"status":"failed"/)
  assert.match(text, /full output: "\/private\/original.log"/)
  const encoding = getEncoding('cl100k_base')
  const before = encoding.encode(raw.slice(-65536)).length, after = encoding.encode(text).length
  console.log(`  JSON fixture cl100k_base: ${before} -> ${after} tokens`)
  assert.ok(after < before * 0.8)
  assert.ok(Buffer.byteLength(text) < 4600)
})

await test('malformed, scalar, tiny, oversized and excessive-summary JSON keep raw rendering', () => {
  for (const text of ['{"broken":', 'x'.repeat(9000), JSON.stringify('a'.repeat(9000)), '{}', ' '.repeat(2 * 1024 * 1024 + 1),
    JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, n) => ['k'.repeat(1000) + n, 'v'.repeat(1000)])))]) assert.equal(jsonDigest(text, '/full'), undefined)
})

await test('Native projection reads intact spill but keeps the canonical result and stderr unchanged', async () => {
  await withTempDir('json-digest', async dir => {
    const file = path.join(dir, 'stdout.log'); await fs.writeFile(file, raw)
    const original = value(file), snapshot = structuredClone(original), exec = call(), projection = createJsonDigestProjection()
    await projection.prepare(original, exec)
    const content = projection.projectContent(exec, outcome(original))
    assert.match(content[0].text, /JSON summary/); assert.match(content[0].text, /stderr is preserved/)
    assert.match(content[0].text, /\[exit code: 0\]$/)
    assert.deepEqual(original, snapshot); assert.equal(await fs.readFile(file, 'utf8'), raw)
    assert.equal(projection.projectContent(exec, { isError: false }), undefined)
  })
})

await test('nested SDK calls, failures, absent spills and cancellation keep original content', async () => {
  await withTempDir('json-digest-fallback', async dir => {
    const file = path.join(dir, 'stdout.log'); await fs.writeFile(file, raw)
    const cancelled = new AbortController(); cancelled.abort()
    for (const [original, exec] of [[value(file), call({ parent: Symbol('ptc') })], [value(file), {}],
      [{ ...value(file), exitCode: 2, status: 'failed' }, call()], [value(file), call({ signal: cancelled.signal })],
      [{ ...value(file), stopped: 'cancelled' }, call()], [{ ...value(file), stdout: { text: raw, truncated: false } }, call()]]) {
      const projection = createJsonDigestProjection(), snapshot = structuredClone(original)
      await projection.prepare(original, exec)
      if (exec.token) assert.equal(projection.projectContent(exec, { isError: false }), undefined)
      assert.deepEqual(original, snapshot)
    }
    for (const result of [{ isError: true }, { isError: false }]) {
      const projection = createJsonDigestProjection(), controller = new AbortController(), exec = call({ signal: controller.signal })
      await projection.prepare(value(file), exec)
      if (!result.isError) controller.abort()
      assert.equal(projection.projectContent(exec, result), undefined)
    }
  })
})

await test('missing, invalid UTF-8, malformed and over-budget spill files fail open', async () => {
  await withTempDir('json-digest-spills', async dir => {
    for (const bytes of [Buffer.alloc(9000, 0xff), Buffer.from('{'.repeat(9000)), Buffer.alloc(2 * 1024 * 1024 + 1, 32)]) {
      const file = path.join(dir, 'stdout.log'); await fs.writeFile(file, bytes)
      const projection = createJsonDigestProjection(), exec = call()
      await projection.prepare(value(file), exec)
      assert.equal(projection.projectContent(exec, { isError: false }), undefined)
    }
    for (const file of [path.join(dir, 'missing'), dir, 'relative.log']) {
      const projection = createJsonDigestProjection(), exec = call()
      await projection.prepare(value(file), exec)
      assert.equal(projection.projectContent(exec, { isError: false }), undefined)
    }
  })
})

await test('published host definition prepares content after foreground execution without changing its schema/value', async () => {
  await withTempDir('json-digest-host', async dir => {
    const file = path.join(dir, 'stdout.log'); await fs.writeFile(file, raw)
    const result = value(file), exec = call({ agent: { session: { id: 'digest', header: { cwd: dir } } } })
    const base = bashToolDefinition({ file: process.execPath, source: 'config' })
    const ctx = { get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : undefined }
    const definition = hostBashDefinition(ctx, base, async () => ({ started: true, result: async () => result }), () => dir)
    const canonical = await definition.execute({ command: 'produce-json', description: 'Produce a large JSON result' }, exec)
    assert.deepEqual(canonical, result)
    assert.equal(definition.output.render({}, canonical)[0].text, renderHostBash(result))
    assert.match(definition.projectContent(exec, outcome(canonical))[0].text, /JSON summary/)
  })
})

await test('real host registry applies Native projection and preserves nested SDK content and values', async () => {
  await withTempDir('json-digest-registry', async dir => {
    const file = path.join(dir, 'stdout.log'); await fs.writeFile(file, raw)
    const { ctx, tools } = await bootHost(), agent = { session: { id: 'digest-registry', header: { cwd: dir } } }
    try {
      const original = value(file), base = bashToolDefinition({ file: process.execPath, source: 'config' })
      const shellCtx = { get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) } : undefined }
      const definition = hostBashDefinition(shellCtx, base, async () => ({ started: true, result: async () => original }), () => dir)
      let nested
      await ctx.plugin({ inject: ['tools'], apply(inner) {
        inner.tools.register(definition)
        inner.tools.register({ name: 'digest_transport_fixture', description: 'Nested execution fixture',
          parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] },
          async execute(_args, exec) {
            nested = await tools.execute({ agent, name: definition.name, callId: 'nested-digest', parent: exec.token,
              arguments: { command: 'produce-json', description: 'Produce a large JSON result' }, signal: exec.signal })
            return {}
          },
        })
      } })
      const result = await tools.execute({ agent, name: definition.name, callId: 'native-digest',
        arguments: { command: 'produce-json', description: 'Produce a large JSON result' }, signal: new AbortController().signal })
      assert.equal(result.isError, false)
      assert.deepEqual(result.value, original)
      assert.match(result.content[0].text, /JSON summary/)
      const transport = await tools.execute({ agent, name: 'digest_transport_fixture', callId: 'outer-digest', arguments: {}, signal: new AbortController().signal })
      assert.equal(transport.isError, false); assert.equal(nested.isError, false)
      assert.deepEqual(nested.value, original)
      assert.equal(nested.content[0].text, renderHostBash(original))
      for (const [decision, expected] of [
        [{ kind: 'accept', content: [{ type: 'text', text: 'policy redacted' }] }, 'policy redacted'],
        [{ kind: 'accept', value: { ...original, stdout: { text: 'policy replaced value', truncated: false } } }, 'policy replaced value'],
        [{ kind: 'block', feedback: [{ type: 'text', text: 'policy blocked' }] }, 'policy blocked'],
      ]) {
        const stop = ctx.on('tools/post-execute', async () => decision)
        try {
          const result = await tools.execute({ agent, name: definition.name, callId: `policy-${expected}`,
            arguments: { command: 'produce-json', description: 'Produce a large JSON result' }, signal: new AbortController().signal })
          assert.ok(result.content[0].text.includes(expected))
          assert.doesNotMatch(result.content[0].text, /JSON summary/)
          assert.equal(result.isError, decision.kind === 'block')
        } finally { stop() }
      }
    } finally { await shutdown(ctx) }
  })
})

await test('pre-projection replacements cannot reuse a prepared summary from different content or value', async () => {
  await withTempDir('json-digest-policy', async dir => {
    const file = path.join(dir, 'stdout.log'); await fs.writeFile(file, raw)
    for (const mutate of [result => ({ ...result, content: [{ type: 'text', text: 'redacted' }] }),
      result => ({ ...result, value: { ...result.value, stdout: { text: 'changed', truncated: false } } })]) {
      const original = value(file), exec = call(), projection = createJsonDigestProjection()
      await projection.prepare(original, exec)
      assert.equal(projection.projectContent(exec, mutate(outcome(original))), undefined)
    }
  })
})

report('shells-json-digest')
