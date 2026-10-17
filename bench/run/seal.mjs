/**
 * Seal one finished sweep directory into a single `run.json`.
 *
 * The runner writes four files per row while a sweep is in flight — the event stream,
 * the captured stderr, the narrated trace and the row's metrics document — so a crash
 * keeps what already happened. Nothing reads those files afterwards: this module folds
 * them into the one document `bench/run.schema.json` describes.
 *
 * The merge is deliberately asymmetric, because the two halves were already decided by
 * other slices:
 *
 * - event bodies ARE inlined (`results[].events.inline`) and the top-level `events`
 *   block records the layout, the merge time and every source file's hash and line
 *   count — a reader can prove the merge from the archive;
 * - the trace file is NOT inlined: it is registered in `archive[]` with role `trace`
 *   and summarized by `metrics.traceRows` / `metrics.milestones` / `metrics.narration`
 *   (P5's bounded milestone summary);
 * - the P6 aggregate (`lib/aggregate.mjs`) is re-run over the same event lines and its
 *   fields — `usageBucketsSeen`, `stepUsage`, `toolUsage`, `unattributedUsage`,
 *   `attribution`, the prompt shape — become part of `results[].metrics`, so the sealed
 *   document carries the numbers the comparison and the panel actually read.
 *
 * Sealing is deterministic: every value is derived from the input files, the only clock
 * is `events.mergedAt` (and `meta.startedAt`/`meta.endedAt` fall back to `now` only when
 * there are no rows), and the output is ordered — so sealing the same directory twice
 * produces byte-identical bytes. An unchanged `run.json` is left untouched.
 *
 * Before anything is written the document is checked against the schema with the small
 * validator in this file: no runtime dependency is added, and both a missing field and
 * an unexpected one are errors (so a typo can never ship as evidence).
 *
 * @module dsh-ops/bench/run/seal
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { aggregateLines } from '../lib/aggregate.mjs'
import { REPO_ROOT, platformTag } from '../lib/env.mjs'

/** The four per-row archive files the session driver writes, by suffix. */
export const ROW_SUFFIXES = {
  events: '.events.ndjson',
  stderr: '.stderr.log',
  trace: '.trace.ndjson',
  metrics: '.metrics.json',
}

/** The archive role each per-row file gets in `archive[]`. */
const ROLE_BY_SUFFIX = new Map([
  [ROW_SUFFIXES.events, 'events'],
  [ROW_SUFFIXES.stderr, 'stderr'],
  [ROW_SUFFIXES.trace, 'trace'],
  [ROW_SUFFIXES.metrics, 'metrics'],
])

/** The four exclusive buckets `grandTotal` is made of. */
const CORE_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** The optional bucket: present only when the provider reported it. */
const OPTIONAL_BUCKETS = ['reasoningTokens']

/** How many milestone rows the bounded `metrics.narration` summary quotes. */
const NARRATION_EXCERPT_CAP = 20

/** The contract file, resolved from this module's own location. */
const SCHEMA_PATH = path.join(REPO_ROOT, 'bench', 'run.schema.json')

/** Raised when a sweep directory cannot be sealed, or the sealed document breaks the contract. */
export class SealError extends Error {
  /**
   * @param {string} message - what failed.
   * @param {{path: string, message: string}[]} [errors] - schema violations, when any.
   */
  constructor(message, errors = []) {
    super(errors.length === 0 ? message : `${message}: ${errors.map((error) => `${error.path} ${error.message}`).join('; ')}`)
    this.name = 'SealError'
    this.errors = errors
  }
}

/**
 * Read the `run.json` contract.
 * @param {string} [file] - the schema path; defaults to the checkout's own.
 * @returns {object} the parsed schema.
 */
