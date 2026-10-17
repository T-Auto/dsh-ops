/**
 * P13's mode entry: the model-free tool-level corpus, and {@link runTools} —
 * the single call the future `bench tools` subcommand will make.
 *
 * The corpus lives here, next to the run it feeds, because the model-driven
 * families under `../lib/fixtures/` are a different catalogue (P2/P3): they
 * produce task workspaces, this one produces the fixed size boundaries the
 * native file tools are compared on. A later slice may move it once both
 * catalogues have one home; moving it must keep {@link SEED} and the five
 * fixture families byte-identical or the comparison loses its baseline.
 *
 * `runTools` does not parse argv and does not call `process.exit*`: it returns
 * `{ report, output, exitCode }`, and {@link main} below owns the flags and the
 * final exit code so `bench/cli.mjs` can dispatch here like any other subcommand.
 * The flag names are #103's, so an invocation written against it keeps working.
 *
 * @module dsh-ops/bench/tools
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { compareFiles } from './files.mjs'

export { ACCEPTED_STATES, ROUNDS, WARMUPS, compareFiles, writeReportExclusive } from './files.mjs'
export { EXPECTED_DIFFERENCES, canonical, compare, firstDifference, median, runWorker, sha256, summarize } from './measure.mjs'

/** The fixture seed; changing it invalidates every archived report. */
export const SEED = 870016

/**
 * Build the five tool-level fixture families in a new owned directory.
 *
 * Every created path is owned explicitly and generation happens before timing.
 * `scale` multiplies the file *counts* only: the 33 MiB rejection, the 8 MiB hex
 * window and the 1 MiB line boundaries are always present, so a smoke run at
 * `scale 0.001` still exercises every boundary.
 *
 * @param {object} options - the fixture inputs.
 * @param {string} options.parent - an existing directory to create the root in.
 * @param {number} [options.scale] - the file-count multiplier, `>0..10`.
 * @returns {{root: string, files: Set<string>, directories: Set<string>, cases: object[]}} the owned fixture.
 */
