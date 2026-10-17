#!/usr/bin/env node
/**
 * The comparison report: two archived runs in, one `report.md` out.
 *
 * The verdict is *not* computed here. `lib/compare-core.mjs` owns every rule — pass
 * rate first, cost only over pairs that passed on both sides, and a direction only
 * when the measured delta clears the A/A noise floor — and this file only resolves
 * the two sides, calls it, and renders what it returned. With no noise floor the
 * report says so and abstains from every cost direction (`noise-floor-unknown`).
 *
 * The report leads with the 结论条 a reviewer reads first (pass rate, paired token Δ,
 * the noise band and whether a direction is readable), then the per-task paired
 * table, the pairs a failed side forced out of the cost statistics, the A/A band,
 * and the diagnostic sections #183 carried — per-task bucket detail, the usage-bucket
 * split and the token attribution — which say *why* the number moved (a bigger
 * per-request prompt is a tool-schema cost, extra steps are a model-behaviour cost,
 * fatter tool results are a context cost; the fixes are opposite, so the report has
 * to say which one it was). None of the diagnostics can change the gate.
 *
 * Time is evidence only: the comparison never reads `durationMs`, and nothing here
 * turns a duration into a verdict.
 *
 * @module dsh-ops/bench/compare
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AGGREGATES,
  COMPARE_FORMAT,
  FAIL_ON,
  REGRESSION_SCOPES,
  compareSummaries,
  formatNumber,
  percentChange,
} from './lib/compare-core.mjs'
import { RUNS_DIR } from './lib/next-folder.mjs'

/** The sealed contract document inside a run directory. */
const SEALED_RUN = 'run.json'
/** #183's older summary document, still accepted as a side. */
const LEGACY_SUMMARY = 'summary.json'
/** The summary document's format tag. */
const SUMMARY_FORMAT = 'dsh-ops-bench-summary-v1'

/**
 * Exit codes, kept in step with `EXIT` in `bench/cli.mjs` (which forwards whatever
 * `main` returns): the A/B comparison's exit code *is* its verdict.
 */
export const EXIT = { ok: 0, failure: 1, usage: 2 }

const USAGE = `usage: node bench/compare.mjs <base> <cand> [options]

  <base> <cand>      each side is one of:
                       <label>   a run label, matched against bench/runs/*-<label>
                                 and one level of bench/runs/<folder>/*-<label>
                                 groups (the newest stamp wins)
                       <dir>     a run directory (run.json, else summary.json)
                       <file>    a run.json or summary.json path
  --folder <name>    restrict label matching to bench/runs/<name>/
  --runs <dir>       override the runs root (default bench/runs)
  --aggregate S      median (default) or min: the statistic the deltas compare
  --tolerance-pct N  token regression tolerance in percent (default 2)
  --fail-on MODE     regression | pass-drop | both (default) | none
  --regression-scope S  task (default) | total | both
  --noise-floor-pct N   pin the A/A noise floor; without a floor every cost
                     direction is withheld (noise-floor-unknown)
  --noise <a> <b>    measure the A/A noise floor from two baseline runs
  --json             print the comparison document as JSON instead of the report
  --out <file>       where the rendered artifact goes (default <cand dir>/report.md;
                     "-" is stdout only). With --json the file carries the JSON.
  --help             this text

Exit codes: 0 ok (or a gate that abstained) · 1 a gate failed · 2 usage/input error`

/**
 * The parsed command line.
 * @typedef {object} Options
 * @property {string|null} base - the baseline side spec.
 * @property {string|null} cand - the candidate side spec.
 * @property {string|null} folder - restrict label matching to one group directory.
 * @property {string} runsDir - where run directories live.
 * @property {'median'|'min'} aggregate - the statistic to compare.
 * @property {number} tolerancePct - the regression tolerance.
 * @property {'regression'|'pass-drop'|'both'|'none'} failOn - the gate.
 * @property {'task'|'total'|'both'} regressionScope - what the regression gate judges.
 * @property {number|null} noiseFloorPct - an externally pinned A/A floor.
 * @property {string[]|null} noise - two A/A side specs to measure the floor from.
 * @property {boolean} json - print the comparison document instead of the report.
 * @property {string|null} out - report path, `-` for stdout only, null for the default.
 * @property {boolean} help - whether `--help` was asked for.
 */