export function loadSchema(file = SCHEMA_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Check a document against the schema with the lightweight validator below.
 *
 * Deliberately partial: `$ref`, `type`, `const`, `enum`, `minimum`, `required`,
 * `properties`, `items`, `additionalProperties` (false or a schema) and
 * `anyOf`/`oneOf`. `format` is documentation here; the contract's real teeth are
 * "every required field is there" and "no field is not in the schema".
 * @param {object} document - the sealed document.
 * @param {object} [schema] - the contract; defaults to `bench/run.schema.json`.
 * @returns {{ok: boolean, errors: {path: string, message: string}[]}} the verdict.
 */
export function validateRun(document, schema = loadSchema()) {
  const errors = []
  visit(schema, document, 'run.json', errors, schema)
  errors.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { ok: errors.length === 0, errors }
}

/**
 * Fold one schema node over one value.
 * @param {object} node - the schema node.
 * @param {unknown} value - the value to check.
 * @param {string} at - the JSON path of the value, for the error message.
 * @param {{path: string, message: string}[]} errors - the sink.
 * @param {object} root - the schema root, for `$ref` resolution.
 * @returns {void}
 */
function visit(node, value, at, errors, root) {
  if (!isObject(node)) return
  if (typeof node.$ref === 'string') {
    const target = resolveRef(root, node.$ref)
    if (target === null) {
      errors.push({ path: at, message: `schema $ref cannot be resolved: ${node.$ref}` })
      return
    }
    visit(target, value, at, errors, root)
    return
  }
  const alternatives = node.anyOf ?? node.oneOf
  if (Array.isArray(alternatives)) {
    const matched = alternatives.some((branch) => {
      const inner = []
      visit(branch, value, at, inner, root)
      return inner.length === 0
    })
    if (!matched) errors.push({ path: at, message: `does not match any of the ${alternatives.length} allowed shapes` })
    return
  }
  if (Array.isArray(node.enum) && !node.enum.some((allowed) => sameValue(allowed, value))) {
    errors.push({ path: at, message: `must be one of ${node.enum.map((entry) => JSON.stringify(entry)).join(', ')} (got ${JSON.stringify(value)})` })
  }
  if (Object.hasOwn(node, 'const') && !sameValue(node.const, value)) {
    errors.push({ path: at, message: `must equal ${JSON.stringify(node.const)} (got ${JSON.stringify(value)})` })
  }
  if (node.type !== undefined && !matchesType(node.type, value)) {
    errors.push({ path: at, message: `must be ${typeList(node.type)} (got ${describeValue(value)})` })
    return
  }
  if (typeof value === 'number' && typeof node.minimum === 'number' && value < node.minimum) {
    errors.push({ path: at, message: `must be >= ${node.minimum} (got ${value})` })
  }
  if (Array.isArray(value) && node.items !== undefined) {
    value.forEach((entry, index) => visit(node.items, entry, `${at}[${index}]`, errors, root))
  }
  if (!isObject(value)) return
  const properties = isObject(node.properties) ? node.properties : {}
  for (const key of node.required ?? []) {
    if (!Object.hasOwn(value, key)) errors.push({ path: `${at}.${key}`, message: 'missing required field' })
  }
  if (node.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) errors.push({ path: `${at}.${key}`, message: 'field is not in the schema' })
    }
  } else if (isObject(node.additionalProperties)) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) visit(node.additionalProperties, value[key], `${at}.${key}`, errors, root)
    }
  }
  for (const [key, child] of Object.entries(properties)) {
    if (Object.hasOwn(value, key)) visit(child, value[key], `${at}.${key}`, errors, root)
  }
}

/** Resolve `#/a/b/c` inside `root`, or null. */
function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) return null
  let node = root
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isObject(node) || !Object.hasOwn(node, key)) return null
    node = node[key]
  }
  return isObject(node) ? node : null
}

/** Does `value` match any of the JSON types a schema names? */
function matchesType(spec, value) {
  const types = Array.isArray(spec) ? spec : [spec]
  return types.some((type) => {
    switch (type) {
      case 'object': return isObject(value)
      case 'array': return Array.isArray(value)
      case 'string': return typeof value === 'string'
      case 'integer': return Number.isInteger(value)
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'boolean': return typeof value === 'boolean'
      case 'null': return value === null
      default: return true
    }
  })
}

/** A JSON value's type, for an error message. */
function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

/** The type list of a schema's `type`, for an error message. */
function typeList(spec) {
  return (Array.isArray(spec) ? spec : [spec]).join(' or ')
}

