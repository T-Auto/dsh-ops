#!/usr/bin/env node
/**
 * Keeps `presets/ops-ptc.patch.yml` in step with the official PTC agent preset
 * shipped by `@deepseek-ai/dsh-web-app`.
 *
 * WHY GENERATED. dsh-ops only enhances presets the host already declares, so
 * the `ops-ptc` row is a patch fragment of its own. A hand copy would duplicate
 * ~130 lines of upstream policy (the whole plugin list) and start rotting the
 * first time the host changes its PTC preset. Upstream stays the source of
 * truth: this script regenerates the fragment and `--check` fails on drift.
 *
 * WHY TEXT REPLACEMENT. The preset carries `!!js` tags such as
 * `!!js process.platform === 'win32'`. A YAML round trip would reflow them,
 * drop comments, or lose the expression form, so the generator edits the
 * upstream text at anchored lines, asserts each edit applied exactly once, and
 * only parses the result to verify it.
 *
 * WHAT CHANGES. The row id becomes `preset-ops-ptc`; the preset config's
 * `id`, `name`, `description` and `order` become `ops-ptc`, `OPS (PTC)`,
 * a one-sentence description and `6` (official rows use 1-4 and PTC uses 2, so
 * order 6 sorts OPS last). Everything else, `config.plugins` included, stays
 * byte for byte upstream.
 *
 * SOURCE RESOLUTION. In order: `--source`, `DSH_WEB_APP_PRESETS`, package
 * resolution of `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`, an upward
 * `node_modules` walk, and finally the installed `@deepseek-ai/dsh` itself
 * (the `dsh` executable on PATH or a global npm root), because a checkout does
 * not depend on the web-app bundle and usually only has the host installed
 * globally. An unresolvable source is a failure, never a quiet pass:
 * `--check` without the upstream preset would otherwise verify nothing.
 *
 * USAGE.
 *   node scripts/sync-preset-ops-ptc.mjs              # regenerate the fragment
 *   node scripts/sync-preset-ops-ptc.mjs --check      # verify; exit 1 on drift
 *   node scripts/sync-preset-ops-ptc.mjs --stdout     # print it, write nothing
 *   node scripts/sync-preset-ops-ptc.mjs --source <file-or-directory> [--out <file>]
 *
 * Exit codes: 0 when up to date or written, 1 for drift or an unusable source,
 * 2 for a usage error.
 *
 * @module dsh-ops/scripts/sync-preset-ops-ptc
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'

/** Repository root, so the script works from any current directory. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Bundle that owns the official agent presets, and the preset inside it. */
const SOURCE_PACKAGE = '@deepseek-ai/dsh-web-app'
const SOURCE_FILE = 'presets/ptc.patch.yml'
const SOURCE_SPECIFIER = SOURCE_PACKAGE + '/' + SOURCE_FILE

/** Harness package the official preset is installed beside. */
const HOST_PACKAGE = '@deepseek-ai/dsh'

/** Repository-relative and absolute paths of the fragment this script owns. */
export const FRAGMENT_PATH = 'presets/ops-ptc.patch.yml'
export const DEFAULT_OUT = path.join(ROOT, FRAGMENT_PATH)

/** Identity the fragment publishes. Order 6 sorts after the official rows. */
export const ROW_ID = 'preset-ops-ptc'
export const PRESET_ID = 'ops-ptc'
export const PRESET_NAME = 'OPS (PTC)'
export const PRESET_DESCRIPTION = 'Code-driven PTC tools, extended by the dsh-ops ops_* tool surface.'
export const PRESET_ORDER = 6

/** Plugin the declaration row instantiates. */
const ROW_PLUGIN = '@deepseek-ai/dsh-agent-preset'

/** Log prefix shared by every message, so CI output names its origin. */
const PREFIX = 'sync-preset-ops-ptc: '

/** Exit code for a malformed command line. */
const EXIT_USAGE = 2

/** Yaml tag reader that preserves `!!js` scalars instead of failing on them. */
const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => ({ js: String(value) }),
}

const USAGE = [
  'usage: node scripts/sync-preset-ops-ptc.mjs [options]',
  '',
  '  (no option)          regenerate ' + FRAGMENT_PATH,
  '  --check              verify the fragment, exit 1 when it drifted',
  '  --stdout             print the generated fragment, write nothing',
  '  --source <path>      upstream ptc.patch.yml, its directory, or a package root',
  '  --out <file>         write or check this file instead of ' + FRAGMENT_PATH,
  '  --quiet              only report failures',
  '  --help               print this message',
].join('\n')