export function createToolFixtures({ parent, scale = 1 }) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) throw new Error('scale must be > 0 and <= 10')
  const root = fs.mkdtempSync(path.join(parent, 'dsh-ops-file-bench-'))
  const owned = { root, files: new Set(), directories: new Set([root]), cases: [] }
  const mkdir = directory => {
    if (owned.directories.has(directory)) return
    mkdir(path.dirname(directory))
    fs.mkdirSync(directory)
    owned.directories.add(directory)
  }
  const write = (relative, data) => {
    const file = path.join(root, relative)
    mkdir(path.dirname(file))
    fs.writeFileSync(file, data, { flag: 'wx' })
    owned.files.add(file)
  }
  const count = n => Math.max(1, Math.round(n * scale))
  const add = (fixture, id, tool, args, extra = {}) => owned.cases.push({ fixture, id, tool, args: { path: path.join(root, fixture), ...args }, ...extra })
  let seed = SEED
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  try {
    for (const fixture of ['small-files', 'deep-tree']) {
      for (let i = 0; i < count(10000); i++) {
        const content = Buffer.alloc(4096, 97 + random() % 26)
        content[4095] = 10
        const branch = `d${String(Math.floor(i / 100)).padStart(3, '0')}`
        const directory = fixture === 'deep-tree' ? [...Array(31).fill('d'), branch].join('/') : branch
        write(`${fixture}/${directory}/f${String(i).padStart(5, '0')}.txt`, content)
      }
    }
    for (let i = 0; i < count(100); i++) {
      for (const excluded of ['node_modules', '.hidden', 'target', '.venv']) {
        write(`small-files/d${String(i).padStart(3, '0')}/${excluded}/excluded.txt`, 'needle\n')
      }
    }
    add('small-files', 'grep-miss', 'grep', { pattern: 'BENCH_NEVER_PRESENT_87', outputMode: 'summary' })
    add('small-files', 'glob', 'glob', { pattern: ['**/*.txt', '!**/absent/**'], outputMode: 'paths', sort: 'path', limit: 100 })
    add('deep-tree', 'grep-miss', 'grep', { pattern: 'BENCH_NEVER_PRESENT_87', outputMode: 'summary' })

    write('big-file/large.txt', Buffer.alloc(33 * 1024 * 1024, 120))
    for (let i = 0; i < 4; i++) write(`big-file/small-${i}.txt`, 'ordinary text\nneedle\n')
    add('big-file', 'grep', 'grep', { pattern: 'needle', outputMode: 'summary' })
    add('big-file', 'inspect-oversize', 'inspect_local_file', { path: path.join(root, 'big-file/large.txt'), view: 'hex', offset: 1, limit: 2 }, { expectedError: 'OUTPUT_LIMIT' })
    // An accepted file is also necessary: rejecting 33 MiB alone cannot measure hex window reads.
    write('big-file/window.txt', Buffer.alloc(8 * 1024 * 1024, 65))
    add('big-file', 'inspect-window', 'inspect_local_file', { path: path.join(root, 'big-file/window.txt'), view: 'hex', offset: 1, limit: 2 })

    for (let i = 0; i < count(200); i++) write(`dense-hits/f${String(i).padStart(4, '0')}.txt`, 'needle needle 中文\n'.repeat(256))
    for (const outputMode of ['summary', 'count', 'content']) add('dense-hits', outputMode, 'grep', { pattern: 'needle', outputMode, limit: 10 })
    add('dense-hits', 'content-offset', 'grep', { pattern: 'needle', outputMode: 'content', offset: 128, limit: 10, beforeContext: 1, afterContext: 1 })

    write('edge-text/long.txt', 'needle ' + 'x'.repeat(1024 * 1024 - 7) + '\n')
    write('edge-text/unicode.txt', '\uFEFFneedle 中文 "引号" \\ \t \u0000\r\nneedle 第二行\r\n')
    write('edge-text/invalid.txt', Buffer.concat([Buffer.from('needle\n'), Buffer.from([0xff])]))
    write('edge-text/boundary.txt', 'x'.repeat(4095) + '中文 needle\n')
    for (const [id, file] of [['long-line', 'long.txt'], ['unicode', 'unicode.txt'], ['invalid-utf8', 'invalid.txt'], ['utf8-boundary', 'boundary.txt']]) {
      add('edge-text', id, 'grep', { path: path.join(root, 'edge-text', file), pattern: 'needle', outputMode: 'content', limit: 1 })
    }
    return owned
  } catch (error) {
    cleanupOwned(owned)
    throw error
  }
}

/**
 * Remove exactly the paths {@link createToolFixtures} created.
 *
 * The whole tree is inventoried first and any unexpected file, directory or link
 * aborts the cleanup with the fixture left intact, so a benchmark can never
 * delete a user's data that happened to land in its root.
 * @param {{root: string, files: Set<string>, directories: Set<string>}} owned - the owned fixture.
 * @returns {void}
 */
