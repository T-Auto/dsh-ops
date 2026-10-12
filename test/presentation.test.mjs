/**
 * Presentation: the model-facing parameter text matches what the runtime does.
 *
 * `projectTool` rewrites what the model reads — the tool description, and the
 * description of every parameter it recognises by field name. Two of those
 * field descriptions used to advertise a "connection directory": a term this
 * repository defines nowhere, and, for an omitted `path` or `cwd`, simply
 * untrue. The runtime fills an omitted `path` from the calling session's
 * working directory (`lib/tools.js`, `#callActive`) and an omitted `cwd` from
 * the same place (`lib/tools.js`, the `run_background` case); the one
 * deployment that still ends up on FastCtx's own directory is the explicit
 * `fileToolRoot: 'process'` opt-in, which the new text names.
 *
 * This suite pins both replacements so the wording and the implementation
 * cannot drift apart again (the PR #11 precedent: the contract is held still by
 * a test, not by the reviewer's memory).
 *
 * The fixtures here are synthetic. Every raw tool descriptor below is
 * hand-written, with parameter names and shapes mirroring the descriptors the
 * runtime publishes for these four tools, while what this suite guards is the
 * projection's own logic — which field name receives which text, and that every
 * carrier of a shared field receives the same string. It does not bind the
 * upstream FastCtx schema, so a change there is not something these checks can
 * catch.
 */

import { publicToolName } from '../lib/policy.js'
import { projectTool } from '../lib/presentation.js'
import { assert, report, test } from './lib/harness.mjs'

/**
 * The tool-level carriers of `FIELDS.path` this fixture declares, raw names as
 * FastCtx emits them. `FIELDS.path` has four carriers in all: these three
 * top-level `path` parameters, plus the nested `files[].path` of
 * `ops_inspect_local_file` — the same field-name lookup rewrites it, and it
 * cannot appear in this list because it is an array entry, not a parameter.
 */
const PATH_TOOLS = ['glob', 'grep', 'replace']

/**
 * A raw FastCtx tool, shaped like the one `toolDefinition` receives. `name` is
 * the runtime's own (`glob`, not `ops_glob`) — the `ops_` prefix belongs to
 * `toolDefinition`, not to the projection. Parameter names and shapes mirror
 * the descriptors the runtime publishes; the descriptions are synthetic because
 * the projection replaces them wholesale.
 * @param {string} name - the runtime tool name.
 * @param {Record<string, unknown>} properties - the parameter schemas.
 * @param {string[]} required - the required parameter names.
 * @returns {object} a tool descriptor the projection accepts.
 */
function rawTool(name, properties, required) {
  return {
    name,
    description: `${name}: upstream description, replaced by the projection.`,
    inputSchema: { type: 'object', properties, required },
  }
}

const RAW_TOOLS = {
  glob: rawTool('glob', {
    pattern: { type: 'array', items: { type: 'string' } },
    path: { type: 'string', description: 'Upstream path text.' },
  }, ['pattern']),
  grep: rawTool('grep', {
    pattern: { type: 'string' },
    path: { type: 'string', description: 'Upstream path text.' },
    output_mode: { type: 'string', enum: ['content'] },
  }, ['pattern']),
  replace: rawTool('replace', {
    pattern: { type: 'string' },
    replacement: { type: 'string' },
    path: { type: 'string', description: 'Upstream path text.' },
  }, ['pattern', 'replacement', 'path']),
  run_background: rawTool('run_background', {
    command: { type: 'string' },
    cwd: { type: 'string', description: 'Upstream cwd text.' },
  }, ['command']),
}

/**
 * The description the model reads for one field of one projected tool.
 * @param {string} rawName - the runtime tool name.
 * @param {string} field - the parameter name.
 * @returns {string} the projected description.
 */
function projectedField(rawName, field) {
  const projected = projectTool(RAW_TOOLS[rawName])
  const description = projected.inputSchema.properties[field].description
  assert.equal(typeof description, 'string', `${rawName}.${field} must stay a described parameter`)
  return description
}

for (const rawName of PATH_TOOLS) {
  await test(`${publicToolName(rawName)}: the path description drops the undefined "connection directory"`, () => {
    const description = projectedField(rawName, 'path')
    assert.ok(
      !description.includes('connection directory'),
      `expected no "connection directory", got: ${description}`,
    )
  })
}

await test('the path description names the calling session and the process fallback', () => {
  for (const rawName of PATH_TOOLS) {
    const description = projectedField(rawName, 'path')
    assert.ok(description.includes('calling session'), `${rawName}: expected "calling session", got: ${description}`)
    assert.ok(description.includes('fileToolRoot'), `${rawName}: expected the "fileToolRoot" caveat, got: ${description}`)
    assert.ok(description.includes('"process"'), `${rawName}: expected the "process" value, got: ${description}`)
  }
})

await test('the three path descriptions stay byte-identical, because FIELDS.path is keyed by field name', () => {
  const [glob, grep, replace] = PATH_TOOLS.map(rawName => projectedField(rawName, 'path'))
  assert.equal(grep, glob, 'ops_grep must share ops_glob\'s path text')
  assert.equal(replace, glob, 'ops_replace must share ops_glob\'s path text — its path is required, so the text must read as true with the "omit" clause inapplicable')
})

await test('ops_run_background: the cwd description no longer claims it is not the calling session', () => {
  const description = projectedField('run_background', 'cwd')
  assert.ok(
    !description.includes('connection directory'),
    `expected no "connection directory", got: ${description}`,
  )
  assert.ok(
    !/not the calling session/.test(description),
    `expected no "not the calling session" claim, got: ${description}`,
  )
  assert.ok(description.includes('calling session'), `expected "calling session", got: ${description}`)
})

await test('the projection still runs without config and rewrites only the fields it knows', () => {
  const projected = projectTool(rawTool('some_future_tool', {
    mode: { type: 'string', description: '  Upstream\n  mode   text. ' },
  }, ['mode']))
  // The raw name survives, because `toolDefinition` is what applies the prefix;
  // a projection that renamed tools would move the freeze into the wrong layer.
  assert.equal(projected.name, 'some_future_tool', 'the projection must not rename a tool')
  assert.equal(
    projected.description,
    'some_future_tool: upstream description, replaced by the projection.',
    'an unlisted tool keeps its upstream description',
  )
  assert.equal(
    projected.inputSchema.properties.mode.description,
    'Upstream mode text.',
    'an unlisted field keeps its upstream description, whitespace-collapsed',
  )
})

report('presentation')