/** A failure with the exit code it should produce. */
class SyncError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'SyncError'
    this.exitCode = exitCode
  }
}

const require = createRequire(import.meta.url)

/** Classify a path without throwing when it is absent. */
function statKind(entry) {
  try {
    const stats = fs.statSync(entry)
    return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : undefined
  } catch {
    return undefined
  }
}

/** Resolve symlinks, or return undefined when the path is absent. */
function physicalPath(entry) {
  try {
    return fs.realpathSync(entry)
  } catch {
    return undefined
  }
}

/** Render a path for logs: repository-relative when inside the checkout. */
function displayPath(entry) {
  const relative = path.relative(ROOT, entry)
  return relative === '' || relative.startsWith('..') ? entry : relative.split(path.sep).join('/')
}

/** Find the official preset in a file, preset directory, bundle root, or install root. */
function fragmentIn(candidate) {
  const kind = statKind(candidate)
  if (kind === 'file') return physicalPath(candidate)
  if (kind !== 'directory') return undefined
  const probes = [
    path.join(candidate, 'ptc.patch.yml'),
    path.join(candidate, SOURCE_FILE),
    path.join(candidate, 'node_modules', SOURCE_PACKAGE, SOURCE_FILE),
  ]
  for (const probe of probes) {
    if (statKind(probe) === 'file') return physicalPath(probe)
  }
  return undefined
}

/** Ask package resolution for the bundle; fall back to its manifest subpath. */
function requireResolvedCandidate() {
  const bases = { paths: [process.cwd(), ROOT] }
  try {
    return require.resolve(SOURCE_SPECIFIER, bases)
  } catch {
    // Older bundles may not export the preset subpath; the manifest still resolves.
  }
  try {
    return path.join(path.dirname(require.resolve(SOURCE_PACKAGE + '/package.json', bases)), SOURCE_FILE)
  } catch {
    return undefined
  }
}

