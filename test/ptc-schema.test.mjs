/** PTC schemas must remain discoverable in the actual pinned host SDK. */
import { assertSupportedJsonSchema, jsonSchemaToTs } from './lib/host-schema.mjs'
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
report('ptc-schema')
