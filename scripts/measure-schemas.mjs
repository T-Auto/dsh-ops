#!/usr/bin/env node
// Manual measurement, not a test or CI gate. No tool calls are executed.
import fs from 'node:fs'
import path from 'node:path'
import { resolveBinary, probeBinary } from '../lib/binary.js'
import { McpStdioClient } from '../lib/handshake.js'
import { childEnv, toolDefinition } from '../lib/tools.js'
import { FILE_TOOLS, publicToolName, renderToolingPolicy } from '../lib/policy.js'

const runtime = resolveBinary()
const probe = probeBinary(runtime.file)
const client = McpStdioClient.start({ file: runtime.file, args: ['serve', '--enable-shell'], env: childEnv(), timeoutMs: 60_000 })
function size(value) {
  const bytes = Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  return { bytes, approximateTokens: Math.ceil(bytes / 4) }
}
try {
  const handshake = await client.initialize('dsh-ops-schema-measurement')
  const tools = await client.listTools()
  const rows = tools.map(tool => {
    const definition = toolDefinition({ tool, call: () => {} })
    return { name: publicToolName(tool.name), ...size({ name: definition.name, description: definition.description, parameters: definition.parameters }) }
  })
  const bytes = rows.reduce((sum, row) => sum + row.bytes, 0)
  const fileNames = tools.filter(tool => FILE_TOOLS.includes(tool.name)).map(tool => publicToolName(tool.name))
  const fileBytes = rows.filter(row => fileNames.includes(row.name)).reduce((sum, row) => sum + row.bytes, 0)
  const report = {
    format: 'dsh-ops-schema-measurement-v1',
    metric: 'UTF-8 bytes of compact JSON {name,description,parameters}; approximate tokens = ceil(bytes/4), not a tokenizer or usage-frequency count',
    runtimeVersion: probe.version,
    tools: rows,
    total: { bytes, approximateTokens: Math.ceil(bytes / 4) },
    fileOnly: { bytes: fileBytes, approximateTokens: Math.ceil(fileBytes / 4) },
    fileOnlyPrompt: size(renderToolingPolicy({ published: fileNames })),
    toolingPrompt: size(renderToolingPolicy({ published: tools.map(tool => publicToolName(tool.name)) })),
    publishedServerInstructions: size(''),
    rawServerInstructions: size(handshake.instructions ?? ''),
  }
  const text = JSON.stringify(report, null, 2) + '\n'
  const output = process.argv[2]
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
    fs.writeFileSync(output, text)
  }
  console.log(text)
} finally {
  await client.close()
}