/** Are two JSON values equal, for `const`/`enum`? */
function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Is this a plain JSON object (not null, not an array)? */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Freeze bucket totals into the contract's usage shape: the four core buckets and
 * `grandTotal` are always there, an optional bucket only when it was reported.
 *
 * This is also the migration point for a document written under the old reading —
 * one whose `usage` always carried `reasoningTokens` and never carried `grandTotal`:
 * it is normalized rather than refused, because the missing total is recomputable and
 * the reasoning count is still evidence.
 * @param {unknown} usage - a provider or recorded usage object.
 * @returns {object} the normalized usage object.
 */
export function normalizeUsage(usage) {
  const source = isObject(usage) ? usage : {}
  const out = {}
  for (const bucket of [...CORE_BUCKETS, ...OPTIONAL_BUCKETS]) {
    if (Number.isInteger(source[bucket]) && source[bucket] >= 0) out[bucket] = source[bucket]
  }
  for (const bucket of CORE_BUCKETS) {
    if (!Object.hasOwn(out, bucket)) out[bucket] = 0
  }
  out.grandTotal = Number.isInteger(source.grandTotal) && source.grandTotal >= 0
    ? source.grandTotal
    : CORE_BUCKETS.reduce((sum, bucket) => sum + out[bucket], 0)
  return out
}

/**
 * Seal one sweep directory.
 *
 * Required: `dir` (the sweep's output folder, holding `results/`) and `arms`
 * (`{base, cand}`, each at least `label`/`profile`/`profileHash`).
 * Optional: `meta` (provenance overrides: `benchVersion`, `mode`, `platform`, `node`,
 * `dsh`, `model`, `gitSha`, `gitBranch`, `argv`, `startedAt`, `endedAt`), `out`
 * (the `run.json` path; defaults to `<dir>/run.json`), `now` (an injectable clock for
 * tests), `schema` (an injectable contract).
 *
 * @param {object} options - as described above.
 * @returns {{path: string, document: object, changed: boolean, validation: {ok: boolean, errors: object[]}}} the receipt.
 * @throws {SealError} when the directory is not a sweep output, a row is unusable, or the document breaks the schema.
 */
export function sealRun(options = {}) {
  // One arm per directory is the scheduler's layout (a row segment does not carry the arm),
  // so sealing a sweep means folding N arm directories into ONE document: each row already
  // names its own arm through `metrics.arm`, which is exactly what `results[].arm` is for.
  const dirs = (options.dirs ?? [options.dir]).map((entry) => path.resolve(requiredString(entry, 'sealRun: options.dirs[]')))
  const arms = normalizeArms(options.arms)
  const sealedAt = new Date(clockOf(options)()).toISOString()
  const results = []
  const archive = []
  const eventFiles = []
  let rowCount = 0
  for (const dir of dirs) {
    const resultsDir = path.join(dir, 'results')
    if (!isDirectory(resultsDir)) throw new SealError(`sealRun: ${dir} has no results/ directory — point it at one sweep's output folder`)
    const metricsNames = fs.readdirSync(resultsDir).filter((name) => name.endsWith(ROW_SUFFIXES.metrics)).sort()
    for (const name of metricsNames) {
      const segment = name.slice(0, -ROW_SUFFIXES.metrics.length)
      const row = sealRow(dir, resultsDir, segment, arms)
      results.push(row.result)
      archive.push(...row.archive)
      if (row.eventFile !== null) eventFiles.push(row.eventFile)
      rowCount += 1
    }
  }
  if (rowCount === 0) throw new SealError(`sealRun: ${dirs.join(', ')} hold no ${ROW_SUFFIXES.metrics} row — nothing to seal`)
  results.sort(compareResults)
  archive.sort(compareByPath)
  eventFiles.sort(compareByPath)

  const document = {
    schemaVersion: 1,
    meta: buildMeta(options, arms, results, sealedAt),
    arms,
    results,
    verify: rollupVerify(results),
    events: { layout: 'merged', merged: true, mergedAt: sealedAt, files: eventFiles },
    archive,
  }
  const validation = validateRun(document, options.schema ?? loadSchema())
  if (!validation.ok) {
    throw new SealError('sealRun: the sealed document does not match bench/run.schema.json', validation.errors)
  }
  // A sweep's arms live in sibling directories, so the sealed document belongs in their
  // parent (the group folder); a single directory keeps sealing in place.
  const base = dirs.length > 1 ? path.dirname(dirs[0]) : dirs[0]
  const file = path.resolve(options.out ?? path.join(base, 'run.json'))
  const changed = writeIfChanged(file, `${JSON.stringify(document, null, 2)}\n`)
  return { path: file, document, changed, validation }
}