/** Probe `node_modules` upward from the checkout and the current directory. */
function upwardCandidates() {
  const probes = []
  for (const base of [ROOT, process.cwd()]) {
    let directory = path.resolve(base)
    while (true) {
      probes.push({
        candidate: path.join(directory, 'node_modules', SOURCE_PACKAGE, SOURCE_FILE),
        via: 'node_modules walk from ' + displayPath(directory),
      })
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return probes
}

/** Package root of an installed harness, from any file inside it. */
function hostRootOf(file) {
  let directory = path.dirname(file)
  while (true) {
    const manifest = path.join(directory, 'package.json')
    if (statKind(manifest) === 'file') {
      try {
        if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name === HOST_PACKAGE) return directory
      } catch {
        // An unreadable manifest is not this file's harness; keep walking.
      }
    }
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Global npm `node_modules` directories that could hold the harness. */
function globalModuleRoots() {
  const binaries = path.dirname(process.execPath)
  const candidates = [
    path.resolve(binaries, '..', 'lib', 'node_modules'),
    path.resolve(binaries, '..', 'node_modules'),
    path.resolve(binaries, 'node_modules'),
  ]
  if (process.env.NPM_CONFIG_PREFIX) candidates.push(path.join(process.env.NPM_CONFIG_PREFIX, 'lib', 'node_modules'))
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules'))
    candidates.push(path.join(process.env.HOME, '.local', 'lib', 'node_modules'))
  }
  candidates.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  const roots = []
  const seen = new Set()
  for (const candidate of candidates) {
    const physical = physicalPath(candidate)
    if (physical === undefined || seen.has(physical)) continue
    seen.add(physical)
    if (statKind(physical) === 'directory') roots.push(physical)
  }
  return roots
}

/**
 * Installed harness roots: the resolvable package, the `dsh` executable on
 * PATH, and global npm trees. This fallback is what makes `--check` work on a
 * machine where only the host is installed globally.
 */
function hostRoots() {
  const roots = []
  const seen = new Set()
  const push = (root, via) => {
    if (root === undefined) return
    const physical = physicalPath(root)
    if (physical === undefined || seen.has(physical)) return
    seen.add(physical)
    roots.push({ root: physical, via })
  }
  try {
    const manifest = require.resolve(HOST_PACKAGE + '/package.json', { paths: [process.cwd(), ROOT] })
    push(path.dirname(manifest), 'resolved ' + HOST_PACKAGE)
  } catch {
    // The harness is a peer, not an installed dependency of this checkout.
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue
    for (const name of ['dsh', 'dsh.cmd', 'dsh.exe']) {
      const link = path.join(directory, name)
      if (statKind(link) !== 'file') continue
      const physical = physicalPath(link)
      if (physical !== undefined) {
        const root = hostRootOf(physical)
        if (root !== undefined) push(root, 'dsh executable ' + link)
      }
      break
    }
  }
  for (const modules of globalModuleRoots()) push(path.join(modules, HOST_PACKAGE), 'global node_modules ' + modules)
  return roots
}

/** Render failed probes for an error message, deduplicated and capped. */
function formatAttempts(attempts) {
  const lines = []
  const seen = new Set()
  for (const { candidate, via } of attempts) {
    const key = via + '\0' + candidate
    if (seen.has(key)) continue
    seen.add(key)
    lines.push('  - ' + via + ': ' + candidate)
  }
  if (lines.length > 40) lines.splice(40, lines.length - 40, '  ... and more; use --source to bypass discovery')
  return lines.join('\n')
}

/**
 * Resolve the upstream preset, recording every probe so a failure names each
 * place that was tried.
 * @param {{source?: string}} [options] - the `--source` override, if any.
 * @returns {{file: string, via: string, attempts: Array<{candidate: string, via: string}>}}
 * @throws {SyncError} when no candidate is readable.
 */
export function resolveSource(options = {}) {
  const attempts = []
  const consider = (candidate, via) => {
    const file = candidate === undefined ? undefined : fragmentIn(candidate)
    if (file === undefined) {
      attempts.push({ candidate: candidate ?? '<none>', via })
      return undefined
    }
    return { file, via }
  }

  if (options.source !== undefined) {
    const found = consider(options.source, '--source')
    if (found === undefined) {
      throw new SyncError('--source does not point at a readable PTC preset:\n  ' + options.source + '\n' + USAGE)
    }
    return { ...found, attempts }
  }

  const fromEnvironment = process.env.DSH_WEB_APP_PRESETS
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    const found = consider(fromEnvironment, 'DSH_WEB_APP_PRESETS')
    if (found === undefined) {
      throw new SyncError('DSH_WEB_APP_PRESETS does not point at a readable PTC preset:\n  ' + fromEnvironment)
    }
    return { ...found, attempts }
  }

  const resolved = requireResolvedCandidate()
  if (resolved === undefined) {
    attempts.push({ candidate: SOURCE_SPECIFIER, via: 'require.resolve' })
  } else {
    const found = consider(resolved, 'require.resolve')
    if (found !== undefined) return { ...found, attempts }
  }

  for (const probe of upwardCandidates()) {
    const found = consider(probe.candidate, probe.via)
    if (found !== undefined) return { ...found, attempts }
  }

  for (const { root, via } of hostRoots()) {
    const probes = [
      path.join(root, 'node_modules', SOURCE_PACKAGE, SOURCE_FILE),
      path.resolve(root, '..', 'dsh-web-app', SOURCE_FILE),
    ]
    for (const candidate of probes) {
      const found = consider(candidate, via)
      if (found !== undefined) return { ...found, attempts }
    }
  }

  for (const modules of globalModuleRoots()) {
    const found = consider(path.join(modules, SOURCE_PACKAGE, SOURCE_FILE), 'global node_modules ' + modules)
    if (found !== undefined) return { ...found, attempts }
  }

  throw new SyncError(
    'cannot locate ' + SOURCE_SPECIFIER + ' in any installed package.\n'
    + 'Tried:\n' + formatAttempts(attempts) + '\n'
    + 'Install the host bundle, or name the preset explicitly:\n'
    + '  --source <path-to-ptc.patch.yml>   or   DSH_WEB_APP_PRESETS=<path>',
  )
}

/** SHA-256 of the upstream bytes; recorded in the fragment header. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Drop the upstream comment block, keeping the patch body untouched. */
function stripUpstreamHeader(sourceText) {
  const lines = sourceText.split('\n')
  let cursor = 0
  while (cursor < lines.length && /^\s*#/.test(lines[cursor])) cursor += 1
  if (cursor < lines.length && lines[cursor].trim() === '') cursor += 1
  return lines.slice(cursor).join('\n')
}

/** Fragment header: provenance, source checksum, and the do-not-edit warning. */
function buildHeader(digest) {
  const lines = [
    '# Generated file: do not edit by hand. Regenerate it from the installed',
    '# host bundle with:',
    '#   node scripts/sync-preset-ops-ptc.mjs',
    '#',
    '# Source: ' + SOURCE_PACKAGE + '/' + SOURCE_FILE,
    '# Source sha256: ' + digest,
    '#',
    '# The patch below is the upstream preset byte for byte, except that the row',
    '# id, preset id, name, description and order are the ops-ptc identity.',
  ]
  return lines.join('\n') + '\n\n'
}

/**
 * Replace an anchored line, requiring exactly one match so an upstream layout
 * change fails loudly instead of producing a wrong fragment.
 * @returns {string} the edited body.
 * @throws {SyncError} when the pattern does not match exactly once.
 */
function replaceExactly(text, pattern, replacement, label) {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  const count = text.match(new RegExp(pattern.source, flags))?.length ?? 0
  if (count !== 1) {
    throw new SyncError(
      'the upstream preset does not contain exactly one ' + label + ' line (found ' + count + ');\n'
      + 'upstream layout changed. Update the anchored patterns in this script before regenerating.',
    )
  }
  return text.replace(pattern, (match, indent) => replacement(indent))
}

/**
 * Parse a preset patch, preserving `!!js` expressions as `{ js }` marker
 * objects so the generator can prove it left them alone.
 * @returns {{document: Array<object>, row: Record<string, any>}} parsed document and row.
 * @throws {SyncError} when the document is not a one-row preset patch.
 */
export function parsePreset(text) {
  let document
  try {
    document = parse(text, { customTags: [JS_TAG] })
  } catch (error) {
    throw new SyncError('cannot parse preset YAML: ' + error.message)
  }
  if (!Array.isArray(document) || document.length !== 1) {
    throw new SyncError('preset YAML must be a patch document with exactly one entry')
  }
  const insert = document[0]?.insert
  if (!Array.isArray(insert) || insert.length !== 1) {
    throw new SyncError('preset patch must insert exactly one declaration row')
  }
  return { document, row: insert[0] }
}

/** Assert one generated fact with a message that names the defect. */
function expect(condition, message) {
  if (!condition) throw new SyncError('generated fragment self-check failed: ' + message)
}

/**
 * Self-check a fragment: parse it and confirm the preset identity and plugin
 * list are exactly what the generator advertises.
 * @returns {{document: Array<object>, pluginCount: number}} parsed document and row count.
 * @throws {SyncError} when a fact about the fragment is wrong.
 */
export function inspectFragment(text) {
  const { document, row } = parsePreset(text)
  expect(row.id === ROW_ID, 'row id is ' + JSON.stringify(row.id) + ', expected ' + ROW_ID)
  expect(row.name === ROW_PLUGIN, 'row plugin is ' + JSON.stringify(row.name) + ', expected ' + ROW_PLUGIN)
  const config = row.config
  expect(config !== undefined && typeof config === 'object', 'declaration has no config object')
  expect(config.id === PRESET_ID, 'preset id is ' + JSON.stringify(config.id) + ', expected ' + PRESET_ID)
  expect(config.name === PRESET_NAME, 'preset name is ' + JSON.stringify(config.name) + ', expected ' + PRESET_NAME)
  expect(config.description === PRESET_DESCRIPTION, 'preset description does not match this script')
  expect(config.order === PRESET_ORDER, 'preset order is ' + JSON.stringify(config.order) + ', expected ' + PRESET_ORDER)
  expect(Array.isArray(config.plugins) && config.plugins.length > 0, 'preset declares no plugin rows')
  return { document, pluginCount: config.plugins.length }
}

/** A declaration row without the preset identity, for upstream comparison. */
function withoutIdentity(row) {
  const clone = structuredClone(row)
  delete clone.id
  if (clone.config !== undefined && typeof clone.config === 'object') {
    delete clone.config.id
    delete clone.config.name
    delete clone.config.description
    delete clone.config.order
  }
  return clone
}

/**
 * Generate the fragment from the upstream preset bytes.
 * @param {string} sourceText - contents of the official ptc.patch.yml.
 * @returns {{text: string, info: {sha: string, pluginCount: number}}} the fragment
 *   and the facts its header and log lines report.
 * @throws {SyncError} when the upstream layout is not the one this transform knows.
 */
export function generateFragment(sourceText) {
  const digest = sha256(sourceText)
  const upstream = parsePreset(sourceText)
  if (upstream.row.config.name !== undefined || upstream.row.config.description !== undefined) {
    throw new SyncError(
      'the upstream preset now declares config.name/config.description;\n'
      + 'this script would duplicate those keys. Update the transform before regenerating.',
    )
  }

  let body = stripUpstreamHeader(sourceText)
  body = replaceExactly(
    body,
    /^([ \t]*)- id: preset-ptc$/m,
    (indent) => indent + '- id: ' + ROW_ID,
    'declaration id',
  )
  body = replaceExactly(
    body,
    /^([ \t]*)id: ptc$/m,
    (indent) => indent + 'id: ' + PRESET_ID
      + '\n' + indent + 'name: \'' + PRESET_NAME + '\''
      + '\n' + indent + 'description: ' + PRESET_DESCRIPTION,
    'preset config id',
  )
  body = replaceExactly(
    body,
    /^([ \t]*)order: 2$/m,
    (indent) => indent + 'order: ' + PRESET_ORDER,
    'preset order',
  )

  const text = buildHeader(digest) + body
  const generated = inspectFragment(text)
  const upstreamExpressions = (sourceText.match(/!!js\s/g) ?? []).length
  const generatedExpressions = (text.match(/!!js\s/g) ?? []).length
  if (upstreamExpressions !== generatedExpressions) {
    throw new SyncError(
      'generated fragment lost !!js expressions: upstream has ' + upstreamExpressions
      + ', generated has ' + generatedExpressions + '. Refusing to write it.',
    )
  }
  if (!isDeepStrictEqual(withoutIdentity(upstream.row), withoutIdentity(parsePreset(text).row))) {
    throw new SyncError(
      'generated fragment changed more than the preset identity;\n'
      + 'the patched body diverged from upstream. Refusing to write it.',
    )
  }
  return { text, info: { sha: digest, pluginCount: generated.pluginCount } }
}

/** Read a file, or return undefined when it does not exist. */
function readIfExists(file) {
  return statKind(file) === 'file' ? fs.readFileSync(file, 'utf8') : undefined
}

/** Locate the first differing line between two documents. */
function firstDifference(actual, expected) {
  const actualLines = actual.split('\n')
  const expectedLines = expected.split('\n')
  const limit = Math.max(actualLines.length, expectedLines.length)
  for (let index = 0; index < limit; index += 1) {
    if (actualLines[index] === expectedLines[index]) continue
    return {
      line: index + 1,
      actual: actualLines[index] ?? '<end of file>',
      expected: expectedLines[index] ?? '<end of file>',
    }
  }
  return undefined
}

/** Write the fragment, unless the file already matches. */
function writeFragment(task) {
  if (readIfExists(task.outFile) === task.expected) return false
  fs.mkdirSync(path.dirname(task.outFile), { recursive: true })
  fs.writeFileSync(task.outFile, task.expected)
  return true
}

/**
 * Compare the committed fragment with a fresh generation, explaining the drift.
 * @param {{outFile: string, expected: string, info: {sha: string, pluginCount: number}, report: object}} task
 * @returns {number} 0 when up to date, 1 when the fragment is missing or stale.
 */
function checkFragment(task) {
  const label = displayPath(task.outFile)
  const current = readIfExists(task.outFile)
  if (current === undefined) {
    task.report.error(PREFIX + 'fragment missing: ' + label + '\n  run: node scripts/sync-preset-ops-ptc.mjs')
    return 1
  }
  if (current === task.expected) {
    task.report.info(PREFIX + 'up to date: ' + label + ' (' + task.info.pluginCount + ' plugin rows, source sha256 ' + task.info.sha + ')')
    return 0
  }
  task.report.error(PREFIX + 'fragment is out of date: ' + label)
  const recorded = /^# Source sha256: ([0-9a-f]{64})$/m.exec(current)?.[1]
  if (recorded === undefined) {
    task.report.error('  the fragment records no source sha256, so it predates the generator')
  } else if (recorded !== task.info.sha) {
    task.report.error('  upstream changed: recorded source sha256 ' + recorded + ', current ' + task.info.sha)
  } else {
    task.report.error('  the source sha256 still matches, so the fragment was edited by hand; the generator owns it')
  }
  // Ignore the checksum line when showing the body drift: it is a consequence,
  // not the change a maintainer needs to see.
  const comparable = recorded === undefined ? task.expected : task.expected.replace(task.info.sha, recorded)
  const drift = firstDifference(current, comparable)
  if (drift !== undefined) {
    task.report.error('  first difference at line ' + drift.line + ':')
    task.report.error('    file:     ' + JSON.stringify(drift.actual))
    task.report.error('    expected: ' + JSON.stringify(drift.expected))
  }
  task.report.error('  run: node scripts/sync-preset-ops-ptc.mjs')
  return 1
}

/** Route normal output away from `--stdout` payloads and honour `--quiet`. */
function makeReporter(options) {
  const stream = options.stdout ? process.stderr : process.stdout
  return {
    info: (message) => {
      if (!options.quiet) stream.write(message + '\n')
    },
    error: (message) => {
      process.stderr.write(message + '\n')
    },
  }
}

/**
 * Parse the command line. Unknown options are usage errors: a typo that
 * silently changed what was checked would be worse than a failed run.
 * @throws {SyncError} on an unknown option, a missing value, or incompatible flags.
 */
export function parseOptions(argv) {
  const options = { check: false, stdout: false, quiet: false, help: false, source: undefined, out: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const separator = argument.startsWith('--') ? argument.indexOf('=') : -1
    const name = separator === -1 ? argument : argument.slice(0, separator)
    const inline = separator === -1 ? undefined : argument.slice(separator + 1)
    const takeValue = () => {
      if (inline !== undefined) return inline
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new SyncError(name + ' needs a value\n' + USAGE, EXIT_USAGE)
      }
      index += 1
      return next
    }
    switch (name) {
      case '--check': options.check = true; break
      case '--stdout': options.stdout = true; break
      case '--quiet': options.quiet = true; break
      case '--help':
      case '-h': options.help = true; break
      case '--source': options.source = takeValue(); break
      case '--out': options.out = takeValue(); break
      default:
        if (name.startsWith('-')) throw new SyncError('unknown option: ' + name + '\n' + USAGE, EXIT_USAGE)
        if (options.source !== undefined) throw new SyncError('source given twice: ' + argument + '\n' + USAGE, EXIT_USAGE)
        options.source = argument
    }
  }
  if (options.stdout && options.check) {
    throw new SyncError('--check and --stdout are exclusive\n' + USAGE, EXIT_USAGE)
  }
  if (options.stdout && options.out !== undefined) {
    throw new SyncError('--stdout and --out are exclusive\n' + USAGE, EXIT_USAGE)
  }
  return options
}

/**
 * Run the generator or the check.
 * @param {string[]} [argv] - arguments after the script name.
 * @returns {number} the process exit code.
 * @throws {SyncError} for drift, an unusable source, or a usage error.
 */
export function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  if (options.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  const report = makeReporter(options)
  const source = resolveSource(options)
  const sourceText = fs.readFileSync(source.file, 'utf8')
  const { text, info } = generateFragment(sourceText)
  const outFile = options.out === undefined ? DEFAULT_OUT : path.resolve(options.out)

  if (options.stdout) {
    process.stdout.write(text)
    return 0
  }

  report.info(PREFIX + 'source: ' + source.file + ' (' + source.via + ')')
  if (options.check) return checkFragment({ outFile, expected: text, info, report })

  const existed = statKind(outFile) === 'file'
  const wrote = writeFragment({ outFile, expected: text })
  const verb = !wrote ? 'unchanged' : existed ? 'updated' : 'created'
  report.info(PREFIX + verb + ': ' + displayPath(outFile) + ' (' + info.pluginCount + ' plugin rows, source sha256 ' + info.sha + ')')
  return 0
}

/** Whether this module is the process entry point rather than an import. */
function invokedDirectly() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const script = physicalPath(fileURLToPath(import.meta.url))
  const launched = physicalPath(entry) ?? physicalPath(path.resolve(entry))
  if (script === undefined || launched === undefined) return false
  return script === launched
}

if (invokedDirectly()) {
  try {
    process.exitCode = main()
  } catch (error) {
    if (error instanceof SyncError) {
      process.stderr.write(PREFIX + error.message + '\n')
      process.exitCode = error.exitCode
    } else {
      throw error
    }
  }
}
