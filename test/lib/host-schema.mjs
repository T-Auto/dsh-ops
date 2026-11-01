/** Use the published host's schema validator and SDK renderer on both API layouts. */
import * as tools from '@deepseek-ai/dsh-tools'
export const { assertSupportedJsonSchema, validateJsonSchemaValue } = tools
export const jsonSchemaToTs = tools.jsonSchemaToTs
  ?? (await import('@deepseek-ai/dsh-tool-executor-ptc')).jsonSchemaToTs