/**
 * Seal all four archive files of one row into a `results[]` entry plus its `archive[]`
 * entries. The event body is inlined here; the trace never is.
 * @param {string} dir - the run directory.
 * @param {string} resultsDir - its `results/` subdirectory.
 * @param {string} segment - the row's `<task>-r<n>` stem.
 * @param {{base: object, cand: object}} arms - the normalized arm descriptors.
 * @returns {{result: object, archive: object[], eventFile: object|null}} the row pieces.
 */
function sealRow(dir, resultsDir, segment, arms) {
  const files = {}
  for (const [kind, suffix] of Object.entries(ROW_SUFFIXES)) files[kind] = path.join(resultsDir, `${segment}${suffix}`)
  const metrics = readJson(files.metrics, `row ${segment}`)
  const identity = rowIdentity(segment, metrics)
  const arm = requiredString(metrics.arm, `row ${segment}: metrics.arm (which arm this row belongs to)`)
  const lines = readLines(files.events)
  const traceLines = readLines(files.trace)
  const inline = inlineEvents(lines)
  const aggregate = aggregateLines(lines, {
    label: arm,
    profile: typeof metrics.profile === 'string' ? metrics.profile : null,
    taskId: identity.taskId,
    repeatIndex: identity.repeatIndex,
  })
  const live = aggregate.eventCount > 0 ? aggregate : fallbackAggregate(metrics, arm, identity)
  const narration = buildNarration(traceLines)
  const eventRef = {
    format: 'inline',
    file: isFile(files.events) ? relativePath(dir, files.events) : null,
    count: lines.length,
    malformed: lines.length - inline.length,
    sha256: fileHash(files.events),
    inline,
  }
  const row = {
    taskId: identity.taskId,
    repeatIndex: identity.repeatIndex,
    arm,
    profile: typeof metrics.profile === 'string' ? metrics.profile : null,
    metrics: sealMetrics(metrics, live, narration),
    verify: normalizeChecks(metrics.verify),
    verifyPassed: metrics.verifyPassed === true,
    verifyError: typeof metrics.verifyError === 'string' ? metrics.verifyError : null,
    events: eventRef,
    traceFile: isFile(files.trace) ? relativePath(dir, files.trace) : null,
    stderrFile: isFile(files.stderr) ? relativePath(dir, files.stderr) : null,
    interrupted: metrics.interrupted === true,
    spawnError: textOrNull(metrics.spawnError),
    runnerError: textOrNull(metrics.runnerError),
    timeoutMs: Number.isInteger(metrics.timeoutMs) && metrics.timeoutMs >= 0 ? metrics.timeoutMs : 0,
    archiveErrors: stringList(metrics.archiveErrors),
  }
  const archive = Object.entries(ROW_SUFFIXES)
    .filter(([, suffix]) => isFile(path.join(resultsDir, `${segment}${suffix}`)))
    .map(([, suffix]) => {
      const file = path.join(resultsDir, `${segment}${suffix}`)
      return { path: relativePath(dir, file), bytes: fs.statSync(file).size, sha256: fileHash(file), role: ROLE_BY_SUFFIX.get(suffix) }
    })
  return { result: row, archive, eventFile: isFile(files.events) ? { path: eventRef.file, events: eventRef.count, sha256: eventRef.sha256 } : null }
}

/**
 * The sealed `metrics` block: execution facts from the row document plus the P6
 * aggregate of the same stream, with only the keys the schema names.
 * @param {object} metrics - the row's metrics document.
 * @param {object} live - the aggregate, or the metrics-only fallback.
 * @param {{traceRows: number, milestones: number, narration: object}} narration - the bounded P5 summary.
 * @returns {object} the sealed metrics block.
 */
