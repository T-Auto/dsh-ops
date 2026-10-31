/** PTC schemas must remain discoverable in the actual pinned host SDK. */
import { assertSupportedJsonSchema, jsonSchemaToTs } from '@deepseek-ai/dsh-tools'
import { assert, test, report } from './lib/harness.mjs'
import { PTC_TOOLS, PARAMETERS, OUTPUT } from '../lib/ptc/contract.js'

await test('both PTC arguments and outputs render real SDK shapes, never unknown', () => {
  for (const tool of PTC_TOOLS) {
    assertSupportedJsonSchema(PARAMETERS[tool])
    assertSupportedJsonSchema(OUTPUT)
    const args = jsonSchemaToTs(PARAMETERS[tool])
    assert.notEqual(args, 'unknown')
    // Every required argument has to survive into the generated TypeScript: a schema that renders
    // without naming its own required fields is one the model cannot call correctly.
    for (const field of PARAMETERS[tool].required) assert.match(args, new RegExp(`\\b${field}\\b`), `${tool} renders ${field}`)
    assert.notEqual(jsonSchemaToTs(OUTPUT), 'unknown')
  }
})
report('ptc-schema')