/**
 * Parse the command line. A malformed flag throws; `main` turns that into exit 2.
 * @param {string[]} argv - the arguments after the script name.
 * @returns {Options} the options.
 */
export function parseArgs(argv) {
  const positional = []
  const options = {
    base: null,
    cand: null,
    folder: null,
    runsDir: RUNS_DIR,
    aggregate: 'median',
    tolerancePct: 2,
    failOn: 'both',
    regressionScope: 'task',
    noiseFloorPct: null,
    noise: null,
    json: false,
    out: null,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg : arg.slice(0, eq)
      const inline = eq === -1 ? null : arg.slice(eq + 1)
      const take = () => {
        if (inline !== null) return inline
        index += 1
        if (index >= argv.length) throw new Error(`${name} needs a value`)
        return argv[index]
      }
      if (name === '--json') {
        if (inline !== null) throw new Error('--json takes no value; the comparison document goes to stdout and --out names a file')
        options.json = true
      } else if (name === '--aggregate') options.aggregate = take()
      else if (name === '--tolerance-pct') options.tolerancePct = Number(take())
      else if (name === '--fail-on') options.failOn = take()
      else if (name === '--regression-scope') options.regressionScope = take()
      else if (name === '--noise-floor-pct') options.noiseFloorPct = Number(take())
      else if (name === '--noise') {
        const first = take()
        index += 1
        if (index >= argv.length) throw new Error('--noise needs two sides: --noise <base> <cand>')
        options.noise = [first, argv[index]]
      } else if (name === '--out') options.out = take()
      else if (name === '--folder') options.folder = assertFolderName(take(), '--folder')
      else if (name === '--runs') options.runsDir = path.resolve(take())
      else throw new Error(`unknown option "${name}"`)
      continue
    }
    if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option "${arg}"`)
    positional.push(arg)
  }
  if (!AGGREGATES.includes(options.aggregate)) throw new Error(`--aggregate must be one of ${AGGREGATES.join(', ')}`)
  if (!FAIL_ON.includes(options.failOn)) throw new Error(`--fail-on must be one of ${FAIL_ON.join(', ')}`)
  if (!REGRESSION_SCOPES.includes(options.regressionScope)) throw new Error(`--regression-scope must be one of ${REGRESSION_SCOPES.join(', ')}`)
  if (!Number.isFinite(options.tolerancePct) || options.tolerancePct < 0) throw new Error('--tolerance-pct must be a non-negative number')
  if (options.noiseFloorPct !== null && (!Number.isFinite(options.noiseFloorPct) || options.noiseFloorPct < 0)) {
    throw new Error('--noise-floor-pct must be a non-negative number')
  }
  if (options.help) return options
  if (positional.length !== 2) throw new Error('expected exactly two sides: <base> <cand>')
  options.base = positional[0]
  options.cand = positional[1]
  return options
}

/**
 * A `--folder` name must be one flat, safe directory segment under the runs root.
 * @param {string} name - the requested folder name.
 * @param {string} flag - the flag it came from, for the error text.
 * @returns {string} the validated name.
 */
function assertFolderName(name, flag) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/]/.test(name) || name.includes(':')) {
    throw new Error(`${flag} must be one safe directory name (no path separators, no "." or ".."), got "${name}"`)
  }
  return name
}

/** Whether a path exists and is a directory. */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** Whether a path exists and is a file. */
function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * Read and identify one side's document.
 *
 * Two shapes exist in this repo and both are accepted: the sealed `run.json`
 * (`schemaVersion: 1`, `results` rows) and #183's summary. Anything else is refused
 * loudly rather than silently compared as an empty document.
 * @param {string} file - the document path.
 * @returns {{doc: object, file: string, dir: string, kind: 'run'|'summary'}} the side document.
 */
function readSide(file) {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: not readable as JSON (${error.message})`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file}: not a JSON object`)
  const sealed = doc.schemaVersion === 1 && Array.isArray(doc.results)
  if (sealed) return { doc, file, dir: path.dirname(file), kind: 'run' }
  if (doc.format === SUMMARY_FORMAT && Array.isArray(doc.results)) return { doc, file, dir: path.dirname(file), kind: 'summary' }
  const saw = typeof doc.format === 'string' ? `format "${doc.format}"` : `schemaVersion ${JSON.stringify(doc.schemaVersion)}`
  throw new Error(`${file}: unrecognised document (want a sealed run.json with schemaVersion 1 or a summary with format "${SUMMARY_FORMAT}", saw ${saw})`)
}

/**
 * Resolve one side of the comparison.
 *
 * Three forms, in the order #183 made convenient: an existing directory (preferring
 * `run.json` over `summary.json`), an existing file, or a label matched against the
 * runs root and one level of group directories (the newest stamp wins — a comparison
 * is about the latest measured state of each side).
 * @param {string} spec - a label, a run directory, or a document path.
 * @param {object} [options] - `{runsDir, folder}`.
 * @returns {{doc: object, file: string, dir: string, kind: 'run'|'summary', spec: string}} the resolved side.
 */
export function resolveSide(spec, options = {}) {
  const runsDir = options.runsDir ?? RUNS_DIR
  const folder = options.folder ?? null
  const direct = path.resolve(spec)
  if (isDirectory(direct)) {
    const file = [SEALED_RUN, LEGACY_SUMMARY]
      .map((name) => path.join(direct, name))
      .find((candidate) => fs.existsSync(candidate))
    if (!file) throw new Error(`${direct}: a directory, but it has no ${SEALED_RUN} and no ${LEGACY_SUMMARY}`)
    return { ...readSide(file), spec }
  }
  if (isFile(direct)) return { ...readSide(direct), spec }
  return { ...readSide(findLabel(spec, runsDir, folder)), spec }
}

/**
 * Find the newest archived run whose directory name is, or ends in, the label.
 * @param {string} spec - the label.
 * @param {string} runsDir - the runs root.
 * @param {string|null} folder - one group directory to search instead of the root
 *   plus one level of groups.
 * @returns {string} the document path.
 */
function findLabel(spec, runsDir, folder) {
  if (!isDirectory(runsDir)) {
    throw new Error(`no runs directory at ${runsDir}; pass a run directory or a ${SEALED_RUN}/${LEGACY_SUMMARY} path instead of the label "${spec}"`)
  }
  let roots
  if (folder !== null) {
    roots = [path.join(runsDir, folder)]
    if (!isDirectory(roots[0])) throw new Error(`no run folder "${folder}" at ${roots[0]}`)
  } else {
    roots = [runsDir]
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(runsDir, entry.name))
    }
  }
  const matches = []
  for (const root of roots) {
    let names
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (name !== spec && !name.endsWith(`-${spec}`)) continue
      const dir = path.join(root, name)
      if (!isDirectory(dir)) continue
      for (const fileName of [SEALED_RUN, LEGACY_SUMMARY]) {
        const candidate = path.join(dir, fileName)
        if (fs.existsSync(candidate)) {
          matches.push({ name, file: candidate })
          break
        }
      }
    }
  }
  if (matches.length === 0) {
    const where = folder === null ? runsDir : path.join(runsDir, folder)
    throw new Error(`"${spec}" is neither a run directory, a ${SEALED_RUN}/${LEGACY_SUMMARY} path, nor a label with an archived run under ${where}`)
  }
  matches.sort((left, right) => (left.name === right.name ? left.file.localeCompare(right.file) : left.name < right.name ? -1 : 1))
  return matches[matches.length - 1].file
}

/** The U+2212 minus sign, so a negative delta reads as a sign rather than a hyphen. */
const MINUS = '\u2212'

/** A thousands-separated integer, `n/a` when it is not a number. */
function number(value) {
  return formatNumber(value)
}

/** A signed integer delta with grouping, for the diagnostic tables. */
function signed(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : rounded < 0 ? MINUS : ''}${Math.abs(rounded).toLocaleString('en-US')}`
}