function sealMetrics(metrics, live, narration) {
  const toolUsage = {}
  for (const [name, entry] of Object.entries(isObject(live.toolUsage) ? live.toolUsage : {})) {
    toolUsage[name] = {
      calls: countOf(entry?.calls),
      steps: countOf(entry?.steps),
      usage: normalizeUsage(entry?.usage),
      usageBucketsSeen: stringList(entry?.usageBucketsSeen),
    }
  }
  const stepUsage = (Array.isArray(live.stepUsage) ? live.stepUsage : []).map((entry) => ({
    turn: Number.isInteger(entry?.turn) ? entry.turn : null,
    step: Number.isInteger(entry?.step) ? entry.step : null,
    promptTokens: Number.isInteger(entry?.promptTokens) ? entry.promptTokens : null,
    usage: entry?.usage === null || entry?.usage === undefined ? null : normalizeUsage(entry.usage),
    tools: stringList(entry?.tools),
  }))
  const attribution = isObject(live.attribution) ? live.attribution : {}
  return {
    startedAt: requiredString(metrics.startedAt, `row ${metrics.taskId ?? '?'} r${metrics.repeatIndex ?? '?'}: metrics.startedAt`),
    durationMs: countOf(metrics.durationMs),
    exit: Number.isInteger(metrics.exit) ? metrics.exit : null,
    timedOut: metrics.timedOut === true,
    interrupted: metrics.interrupted === true,
    spawnError: textOrNull(metrics.spawnError),
    runnerError: textOrNull(metrics.runnerError),
    steps: countOf(live.steps),
    stepsWithUsage: countOf(live.stepsWithUsage),
    turns: countOf(live.turns),
    toolCalls: countOf(live.toolCalls),
    toolErrors: countOf(live.toolErrors),
    usage: normalizeUsage(live.usage),
    usageReported: live.usageReported === true,
    usageBucketsSeen: stringList(live.usageBucketsSeen),
    format: typeof live.format === 'string' ? live.format : 'dsh-ops-bench-metrics-v1',
    profile: typeof live.profile === 'string' ? live.profile : null,
    sessionId: textOrNull(live.sessionId),
    prompt: live.prompt,
    stepUsage,
    toolUsage,
    unattributedUsage: normalizeUsage(live.unattributedUsage),
    attribution: {
      tools: countOf(attribution.tools),
      unattributed: countOf(attribution.unattributed),
      balanced: attribution.balanced === true,
    },
    toolCallsByName: isObject(live.toolCallsByName) ? { ...live.toolCallsByName } : {},
    turnEndReason: textOrNull(live.turnEndReason),
    textChars: countOf(live.textChars),
    thinkingChars: countOf(live.thinkingChars),
    finalTextBytes: countOf(live.finalTextBytes),
    finalSeen: live.finalSeen === true,
    eventCount: countOf(live.eventCount),
    malformedLines: countOf(live.malformedLines),
    truncatedLines: countOf(live.truncatedLines),
    errorEvents: Array.isArray(live.errorEvents) ? live.errorEvents.map((entry) => ({ message: typeof entry?.message === 'string' ? entry.message : '' })) : [],
    traceRows: narration.traceRows,
    milestones: narration.milestones,
    narration: narration.narration,
    archiveErrors: stringList(metrics.archiveErrors),
  }
}

/**
 * The aggregate of a row whose event file is missing or empty: the zero document,
 * with the counters and usage the row document itself recorded copied over. The
 * recorded usage is normalized (old documents carry `reasoningTokens` and no
 * `grandTotal`), never dropped.
 * @param {object} metrics - the row's metrics document.
 * @param {string} arm - the arm label.
 * @param {{taskId: string, repeatIndex: number}} identity - the row identity.
 * @returns {object} an aggregate-shaped document.
 */
function fallbackAggregate(metrics, arm, identity) {
  const empty = aggregateLines([], { label: arm, profile: textOrNull(metrics.profile), taskId: identity.taskId, repeatIndex: identity.repeatIndex })
  const usage = normalizeUsage(metrics.usage)
  return {
    ...empty,
    steps: countOf(metrics.steps),
    toolCalls: countOf(metrics.toolCalls),
    toolCallsByName: isObject(metrics.toolCallsByName) ? { ...metrics.toolCallsByName } : {},
    turnEndReason: textOrNull(metrics.turnEndReason),
    usage,
    usageBucketsSeen: [...CORE_BUCKETS, ...OPTIONAL_BUCKETS].filter((bucket) => Object.hasOwn(usage, bucket)),
    usageReported: metrics.usageReported === true,
  }
}

