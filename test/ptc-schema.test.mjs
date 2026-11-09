/** PTC schemas must remain discoverable in the actual pinned host SDK. */
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { jsonSchemaToTs } from '@deepseek-ai/dsh-tool-executor-ptc'
import { assert, test, report } from './lib/harness.mjs'
import { PTC_TOOLS, PARAMETERS, OUTPUT } from '../lib/ptc/contract.js'

await test('both PTC arguments and outputs render real SDK shapes, never unknown', () => {
  for (const tool of PTC_TOOLS) {
    assertSupportedJsonSchema(PARAMETERS[tool])
    assertSupportedJsonSchema(OUTPUT)
    const args = jsonSchemaToTs(PARAMETERS[tool])
    assert.notEqual(args, 'unknown')
    assert.match(args, /action/)
    assert.match(args, tool === 'batch' ? /operations/ : /maxBytes/)
    assert.notEqual(jsonSchemaToTs(OUTPUT), 'unknown')
  }
})
await test('every typed reference schema tells the model how to load result without changing its fields', async () => {
  const { canonicalOutput } = await import('../lib/projections/ptc/canonical-schema.js')
  const { PTC_API_TOOLS } = await import('../lib/projections/ptc/contract.js')
  const { STORAGE_REFERENCE } = await import('../lib/capabilities/result.js')
  for (const tool of PTC_API_TOOLS) {
    const reference = canonicalOutput(tool).properties.reference
    assert.match(reference.description, /ops_load_sdk\(\{tools:\['result'\]\}\)/, tool)
    assert.deepEqual(reference.properties, STORAGE_REFERENCE.properties, tool)
    assert.deepEqual(reference.required, STORAGE_REFERENCE.required, tool)
  }
})
report('ptc-schema')
