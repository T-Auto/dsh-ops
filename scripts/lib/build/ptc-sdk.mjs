/** Generate declarations from the same schemas used by PTC registration and host validation. */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { jsonSchemaToTs } from '@deepseek-ai/dsh-tools'

export async function writePtcDeclarations(root) {
  const load = relative => import(pathToFileURL(path.join(root, 'lib', relative)).href)
  const [{ CAPABILITIES, SDK_CAPABILITIES }, { definition }, { outcomeSchema }, { publicToolName }] = await Promise.all([
    load('capabilities/registry.js'), load('ptc/contract.js'), load('ptc/projection/schema.js'), load('policy.js'),
  ])
  // The loader owns a different receipt shape from every data tool. Read its name from the
  // catalogue instead of a literal so the next rename cannot silently widen these declarations.
  const sdkRawName = SDK_CAPABILITIES[0].rawName
  const entries = CAPABILITIES.filter(entry => 'parameters' in entry && entry.presentations.includes('ptc'))
    .sort((a, b) => a.rawName.localeCompare(b.rawName, 'en'))
  const members = entries.map(entry => {
    const output = entry.rawName === sdkRawName ? outcomeSchema(entry.output) : definition(entry.rawName, async () => null).output.schema
    return `  ${JSON.stringify(publicToolName(entry.rawName))}: (args: ${jsonSchemaToTs(entry.parameters)}) => Promise<${jsonSchemaToTs(output)}>;`
  })
  // This source contains type declarations only, and is the authoritative shared Outcome vocabulary.
  const contracts = fs.readFileSync(path.join(root, 'src/kernel/outcome.ts'), 'utf8')
  const text = '// Derived from the capability catalogue; rebuild with npm run build.\n' + contracts +
    '\nexport type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };\n' +
    '\n/** Available bindings still depend on component, scope, presentation and SDK activation. */\n' +
    'export interface OpsSdk {\n' + members.join('\n') + '\n}\n'
  fs.writeFileSync(path.join(root, 'lib/ptc/sdk.d.ts'), text)
  return { tools: entries.length, bytes: Buffer.byteLength(text) }
}