/**
 * The bounded P5 narration summary: how many trace rows there were, how many of them
 * were milestones, and the first few milestone rows themselves.
 * @param {string[]} traceLines - the row's trace file, line by line.
 * @returns {{traceRows: number, milestones: number, narration: {excerpts: object[], truncated: boolean}}} the summary.
 */
function buildNarration(traceLines) {
  const rows = traceLines.map(parseObject).filter(Boolean)
  const milestones = rows.filter((row) => row.role === 'boot' || row.role === 'milestone' || row.role === 'stall')
  const excerpts = milestones.slice(0, NARRATION_EXCERPT_CAP).map((row, index) => ({
    seq: Number.isInteger(row.seq) ? row.seq : index + 1,
    at: typeof row.at === 'string' ? row.at : '',
    offsetMs: countOf(row.offsetMs),
    kind: typeof row.kind === 'string' ? row.kind : 'note',
    text: typeof row.text === 'string' ? row.text : '',
  }))
  return { traceRows: traceLines.length, milestones: milestones.length, narration: { excerpts, truncated: milestones.length > excerpts.length } }
}

/**
 * The run-level rollup of the per-row checks.
 * @param {object[]} results - the sealed rows.
 * @returns {{checks: number, passed: number, failed: number, degraded: boolean}} the rollup.
 */
function rollupVerify(results) {
  let checks = 0
  let passed = 0
  for (const row of results) {
    for (const check of row.verify) {
      checks += 1
      if (check.pass === true) passed += 1
    }
  }
  const degraded = results.some((row) => row.metrics.timedOut === true || row.metrics.interrupted === true
    || row.runnerError !== null || row.metrics.spawnError !== null || row.metrics.usageReported !== true
    || (row.metrics.exit !== null && row.metrics.exit !== 0))
  return { checks, passed, failed: checks - passed, degraded }
}

/**
 * The provenance block. `startedAt`/`endedAt` are derived from the rows when the
 * caller did not pass them, so only `events.mergedAt` is a real clock reading.
 * @param {object} options - the seal options.
 * @param {{base: object, cand: object}} arms - the normalized arms.
 * @param {object[]} results - the sealed rows.
 * @param {string} sealedAt - the merge time, ISO 8601 UTC.
 * @returns {object} the meta block.
 */
function buildMeta(options, arms, results, sealedAt) {
  const provided = isObject(options.meta) ? options.meta : {}
  const starts = results.map((row) => row.metrics.startedAt).filter((value) => Number.isFinite(Date.parse(value))).sort()
  const ends = results
    .map((row) => Date.parse(row.metrics.startedAt) + row.metrics.durationMs)
    .filter((value) => Number.isFinite(value))
    .map((value) => new Date(value).toISOString())
    .sort()
  return {
    benchVersion: typeof provided.benchVersion === 'string' ? provided.benchVersion : benchVersion(),
    mode: provided.mode === 'tools' ? 'tools' : 'ab',
    platform: typeof provided.platform === 'string' ? provided.platform : platformTag(),
    node: typeof provided.node === 'string' ? provided.node : process.version,
    dsh: textOrNull(provided.dsh),
    model: textOrNull(provided.model),
    gitSha: textOrNull(provided.gitSha),
    gitBranch: textOrNull(provided.gitBranch),
    argv: Array.isArray(provided.argv) ? provided.argv.map(String) : [],
    startedAt: typeof provided.startedAt === 'string' ? provided.startedAt : starts[0] ?? sealedAt,
    endedAt: typeof provided.endedAt === 'string' ? provided.endedAt : ends[ends.length - 1] ?? null,
    arms: { base: compactArm(arms.base), cand: compactArm(arms.cand) },
  }
}

/**
 * The row identity: the metrics document is authoritative when it names one, and the
 * filename stem (`<task>-r<n>`) is the fallback — a task id may itself end in `-r1`,
 * so the stem alone cannot be parsed back unambiguously.
 * @param {string} segment - the stem.
 * @param {object} metrics - the row's metrics document.
 * @returns {{taskId: string, repeatIndex: number}} the identity.
 */
