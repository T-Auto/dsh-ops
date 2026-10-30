/** PTC mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
 * type literals in `lib/ptc/sdk.d.ts`.
 *
 * DSH 0.2.2 removed `jsonSchemaToTs` from the published `@deepseek-ai/dsh-tools` surface
 * (the host now owns its `tools:sdk` rendering internally), so the build vendors the exact
 * implementation the plugin's declarations were generated with. The schema boundary still
 * comes from the host: `assertSupportedJsonSchema` is exported by every supported DSH line,
 * which keeps this projection locked to the schema constructs the running host accepts.
 * @module dsh-ops/scripts/lib/build/json-schema-to-ts
 */
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name) {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name)
}
/** One `indent`-deep line prefix (two spaces per level). */
function pad(indent) {
  return '  '.repeat(indent)
}
/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines(description, indent) {
  if (typeof description !== 'string' || description.length === 0)
    return []
  // Collapse prose to stable one-line docs and escape comment closers so a
  // schema description cannot terminate generated JSDoc.
  const collapsed = description.replace(/\s+/g, ' ').trim()
  return [`${pad(indent)}/** ${collapsed.replaceAll('*/', String.raw`*\/`)} */`]
}
/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value) {
  return JSON.stringify(value)
}
/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar(node, type) {
  const broad = type === 'integer' ? 'number' : type
  if (Object.hasOwn(node, 'const'))
    return renderScalar(node.const)
  if (Object.hasOwn(node, 'enum')) {
    return node.enum.map(renderScalar).join(' | ')
  }
  return broad
}
/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts) {
  return {
    parts,
    containsUnionOrIntersection: parts.some(part => typeof part === 'string'
      ? part.includes('|') || part.includes('&')
      : part.containsUnionOrIntersection),
  }
}
/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts) {
  return typeDocumentFrom(parts)
}
/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document) {
  const chunks = []
  const tasks = [document]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (typeof task === 'string') {
      chunks.push(task)
      continue
    }
    for (let index = task.parts.length - 1; index >= 0; index--) {
      const part = task.parts[index]
      if (part !== undefined)
        tasks.push(part)
    }
  }
  return chunks.join('')
}
/** Initialize one schema-render frame with empty aggregation state. */
function schemaRenderFrame(node, indent) {
  return { node, indent, phase: 'start', children: [], childIndex: 0, childDocuments: [], entries: [] }
}
/** Render an already asserted schema to a composable document. */
function renderSupportedSchema(schema, indent) {
  const frames = [schemaRenderFrame(schema, indent)]
  let rootDocument
  const finish = (document) => {
    frames.pop()
    const parent = frames.at(-1)
    if (parent === undefined)
      rootDocument = document
    else
      parent.childDocuments.push(document)
  }
  while (frames.length > 0) {
    const frame = frames.at(-1)
    if (frame === undefined)
      break
    if (frame.phase === 'children') {
      if (frame.childIndex < frame.children.length) {
        const child = frame.children[frame.childIndex]
        if (child === undefined)
          throw new Error('missing schema render child')
        frame.childIndex++
        frames.push(schemaRenderFrame(child.node, child.indent))
        continue
      }
      if (frame.kind === 'oneOf') {
        const parts = []
        for (let index = 0; index < frame.childDocuments.length; index++) {
          if (index > 0)
            parts.push(' | ')
          const child = frame.childDocuments[index]
          if (child !== undefined)
            parts.push(child)
        }
        finish(typeDocumentFrom(parts))
        continue
      }
      if (frame.kind === 'array') {
        const child = frame.childDocuments[0]
        if (child === undefined)
          throw new Error('missing array item type')
        finish(child.containsUnionOrIntersection
          ? typeDocument('(', child, ')[]')
          : typeDocument(child, '[]'))
        continue
      }
      const required = new Set(frame.node.required)
      const parts = ['{']
      for (let index = 0; index < frame.entries.length; index++) {
        const entry = frame.entries[index]
        const child = frame.childDocuments[index]
        if (entry === undefined || child === undefined)
          throw new Error('missing object property type')
        const [name, prop] = entry
        for (const line of docLines(prop.description, frame.indent + 1))
          parts.push('\n', line)
        parts.push('\n', `${pad(frame.indent + 1)}${renderKey(name)}${required.has(name) ? '' : '?'}: `, child, ';')
      }
      parts.push('\n', `${pad(frame.indent)}}`)
      const declared = typeDocumentFrom(parts)
      finish(frame.node.additionalProperties === false
        ? declared
        : typeDocument(declared, ' & Record<string, JsonValue>'))
      continue
    }
    const node = frame.node
    if (node.oneOf !== undefined) {
      frame.kind = 'oneOf'
      frame.children = Array.from(node.oneOf, child => ({ node: child, indent: frame.indent }))
      frame.childIndex = 0
      frame.childDocuments = []
      frame.phase = 'children'
      continue
    }
    if (node.type === undefined) {
      finish(typeDocument('JsonValue'))
      continue
    }
    switch (node.type) {
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        finish(typeDocument(renderConstrainedScalar(node, node.type)))
        break
      case 'array':
        if (node.items === undefined) {
          finish(typeDocument('JsonValue[]'))
        }
        else {
          frame.kind = 'array'
          frame.children = [{ node: node.items, indent: frame.indent }]
          frame.childIndex = 0
          frame.childDocuments = []
          frame.phase = 'children'
        }
        break
      case 'object': {
        const open = node.additionalProperties !== false
        const entries = Object.entries(node.properties ?? {})
        if (entries.length === 0) {
          finish(typeDocument(open ? 'Record<string, JsonValue>' : 'Record<string, never>'))
        }
        else {
          frame.kind = 'object'
          frame.entries = entries
          frame.children = entries.map(([, child]) => ({ node: child, indent: frame.indent + 1 }))
          frame.childIndex = 0
          frame.childDocuments = []
          frame.phase = 'children'
        }
        break
      }
      // assertSupportedJsonSchema narrowed this closed type union.
      default:
        finish(typeDocument('unknown'))
    }
  }
  return rootDocument ?? typeDocument('unknown')
}
/**
 * Map one enforced JSON-Schema node to a TypeScript type literal. Supports
 * every unified schema construct and returns `unknown` for malformed or
 * unsupported inputs without throwing.
 * @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
 * @param indent - the indentation level for nested object members.
 * @returns the TS type text (multi-line for objects with properties).
 */
export function jsonSchemaToTs(schema, indent = 0) {
  try {
    assertSupportedJsonSchema(schema)
    return flattenTypeDocument(renderSupportedSchema(schema, indent))
  }
  catch {
    return 'unknown'
  }
}