export function cleanupOwned(owned) {
  const files = [], directories = []
  const inventory = directory => {
    if (!owned.directories.has(directory) || fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Unexpected directory during cleanup: ${directory}`)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) inventory(target)
      else if (entry.isFile() && owned.files.has(target)) files.push(target)
      else throw new Error(`Unexpected file during cleanup; leaving fixture intact: ${target}`)
    }
    directories.push(directory)
  }
  inventory(owned.root) // Verify the whole inventory before deleting anything.
  for (const file of files) fs.unlinkSync(file)
  for (const directory of directories) fs.rmdirSync(directory)
}

/**
 * Run the tool-level comparison against the default corpus.
 *
 * @param {object} options - {@link compareFiles} inputs, plus:
 * @param {{root: string, cases: object[]}} [options.corpus] - a prebuilt corpus.
 *   When given, its fixtures are the caller's to clean up; when omitted, the
 *   default corpus is created here and removed afterwards either way.
 * @returns {Promise<{report: object, output: string, exitCode: number}>} the run result.
 */
export async function runTools(options = {}) {
  const { corpus: injected = null, tempDir = os.tmpdir(), scale = 1 } = options
  const corpus = injected ?? createToolFixtures({ parent: path.resolve(tempDir), scale })
  try {
    return await compareFiles({ ...options, tempDir, scale, seed: SEED, corpus })
  } finally {
    if (!injected) cleanupOwned(corpus)
  }
}

/** The flag names `bench tools` accepts — #103's names, unchanged. */
const TOOLS_FLAGS = {
  '--baseline': 'baseline',
  '--candidate': 'candidate',
  '--out': 'out',
  '--temp-dir': 'tempDir',
  '--scale': 'scale',
  '--timeout-ms': 'timeoutMs',
}

/** The `bench tools` help text. */
export const TOOLS_USAGE = [
  'usage: node bench/cli.mjs tools --baseline <worker> --candidate <worker> --out <report.json>',
  '                                  [--temp-dir <dir>] [--scale <n>] [--timeout-ms <ms>]',
  '',
  'Model-free, deterministic comparison of two worker binaries over the fixed size-boundary',
  'corpus. The verdict is MATCH / EXPECTED_DIFFERENCE / EXPECTED_REJECTION / MISMATCH /',
  'UNSTABLE: timings are printed as evidence and never asserted. The report is created',
  'exclusively, so a rerun cannot overwrite evidence — delete it or choose another --out.',
].join('\n')

/**
 * Parse `bench tools` argv. Unknown flags and missing values are usage errors, not crashes.
 * @param {string[]} argv - the arguments after the subcommand name.
 * @returns {{help: boolean, baseline: string|null, candidate: string|null, out: string|null, tempDir: string|null, scale: number|null, timeoutMs: number|null}} the parsed options.
 */
export function parseToolsArgs(argv) {
  const options = { help: false, baseline: null, candidate: null, out: null, tempDir: null, scale: null, timeoutMs: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') { options.help = true; continue }
    const key = TOOLS_FLAGS[flag]
    if (!key) throw new Error(`unknown flag "${flag}"`)
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`this flag needs a value: ${flag}`)
    if (key === 'scale' || key === 'timeoutMs') {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`${flag} needs a number, got ${value}`)
      options[key] = parsed
    } else options[key] = value
    index += 1
  }
  if (options.help) return options
  for (const [key, flag] of [['baseline', '--baseline'], ['candidate', '--candidate'], ['out', '--out']]) {
    if (options[key] === null) throw new Error(`${flag} is required`)
  }
  return options
}

/**
 * The `bench tools` entry: flags and exit code here, the comparison in {@link runTools}.
 * @param {string[]} argv - the arguments after `tools`.
 * @param {object} [io] - `out`/`err`/`table` sinks; defaults to the console.
 * @returns {Promise<number>} 0 when every case matched, 1 on a mismatch or a failure, 2 on usage.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? (line => console.log(line))
  const err = io.err ?? (line => console.error(line))
  let options
  try {
    options = parseToolsArgs(argv)
  } catch (error) {
    err(`bench tools: ${String(error?.message ?? error)}`)
    err('run "node bench/cli.mjs tools --help" for usage')
    return 2
  }
  if (options.help) {
    out(TOOLS_USAGE)
    return 0
  }
  try {
    const result = await runTools({
      baseline: options.baseline,
      candidate: options.candidate,
      out: options.out,
      ...(options.tempDir === null ? {} : { tempDir: options.tempDir }),
      ...(options.scale === null ? {} : { scale: options.scale }),
      ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs }),
      io: { out, err, table: io.table ?? (rows => console.table(rows)) },
    })
    // `compareFiles` already announces the report path through `io.out`; printing it here
    // again would put the same line on the console twice.
    return Number.isInteger(result.exitCode) ? result.exitCode : 1
  } catch (error) {
    err(`bench tools: ${String(error?.message ?? error)}`)
    return 1
  }
}