function rowIdentity(segment, metrics) {
  const match = /^(.*)-r(\d+)$/.exec(segment)
  const taskId = typeof metrics.taskId === 'string' && metrics.taskId !== '' ? metrics.taskId : match?.[1]
  const repeatIndex = Number.isInteger(metrics.repeatIndex) ? metrics.repeatIndex : match === null ? null : Number(match[2])
  if (typeof taskId !== 'string' || taskId === '' || !Number.isInteger(repeatIndex) || repeatIndex < 1) {
    throw new SealError(`sealRun: cannot read a task id and repeat index from the row file ${segment}${ROW_SUFFIXES.metrics}`)
  }
  return { taskId, repeatIndex }
}

/** The identity order rows are sealed in: task, then repeat, then arm. */
function compareResults(left, right) {
  return left.taskId.localeCompare(right.taskId) || left.repeatIndex - right.repeatIndex || left.arm.localeCompare(right.arm)
}

/** The path order `archive[]` and `events.files` are sealed in. */
function compareByPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

/** Validate and copy the two arm descriptors the top-level `arms` block carries. */
function normalizeArms(arms) {
  if (!isObject(arms)) throw new TypeError('sealRun: options.arms must be { base, cand }')
  return { base: normalizeArm(arms.base, 'base'), cand: normalizeArm(arms.cand, 'cand') }
}

/** One arm descriptor, with its three required fields checked and the rest passed through. */
function normalizeArm(arm, side) {
  if (!isObject(arm)) throw new TypeError(`sealRun: options.arms.${side} must describe an arm`)
  return {
    ...arm,
    label: requiredString(arm.label, `sealRun: options.arms.${side}.label`),
    profile: requiredString(arm.profile, `sealRun: options.arms.${side}.profile`),
    profileHash: requiredString(arm.profileHash, `sealRun: options.arms.${side}.profileHash`),
  }
}

/** The compact identity `meta.arms` carries. */
function compactArm(arm) {
  return { label: arm.label, profile: arm.profile, profileHash: arm.profileHash }
}

/** The schema-shaped check array: only the keys the contract names. */
function normalizeChecks(checks) {
  return (Array.isArray(checks) ? checks : []).map((check) => ({
    type: typeof check?.type === 'string' ? check.type : 'unknown',
    target: typeof check?.target === 'string' ? check.target : null,
    pass: check?.pass === true,
    detail: typeof check?.detail === 'string' ? check.detail : '',
  }))
}

/** Parse one NDJSON line into an object, or null when it is not one. */
function parseObject(line) {
  try {
    const value = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** The parsed event objects of a row, in order (malformed lines stay out). */
function inlineEvents(lines) {
  return lines.map(parseObject).filter(Boolean)
}

/** Read a file into lines, or [] when it is absent or empty. */
function readLines(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  if (text === '') return []
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed === '' ? [] : trimmed.split('\n')
}

/** Read and parse a JSON file, refusing to seal a row whose document is unreadable. */
function readJson(file, what) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new SealError(`sealRun: ${what} has no readable ${path.basename(file)} (${String(error?.code ?? error)})`)
  }
  try {
    const value = JSON.parse(text)
    if (!isObject(value)) throw new Error('not a JSON object')
    return value
  } catch (error) {
    throw new SealError(`sealRun: ${what} has an unparseable ${path.basename(file)}: ${String(error?.message ?? error)}`)
  }
}

/** SHA-256 of a file in hex, or null when it cannot be read. */
function fileHash(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** Replace a file's bytes only when they differ; returns whether anything changed. */
function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return false
  } catch {
    // Absent or unreadable: write it.
  }
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, text, 'utf8')
  fs.renameSync(temporary, file)
  return true
}

/** A path relative to the run directory, with forward slashes. */
function relativePath(dir, file) {
  return path.relative(dir, file).split(path.sep).join('/')
}

/** The version of the dsh-ops checkout this module runs from. */
function benchVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

/** The injectable clock, defaulting to `Date.now`. */
function clockOf(options) {
  return typeof options.now === 'function' ? options.now : Date.now
}

/** A non-negative integer, or 0. */
function countOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/** A string list with every non-string entry dropped. */
function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

/** A string, or null for anything else. */
function textOrNull(value) {
  return typeof value === 'string' ? value : null
}

/** A required non-empty string, named in the error when it is missing. */
function requiredString(value, what) {
  if (typeof value !== 'string' || value.trim() === '') throw new SealError(`sealRun: ${what} must be a non-empty string`)
  return value
}

/** Is this a directory? */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Is this a regular file? */
function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}