/** A signed percent at the module's reporting precision. */
function percent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return `${value > 0 ? '+' : value < 0 ? MINUS : ''}${Math.abs(value).toFixed(1)}%`
}

/** The short verdict name for one task's cost conclusion. */
function directionLabel(cost, regressed) {
  if (regressed) return '⚠ 回归'
  switch (cost?.conclusion) {
    case 'cheaper': return '更省'
    case 'costlier': return '更贵'
    case 'within-noise': return '噪声内'
    case 'noise-floor-unknown': return '弃权(噪声底未知)'
    case 'incomparable': return '不可比'
    default: return '无变化'
  }
}

/**
 * The direction sentence — the one place the three noise outcomes are worded.
 * The core's conclusion names travel verbatim so the report and the JSON cannot drift.
 * @param {object} cost - `verdict.cost` from the comparison.
 * @returns {string} the sentence.
 */
function directionSentence(cost) {
  if (cost.conclusion === 'incomparable') {
    return '方向:没有两侧都通过、且 usage 完整的配对 ⇒ 成本不可比(incomparable),不读方向'
  }
  if (cost.conclusion === 'noise-floor-unknown') {
    return `方向:Δ ${percent(cost.pct)},但噪声底未知 ⇒ 弃权,不读方向(noise-floor-unknown);用 --noise-floor-pct N 或 --noise <base> <cand> 提供噪声底`
  }
  if (cost.conclusion === 'within-noise') {
    return `方向:Δ ${percent(cost.pct)} 落在噪声带 ±${cost.noiseFloorPct}% 内 ⇒ 只报区间,不读方向(within-noise)`
  }
  if (cost.conclusion === 'cheaper' || cost.conclusion === 'costlier') {
    const name = cost.conclusion === 'cheaper' ? '更省(cheaper)' : '更贵(costlier)'
    return `方向:Δ ${percent(cost.pct)},超过噪声底 ±${cost.noiseFloorPct}% ⇒ 可读方向:${name}`
  }
  return `方向:Δ ${percent(cost.pct)},无可读方向(${cost.conclusion ?? 'no-change'})`
}

