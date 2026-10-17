/**
 * The `log` fixture family: a directory of level-stamped logs to count, and a
 * noisy test runner with exactly one uniquely named failure to find.
 * @module dsh-ops/bench/fixtures/log
 */

import { hexRun, mulberry32, pad, pick, WORDS } from './index.mjs'

/**
 * `logStats` — a directory of log files plus the per-file count of `ERROR` lines
 * (PLAN.md §7.5). Message bodies are lowercase, so "lines containing ERROR" and
 * "lines whose level is ERROR" are the same set: the expected answer cannot be
 * read two ways.
 * @param {{seed?: number, files?: number, linesPerFile?: number}} params - the shape of the logs.
 * @returns {{files: {path: string, content: string}[], exports: {report: string[], files: number}}} the fixture.
 */
export function logStats(params = {}) {
  const seed = params.seed ?? 13
  const fileCount = params.files ?? 50
  const linesPerFile = params.linesPerFile ?? 400
  const levels = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR']

  const next = mulberry32(seed)
  const files = []
  const report = []
  for (let index = 0; index < fileCount; index += 1) {
    const name = `app_${pad(index, 2)}.log`
    let errors = 0
    const lines = []
    for (let line = 0; line < linesPerFile; line += 1) {
      const level = pick(next, levels)
      const stamp = `2025-03-${pad((index % 28) + 1, 2)}T${pad(line % 24, 2)}:${pad(line % 60, 2)}:${pad((line * 7) % 60, 2)}Z`
      const body = `${pick(next, WORDS)} ${pick(next, WORDS)} ${hexRun(next, 8).toLowerCase()}`
      if (level === 'ERROR') errors += 1
      lines.push(`${level}|${stamp}|${body}`)
    }
    const content = `${lines.join('\n')}\n`
    if (content.split('\n').some((line) => line.split('|')[0] !== 'ERROR' && line.includes('ERROR'))) {
      throw new Error(`ambiguous ERROR text in ${name}`)
    }
    files.push({ path: `logs/${name}`, content })
    report.push(`${name} ${errors}`)
  }
  return { files, exports: { report, files: fileCount } }
}

/**
 * `noisySuite` — a test runner that prints thousands of passing lines, one failure,
 * and exits non-zero (PLAN §7.8).
 *
 * Triage from a noisy log is an everyday shape: the answer is one line in a wall of
 * them, and the cost is proportional to how much of the wall reaches the context. The
 * failing test's name is unique across the suite, and it is the only `not ok` line,
 * so the answer is exact and a guess cannot pass.
 * @param {{seed?: number, tests?: number, failAt?: number}} params - the shape of the run.
 * @returns {{files: {path: string, content: string}[], exports: {failingName: string, failingIndex: number, tests: number}}} the fixture.
 */
export function noisySuite(params = {}) {
  const seed = params.seed ?? 29
  const tests = Math.max(200, params.tests ?? 2400)
  const failAt = params.failAt ?? Math.floor(tests * 0.62)
  if (!Number.isInteger(failAt) || failAt < 0 || failAt >= tests) throw new Error('failAt must be a valid index')
  const next = mulberry32(seed)

  const names = []
  const seen = new Set()
  for (let index = 0; index < tests; index += 1) {
    let name = `${pick(next, ['handles', 'rejects', 'round-trips', 'skips', 'coalesces', 'normalises'])} ${pick(next, WORDS)} ${hexRun(next, 6).toLowerCase()}`
    while (seen.has(name)) name = `${name}-${hexRun(next, 2).toLowerCase()}`
    seen.add(name)
    names.push(name)
  }
  names[failAt] = `${names[failAt]} when the queue is drained`
  if (seen.has(names[failAt]) && names.filter((name) => name === names[failAt]).length !== 1) throw new Error('the failing test name must be unique')
  const failingName = names[failAt]
  if (names.filter((name) => name === failingName).length !== 1) throw new Error('the failing test name must be unique')
  if (names.some((name) => name !== failingName && name.includes(failingName))) throw new Error('no passing name may contain the failing name')
  if (names.some((name) => name.includes('not ok'))) throw new Error('a test name must not contain the failure marker')

  const module = `${pick(next, ['queue', 'scheduler', 'ingest'])}`
  const runner = `// generated suite — do not edit
const TESTS = ${JSON.stringify(names, null, 2)}

const FAILING_INDEX = ${failAt}
const FAILING_MODULE = 'src/${module}.js'

let failed = 0
for (let index = 0; index < TESTS.length; index += 1) {
  const name = TESTS[index]
  if (index % 250 === 0) console.log(\`# progress \${index}/\${TESTS.length}\`)
  if (index === FAILING_INDEX) {
    failed += 1
    console.log(\`not ok \${index + 1} - \${name}\`)
    console.log('  ---')
    console.log('  message: \"AssertionError: expected the queue to drain in 250 ms\"')
    console.log(\`  file: \${FAILING_MODULE}\`)
    console.log('    actual: 41')
    console.log('    expected: 0')
    console.log('  ...')
    continue
  }
  console.log(\`ok \${index + 1} - \${name}\`)
}
console.log(\`# \${TESTS.length - failed} passed, \${failed} failed\`)
process.exitCode = failed === 0 ? 0 : 1
`
  return {
    files: [
      { path: 'runner.js', content: runner },
      { path: `src/${module}.js`, content: `// ${module} module under test\nexport const IN_FLIGHT = 41\n` },
    ],
    exports: { failingName, failingIndex: failAt, tests },
  }
}

/** Recompute `logStats`'s `{report, files}` from the log files themselves. */
export function deriveLogStats(files) {
  const report = files.map((file) => {
    const name = file.path.split('/').pop()
    const count = file.content.split('\n').filter((line) => line.includes('ERROR')).length
    return `${name} ${count}`
  })
  return { report, files: report.length }
}

/** Recompute `noisySuite`'s `{failingName, failingIndex, tests}` from the runner; throws unless the name is unique. */
export function deriveNoisySuite(files) {
  const runner = files.find((file) => file.path === 'runner.js')?.content ?? ''
  const names = [...runner.matchAll(/^  "(.+)",?$/gm)].map((match) => match[1])
  const failingIndex = Number(/^const FAILING_INDEX = (\d+)$/m.exec(runner)?.[1] ?? -1)
  const failingName = names[failingIndex]
  if (names.filter((name) => name === failingName).length !== 1) throw new Error('the failing test name must be unique')
  return { failingName, failingIndex, tests: names.length }
}
