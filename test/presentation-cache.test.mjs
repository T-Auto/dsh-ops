import { clearNativePresentationCache, invalidateNativePresentation, isNativePresentation } from '../lib/presentation.js'
import { assert, test, report } from './lib/harness.mjs'

/** Minimal PromptAssembly stub; only the sections list matters for verdicts. */
const assembly = (sections = []) => ({ sections, contexts: [], tools: [], variables: {} })
const promptOf = assemble => ({ assemble })
const scopeOf = () => ({})
const ptcSection = text => ({ name: 'tools:ptc-only', text, interpolate: true })

await test('concurrent probes share one assemble; later probes hit the cache', async () => {
  clearNativePresentationCache()
  let calls = 0
  const prompt = promptOf(async () => { calls++; return assembly() })
  const scope = scopeOf()
  const [a, b] = await Promise.all([isNativePresentation(prompt, scope), isNativePresentation(prompt, scope)])
  assert.equal(a, true)
  assert.equal(b, true)
  assert.equal(calls, 1, 'concurrent same-scope probes assemble exactly once')
  assert.equal(await isNativePresentation(prompt, scope), true)
  assert.equal(calls, 1, 'a cached probe assembles nothing')
})

await test('invalidateNativePresentation evicts one scope and re-assembles the next probe', async () => {
  clearNativePresentationCache()
  let calls = 0
  const prompt = promptOf(async () => { calls++; return assembly([ptcSection('code only')]) })
  const scope = scopeOf()
  assert.equal(await isNativePresentation(prompt, scope), false)
  assert.equal(calls, 1)
  invalidateNativePresentation(scope)
  assert.equal(await isNativePresentation(prompt, scope), false)
  assert.equal(calls, 2, 'invalidation forces exactly one recomputation')
})

await test('a ptc-only section disappearing flips the verdict after invalidation', async () => {
  clearNativePresentationCache()
  let ptc = true
  const prompt = promptOf(async () => assembly(ptc ? [ptcSection('code only')] : []))
  const scope = scopeOf()
  assert.equal(await isNativePresentation(prompt, scope), false)
  ptc = false
  assert.equal(await isNativePresentation(prompt, scope), false, 'the cached verdict stays until invalidation')
  invalidateNativePresentation(scope)
  assert.equal(await isNativePresentation(prompt, scope), true, 'a vanished ptc-only section flips the verdict')
})

await test('a failed probe is evicted so the next probe retries', async () => {
  clearNativePresentationCache()
  let calls = 0
  const prompt = promptOf(async () => { if (++calls === 1) throw new Error('boom'); return assembly() })
  const scope = scopeOf()
  await assert.rejects(isNativePresentation(prompt, scope), /boom/)
  assert.equal(await isNativePresentation(prompt, scope), true)
  assert.equal(calls, 2, 'a failed probe does not poison the cache')
})

await test('a different prompt instance recomputes under the same scope', async () => {
  clearNativePresentationCache()
  let calls = 0
  const scope = scopeOf()
  assert.equal(await isNativePresentation(promptOf(async () => { calls++; return assembly() }), scope), true)
  assert.equal(await isNativePresentation(promptOf(async () => { calls++; return assembly() }), scope), true)
  assert.equal(calls, 2, 'a new prompt instance invalidates the memo')
})

await test('clearNativePresentationCache drops every saved verdict', async () => {
  clearNativePresentationCache()
  let calls = 0
  const prompt = promptOf(async () => { calls++; return assembly() })
  const a = scopeOf(), b = scopeOf()
  await isNativePresentation(prompt, a)
  await isNativePresentation(prompt, b)
  assert.equal(calls, 2)
  clearNativePresentationCache()
  await isNativePresentation(prompt, a)
  await isNativePresentation(prompt, b)
  assert.equal(calls, 4, 'clearing drops both scoped entries')
})

report('presentation-cache')