/**
 * The 结论条: pass rate, paired token Δ, noise floor, direction and gate, in that order.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function verdictSection(comparison) {
  const { gate, totals, verdict, noiseFloor } = comparison
  const passes = `${totals.basePasses}/${totals.baseRuns} → ${totals.candPasses}/${totals.candRuns}`
  const passLine = gate.passDropFailed
    ? `❌ 通过率下降 ${passes}`
    : totals.candPassRate > totals.basePassRate
      ? `✅ 通过率上升 ${passes}`
      : `✅ 通过率持平 ${passes}`
  const pairs = `${gate.usablePairs}/${gate.usablePairs + gate.excludedPairs}`
  const tokenLine = gate.tokensComparable && gate.costComparable
    ? `💰 token(配对 ${pairs}):${number(totals.baseGrandTotal)} → ${number(totals.candGrandTotal)},Δ ${percent(totals.grandTotalPct)}`
    : `💰 token:不可比(${gate.tokensComparable ? `没有两侧都通过的配对,${gate.excludedPairs} 对被排除` : '至少一侧 usage 不完整'})`
  const noiseLine = noiseFloor.comparable
    ? `🔬 噪声底(A/A):±${noiseFloor.pct}%(${noiseFloor.method})`
    : '🔬 噪声底(A/A):未知'
  const lines = [
    `# bench compare: ${comparison.base.label ?? 'base'} → ${comparison.cand.label ?? 'cand'}`,
    '',
    `${passLine} · ${tokenLine} · ${noiseLine} · 🚦 ${gate.fail ? `门禁失败(${gate.primary})` : '门禁通过'}`,
    '',
    '## 结论',
    '',
    `- 通过率:${passes}${gate.passDropFailed ? '(下降,先于成本裁决)' : totals.candPassRate > totals.basePassRate ? '(上升)' : '(持平)'}`,
    `- ${tokenLine.replace('💰 ', '')}`,
    `- 噪声底(A/A):${noiseFloor.comparable ? `±${noiseFloor.pct}%,方法 \`${noiseFloor.method}\`` : '未知(noise-floor-unknown)'}`,
    `- ${directionSentence(verdict.cost)}`,
    `- 门禁:\`--fail-on ${gate.failOn}\` · 回归口径 \`${gate.regressionScope}\` · 容差 ${gate.tolerancePct}% · 成本基准 \`${gate.costBasis}\``,
    `- 口径:${comparison.aggregate} · profile ${comparison.base.profile ?? '?'} → ${comparison.cand.profile ?? '?'} · model ${comparison.base.model ?? '?'} → ${comparison.cand.model ?? '?'}`,
  ]
  for (const reason of gate.reasons) lines.push(`- 判定理由:${reason}`)
  return lines
}

/**
 * The per-task paired table: cost plus the pass migration a reviewer scans for.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function taskSection(comparison) {
  const { gate, totals } = comparison
  const lines = [
    '## 每任务配对',
    '',
    '成本只统计两侧都通过的对(`paired-both-passed`);Δ% 是配对成本的变化,不是全部重复的平均。',
    '',
    '| task | base | cand | Δ% | 配对 可用/计入 | 被排除 | pass base→cand | 方向 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const task of comparison.tasks) {
    const pair = task.paired
    const name = task.inBase && task.inCand ? task.id : `${task.id}${task.inBase ? '(仅 base)' : '(仅 cand)'}`
    lines.push(`| ${name} | ${number(pair.baseValue)} | ${number(pair.candValue)} | ${percent(pair.pct)} | ${pair.pairs}/${pair.considered} | ${pair.excluded.total} | ${task.base.passed}/${task.base.repeats}→${task.cand.passed}/${task.cand.repeats} | ${directionLabel(task.cost, task.regressed)} |`)
  }
  const totalPairs = `${gate.usablePairs}/${gate.usablePairs + gate.excludedPairs}`
  lines.push(`| **TOTAL** | ${number(totals.baseGrandTotal)} | ${number(totals.candGrandTotal)} | ${percent(totals.grandTotalPct)} | ${totalPairs} | ${gate.excludedPairs} | ${totals.basePasses}/${totals.baseRuns}→${totals.candPasses}/${totals.candRuns} | ${directionLabel(comparison.verdict.cost, false)} |`)
  lines.push(`| **几何均值 Δ** | — | — | ${percent(totals.grandTotalGeomeanPct)} | — | — | — | 每任务等权 |`)
  return lines
}

/**
 * The pairs a failed side forced out of the cost statistics — the count the issue
 * requires to be visible, so a run cannot shrink its own denominator quietly.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function excludedSection(comparison) {
  const { excluded } = comparison.pairing
  const lines = ['## 被排除的配对(成本不统计)', '']
  if (excluded.total === 0) {
    lines.push('没有被排除的配对:两侧都通过的配对全部参与了成本统计。')
  } else {
    lines.push(`共 ${excluded.total} 对因至少一侧未通过被排除:base 失败 ${excluded.baseFailed} · cand 失败 ${excluded.candFailed} · 两侧都失败 ${excluded.bothFailed}。`, '')
    lines.push('| task | 被排除 | base 失败 | cand 失败 | 两侧失败 |', '| --- | --- | --- | --- | --- |')
    for (const task of comparison.tasks) {
      const counts = task.paired.excluded
      if (counts.total === 0) continue
      lines.push(`| ${task.id} | ${counts.total} | ${counts.baseFailed} | ${counts.candFailed} | ${counts.bothFailed} |`)
    }
  }
  const counts = comparison.pairing.counts
  lines.push(
    '',
    `配对合并:键 ${counts.pairs} · 缺 base ${counts.missingBase} · 缺 cand ${counts.missingCand} · 重复键 ${counts.duplicates} · 标签不符 ${counts.labelMismatches} · 行无效 ${counts.invalid};合并${comparison.pairing.complete ? '完整' : '不完整'}。`,
  )
  return lines
}

/**
 * The A/A band: what "nothing changed" looked like, or an explicit statement that
 * it is unknown and every direction is therefore withheld.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function noiseSection(comparison) {
  const noise = comparison.noiseFloor
  const lines = ['## A/A 噪声带', '']
  if (!noise.comparable) {
    lines.push(
      '噪声底未知 ⇒ 没有可读的区间,成本方向一律弃权(`noise-floor-unknown`);报告只给测到的 Δ,不给方向。',
      '',
      '提供方式:`--noise-floor-pct N` 固定一个已测量的噪声底,或 `--noise <base> <cand>` 用两次基线运行现测。',
    )
    return lines
  }
  lines.push(
    `半宽 ±${noise.pct}% · 区间 [${percent(noise.band.low)}, ${percent(noise.band.high)}] · 方法 \`${noise.method}\` · 配对 ${noise.pairs} · 任务样本 ${noise.samples}${noise.medianAbsPct === null ? '' : ` · 中位幅度 ${noise.medianAbsPct}%`}`,
    '',
    'Δ 只有超过这个半宽才读方向;带内一律只报区间。',
  )
  if (noise.method === 'provided') lines.push('', '来源是外部提供(`--noise-floor-pct`),不是本次测量。')
  if (noise.perTask.length > 0) {
    lines.push('', '| task | base | cand | Δ% | 配对 |', '| --- | --- | --- | --- | --- |')
    for (const entry of noise.perTask) lines.push(`| ${entry.id} | ${number(entry.base)} | ${number(entry.cand)} | ${percent(entry.pct)} | ${entry.pairs} |`)
  }
  return lines
}

/**
 * The token attribution: how the TOTAL delta splits into the per-request fixed cost,
 * the extra steps, and what neither explains. Diagnostic only — it never fails a run.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function attributionSection(comparison) {
  const overhead = comparison.overhead
  const lines = ['## token 归因(诊断,不改判决)', '']
  if (!overhead.comparable) {
    lines.push('Skipped:至少一侧没有 prompt 采集(`metrics.prompt`),无法把 Δ 拆成固定开销 / 额外步数 / 残差。')
    return lines
  }
  lines.push(
    `可归因任务 ${overhead.comparableTasks}/${overhead.tasks}(首步 prompt 是唯一不带历史的请求,固定开销按它计)。`,
    '',
    `归因覆盖全部 ${overhead.tasks} 个有 prompt 采集的任务(含未进入成本统计的配对),所以它的合计与配对 token Δ 可能相差被排除任务的量。`,
    '',
    '| 项 | tokens Δ | 读法 |',
    '| --- | --- | --- |',
    `| 每请求固定开销 | ${signed(overhead.fixedOverheadTokens)} | 首步 prompt Δ × cand 步数:工具 schema / 提示策略 |`,
    `| 额外步数 | ${signed(overhead.extraStepsTokens)} | Δ步数 × base 首步 prompt:模型行为 |`,
    `| 残差 | ${signed(overhead.residualTokens)} | 上下文增长 / 工具返回等前两项未解释的部分 |`,
    `| 输出 | ${signed(overhead.outputDelta)} | 模型输出 |`,
    `| 合计(prompt + 输出) | ${signed(overhead.totalDelta)} | 与配对 token Δ 同向、同量级(差额来自被排除的任务) |`,
  )
  const rows = comparison.tasks.filter((task) => task.overhead?.comparable === true)
  if (rows.length > 0) {
    lines.push('', '### 每任务归因', '', '| task | 固定开销 Δ | 额外步数 Δ | 残差 Δ | 输出 Δ | 合计 Δ |', '| --- | --- | --- | --- | --- | --- |')
    for (const task of rows) {
      const entry = task.overhead
      lines.push(`| ${task.id} | ${signed(entry.fixedOverheadTokens)} | ${signed(entry.extraStepsTokens)} | ${signed(entry.residualTokens)} | ${signed(entry.outputDelta)} | ${signed(entry.totalDelta)} |`)
    }
  }
  return lines
}

/**
 * #183's per-task bucket detail: the three usage buckets behind each task's total.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function bucketSection(comparison) {
  const useMin = comparison.aggregate === 'min'
  const keys = { input: useMin ? 'inputMin' : 'inputMedian', output: useMin ? 'outputMin' : 'outputMedian', cacheRead: useMin ? 'cacheReadMin' : 'cacheReadMedian' }
  const cell = (baseValue, candValue) => `${number(baseValue)} → ${number(candValue)} (${percent(percentChange(baseValue, candValue))})`
  const lines = [
    `## 每任务 bucket 明细(${comparison.aggregate})`,
    '',
    '每格是该侧配对样本的统计量;TOTAL 行对配对求和,与每任务表"各任务统计量之和"的口径不同(重复数不等时两者不相等,判决只用后者)。',
    '',
    '| task | input base→cand (Δ%) | output base→cand (Δ%) | cache read base→cand (Δ%) |',
    '| --- | --- | --- | --- |',
  ]
  for (const task of comparison.tasks) {
    lines.push(`| ${task.id} | ${cell(task.base[keys.input], task.cand[keys.input])} | ${cell(task.base[keys.output], task.cand[keys.output])} | ${cell(task.base[keys.cacheRead], task.cand[keys.cacheRead])} |`)
  }
  const buckets = comparison.totals.buckets
  if (buckets.comparable) {
    lines.push(`| **TOTAL** | ${cell(buckets.input.base, buckets.input.cand)} | ${cell(buckets.output.base, buckets.output.cand)} | ${cell(buckets.cacheRead.base, buckets.cacheRead.cand)} |`)
  }
  return lines
}

/**
 * The usage split: how the TOTAL delta divides between uncached input, output and
 * cache reads, with each bucket's share of the delta. The gate judges the total.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function usageSplitSection(comparison) {
  const buckets = comparison.totals.buckets
  const lines = [`## usage 拆分(TOTAL,${comparison.aggregate})`, '']
  if (!buckets.comparable) {
    lines.push('Skipped:至少一侧丢了 `step_end.usage`,per-bucket 的 Δ 会是"下界被当成测量值"。')
    return lines
  }
  const row = (label, bucket) => `| ${label} | ${number(bucket.base)} | ${number(bucket.cand)} | ${signed(bucket.delta)} (${percent(percentChange(bucket.base, bucket.cand))}) | ${bucket.sharePct === null ? 'n/a' : `${bucket.sharePct}%`} |`
  lines.push(
    '三个 bucket 相加是总数;Δ 落在 cache read 和落在 uncached input 是两张完全不同的账单。本节对配对求和(与每任务表的合计口径不同),判决仍只看配对的 token Δ。',
    '',
    '| bucket | base | cand | Δ (Δ%) | 占 Δ 的份额 |',
    '| --- | --- | --- | --- | --- |',
    row('uncached input', buckets.input),
    row('output', buckets.output),
    row('cache read', buckets.cacheRead),
    row('**TOTAL**', buckets.grandTotal),
  )
  return lines
}

/**
 * Tool adoption, summed over every repeat on each side: a tool called once and never
 * again is still evidence it was published and reached for, and a built-in the
 * candidate kept reaching for is the number this table exists to surface.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function toolSection(comparison) {
  const totals = new Map()
  for (const task of comparison.tasks) {
    for (const side of ['base', 'cand']) {
      for (const [name, count] of Object.entries(task[side].toolCallsByName ?? {})) {
        const entry = totals.get(name) ?? { base: 0, cand: 0 }
        entry[side] += count
        totals.set(name, entry)
      }
    }
  }
  const lines = ['## 工具调用(每侧重合计数)', '']
  if (totals.size === 0) {
    lines.push('Skipped:两侧都没有记录 `toolCallsByName`。')
    return lines
  }
  const own = (name) => name.startsWith('ops')
  const rows = [...totals.entries()].sort((left, right) => (Number(own(right[0])) - Number(own(left[0]))) || (right[1].cand - left[1].cand) || left[0].localeCompare(right[0]))
  lines.push('| tool | base | cand |', '| --- | --- | --- |')
  for (const [name, counts] of rows) lines.push(`| ${name} | ${number(counts.base)} | ${number(counts.cand)} |`)
  return lines
}

/**
 * Every warning the core recorded (model mismatch, incomplete usage, one-sided
 * tasks, pairing leftovers) — nothing measured is allowed to disappear quietly.
 * @param {object} comparison - the comparison structure.
 * @returns {string[]} the section lines.
 */
function warningSection(comparison) {
  if (comparison.warnings.length === 0) return ['## 警告', '', '没有警告。']
  return ['## 警告', '', ...comparison.warnings.map((warning) => `- ${warning}`)]
}

/**
 * Render the comparison as `report.md`.
 *
 * Pure: same comparison and sources in, byte-identical text out. No timestamps are
 * written, so the report is reproducible and diffable.
 * @param {object} comparison - the structure from `compareSummaries`.
 * @param {{base?: object, cand?: object}} [sources] - the two resolved sides.
 * @returns {string} the report text (no trailing newline).
 */
export function renderReport(comparison, sources = {}) {
  const lines = [
    ...verdictSection(comparison),
    '',
    ...taskSection(comparison),
    '',
    ...excludedSection(comparison),
    '',
    ...noiseSection(comparison),
    '',
    ...attributionSection(comparison),
    '',
    ...bucketSection(comparison),
    '',
    ...usageSplitSection(comparison),
    '',
    ...toolSection(comparison),
    '',
    ...warningSection(comparison),
    '',
    '## 证据',
    '',
    `- base:${sources.base?.file ?? '?'}(spec \`${sources.base?.spec ?? '?'}\`,${sources.base?.kind ?? '?'})`,
    `- cand:${sources.cand?.file ?? '?'}(spec \`${sources.cand?.spec ?? '?'}\`,${sources.cand?.kind ?? '?'})`,
    `- 文档:format \`${comparison.format}\` · aggregate \`${comparison.aggregate}\` · 容差 ${comparison.tolerancePct}%`,
    '',
    `时间字段只作证据:本报告的成本口径是配对的 token,对比不读取时长的判决(${COMPARE_FORMAT} 不含时间统计)。`,
  ]
  return lines.join('\n')
}

/**
 * Where the rendered artifact goes.
 * @param {Options} options - the parsed options.
 * @param {{dir: string}} cand - the resolved candidate side.
 * @returns {string|null} the absolute path, or null to write no file.
 */
function reportPath(options, cand) {
  if (options.out === '-') return null
  if (options.out !== null) return path.resolve(options.out)
  if (options.json) return null
  return path.join(cand.dir, 'report.md')
}

/**
 * The comparator's main.
 *
 * Everything that decides is in `compare-core.mjs`; this resolves, renders, writes
 * and maps the gate to an exit code. A cost gate that could not run (no noise floor,
 * incomplete usage, no both-passed pair) abstains — it does not fail the run.
 * @param {string[]} argv - the arguments after the script name.
 * @param {{out?: Function, err?: Function}} [io] - output sinks; defaults to the console.
 * @returns {Promise<number>} the process exit code.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    err(USAGE)
    err(`compare: ${String(error?.message ?? error)}`)
    return EXIT.usage
  }
  if (options.help) {
    out(USAGE)
    return EXIT.ok
  }

  let base
  let cand
  let noise = null
  try {
    base = resolveSide(options.base, options)
    cand = resolveSide(options.cand, options)
    if (options.noise !== null) {
      noise = { base: resolveSide(options.noise[0], options).doc, cand: resolveSide(options.noise[1], options).doc }
    }
  } catch (error) {
    err(`compare: ${String(error?.message ?? error)}`)
    return EXIT.usage
  }

  const comparison = compareSummaries(base.doc, cand.doc, {
    aggregate: options.aggregate,
    tolerancePct: options.tolerancePct,
    failOn: options.failOn,
    regressionScope: options.regressionScope,
    noiseFloorPct: options.noiseFloorPct ?? undefined,
    noise: noise ?? undefined,
  })
  const sources = {
    base: { spec: options.base, file: base.file, kind: base.kind },
    cand: { spec: options.cand, file: cand.file, kind: cand.kind },
  }
  const payload = options.json
    ? `${JSON.stringify(comparison, null, 2)}\n`
    : `${renderReport(comparison, sources)}\n`
  out(payload)

  const target = reportPath(options, cand)
  if (target !== null) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, payload, 'utf8')
    } catch (error) {
      err(`compare: could not write ${target} (${String(error?.message ?? error)})`)
      return EXIT.failure
    }
    err(`compare: wrote ${target}`)
  }

  if (comparison.gate.fail) {
    err(`compare: GATE FAILED (${comparison.gate.failOn}) — ${comparison.gate.reasons.join('; ')}`)
    return EXIT.failure
  }
  if (options.failOn !== 'none') {
    if (!comparison.gate.tokensComparable) err('compare: 成本门禁未运行(至少一侧 usage 不完整);只跑了 pass-drop。')
    else if (!comparison.gate.costComparable) err(`compare: 成本门禁未运行(没有两侧都通过的配对,${comparison.gate.excludedPairs} 对被排除);只跑了 pass-drop。`)
    else if (!comparison.noiseFloor.comparable) err('compare: 噪声底未知 ⇒ 成本方向弃权(noise-floor-unknown);用 --noise-floor-pct 或 --noise 提供。')
  }
  return EXIT.ok
}

// Only when executed, not when the suite imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
