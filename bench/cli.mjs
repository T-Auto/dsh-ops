#!/usr/bin/env node
/**
 * The one cross-platform bench entry point — the replacement for `win-ab.bat`.
 *
 * Every path is resolved from this module (any working directory works) and nothing
 * runs through a shell: a `.cmd`/`.ps1` shim cannot be piped, and a shell would
 * re-quote every argument. This file owns parsing, help and exit codes; a subcommand
 * whose slice has not landed exits `3` and names that slice and its future file —
 * never a silent success. Once that file exports `main(argv, io)`, this CLI calls it,
 * so a later slice wires itself in without editing this file.
 *
 * @module dsh-ops/bench/cli
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { REPO_ROOT, platformTag } from './lib/env.mjs'
import { RUNS_DIR, nextFolderName } from './lib/next-folder.mjs'

/** Exit codes, documented in `--help`: the A/B sweep's exit code is its verdict. */
export const EXIT = { ok: 0, failure: 1, usage: 2, pending: 3 }

/** The subcommands, in help order, each with the slice that implements it. */
export const COMMANDS = [
  { name: 'setup', slice: 'P9/P10', target: 'bench/setup.mjs', summary: 'prepare both profiles once, idempotently' },
  { name: 'ab', slice: 'P1 (plan) + P7/P8 + P11 (run)', target: 'bench/run.mjs', summary: 'baseline then candidate then compare, one group folder' },
  { name: 'report', slice: 'P11', target: 'bench/compare.mjs', summary: 'render report.md from a sealed run.json' },
  { name: 'panel', slice: 'P12', target: 'bench/report/panel.mjs', summary: 'write/open panel.html that reads run.json' },
  { name: 'tools', slice: 'P13', target: 'bench/tools/measure.mjs', summary: 'model-free deterministic tool-level comparison' },
]

const AB_FLAGS_WITH_VALUE = ['--task', '--repeat', '--folder', '--base', '--cand']

/** Raised for a malformed command line; carries the message `main` prints. */
export class UsageError extends Error {}

/** The top-level help; `ab --help` carries the sweep's own flag list. */
export function usage() {
  const width = Math.max(...COMMANDS.map((command) => command.name.length))
  return [
    'usage: node bench/cli.mjs <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    `  ${'help'.padEnd(width)}  this text`,
    '',
    'Options: -h, --help · --version',
    `ab options: ${AB_FLAGS_WITH_VALUE.join(' <value> ')} <value> · --show · other flags go to the runner`,
    '',
    'Exit codes: 0 ok · 1 failure · 2 usage error · 3 declared but not implemented in this slice',
  ].join('\n')
}

/** The `ab` help: the sweep's flags, and why the group is allocated once. */
export function abUsage() {
  return [
    'usage: node bench/cli.mjs ab [--task <id>]... [--repeat <N>] [--folder <name>]',
    '                            [--base <label>] [--cand <label>] [--show] [runner flags...]',
    '',
    'Runs the baseline side, the candidate side, then the comparison, all inside ONE',
    'bench/runs/benchmark-test-NN group: the number is allocated once here because a',
    'per-process default would put each side in a different group and leave nothing to pair.',
    'Flag meanings are in `--help`; the group is created by the runner (P7/P8) and the',
    'comparison by P11.',
  ].join('\n')
}

/** Split the `ab` flags from the runner flags; a malformed flag raises `UsageError`. */
export function parseAbArgs(argv) {
  const options = { base: 'bench-base', cand: 'bench-ops', tasks: [], repeat: null, folder: null, show: false, extra: [], help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') options.help = true
    else if (flag === '--show') options.show = true
    else if (AB_FLAGS_WITH_VALUE.includes(flag)) {
      const value = argv[index + 1]
      if (value === undefined || value === '') throw new UsageError(`this flag needs a value: ${flag}`)
      if (flag === '--task') options.tasks.push(value)
      else options[flag.slice(2)] = value
      index += 1
    } else options.extra.push(flag)
  }
  const label = /^[A-Za-z0-9._-]+$/
  if (!label.test(options.base) || !label.test(options.cand)) {
    throw new UsageError('--base/--cand must be simple labels (letters, digits, dot, dash, underscore): they are also profile names')
  }
  if (options.repeat !== null && (!/^\d+$/.test(options.repeat) || Number(options.repeat) === 0)) {
    throw new UsageError(`--repeat needs a positive integer, got ${options.repeat}`)
  }
  if (options.folder !== null && (options.folder.trim() === '' || /[/\\]/.test(options.folder) || options.folder.startsWith('.'))) {
    throw new UsageError(`--folder must be one directory name under bench/runs, got ${options.folder}`)
  }
  return options
}
/** Build the three commands of one sweep. Pure — it allocates the folder but writes nothing. */
export function planAb(argv, options = {}) {
  const { runsDir = RUNS_DIR, repoRoot = REPO_ROOT } = options
  const parsed = parseAbArgs(argv)
  const allocated = parsed.folder === null
  const folder = parsed.folder ?? nextFolderName(runsDir)
  const shared = parsed.tasks.flatMap((task) => ['--task', task])
  if (parsed.repeat !== null) shared.push('--repeat', parsed.repeat)
  shared.push('--folder', folder, ...parsed.extra)
  const commands = [parsed.base, parsed.cand].map((label) => ({
    label,
    target: 'bench/run.mjs',
    args: ['--label', label, '--profile', label, ...shared],
    argv: ['bench/run.mjs', '--label', label, '--profile', label, ...shared],
  }))
  commands.push({ label: 'compare', target: 'bench/compare.mjs', args: [parsed.base, parsed.cand, '--folder', folder], argv: ['bench/compare.mjs', parsed.base, parsed.cand, '--folder', folder] })
  return { ...parsed, folder, allocated, commands, repoRoot }
}
/** Run the sweep, or explain which slice is still missing; every step is a Node script, never a shell. */
export function abMain(argv, io) {
  const plan = io.plan ?? planAb(argv)
  if (plan.help) {
    io.out(abUsage())
    return EXIT.ok
  }
  io.out(`[ab] base   : ${plan.base}`)
  io.out(`[ab] cand   : ${plan.cand}`)
  io.out(`[ab] folder : bench/runs/${plan.folder}${plan.allocated ? ' [auto]' : ''}`)
  io.out(`[ab] tasks  : ${plan.tasks.length > 0 ? plan.tasks.join(' ') : 'full corpus'}`)
  io.out(`[ab] repeat : ${plan.repeat ?? 'per-task budget'}`)
  if (plan.show) {
    io.out('')
    io.out(`[ab] root   : ${plan.repoRoot ?? REPO_ROOT}`)
    for (const command of plan.commands) io.out(`node ${command.argv.join(' ')}`.replace(/\s+/g, ' '))
    return EXIT.ok
  }
  const missing = [...new Set(plan.commands.map((command) => command.target))]
    .filter((target) => !fs.existsSync(path.join(plan.repoRoot ?? REPO_ROOT, target)))
  if (missing.length > 0) {
    io.err(`[ab] not implemented yet — missing: ${missing.join(', ')}. The runner is slice P7/P8 and the comparison P11; this CLI only builds and shows the plan today.`)
    io.err('[ab] run "node bench/cli.mjs ab --show" to see the commands it will run.')
    return EXIT.pending
  }
  for (const [index, command] of plan.commands.entries()) {
    const stage = index === plan.commands.length - 1 ? 'compare' : `${command.label} run`
    io.out(`\n[ab] ${index + 1}/${plan.commands.length} ${stage}: node ${command.argv.join(' ')}`)
    const result = spawnSync(process.execPath, command.argv, { cwd: plan.repoRoot ?? REPO_ROOT, stdio: 'inherit', windowsHide: true })
    if (result.status !== 0) {
      io.err(`[ab] ${stage} failed with exit code ${String(result.status)}`)
      return result.status ?? EXIT.failure
    }
  }
  io.out('\n[ab] compare exit code 0  (gates passed)')
  return EXIT.ok
}
/** Route a subcommand: `ab` here, a later slice's `main(argv, io)`, or a loud "not implemented". */
async function dispatch(command, argv, io) {
  if (command.name === 'ab') return abMain(argv, io)
  const target = path.join(REPO_ROOT, command.target)
  if (fs.existsSync(target)) {
    const module = await import(pathToFileURL(target).href)
    if (typeof module.main !== 'function') {
      io.err(`bench ${command.name}: ${command.target} exists but exports no main(argv, io)`)
      return EXIT.failure
    }
    return (await module.main(argv, io)) ?? EXIT.ok
  }
  io.err(`bench ${command.name}: not implemented in this slice yet (${command.slice}); it will live in ${command.target}`)
  return EXIT.pending
}
/** Run the CLI. */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  const [name, ...rest] = argv
  if (name === undefined || name === 'help' || name === '-h' || name === '--help') {
    out(usage())
    return EXIT.ok
  }
  if (name === '--version') {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    out(`dsh-ops bench ${pkg.version} · ${platformTag()} · node ${process.version}`)
    return EXIT.ok
  }
  const command = COMMANDS.find((entry) => entry.name === name)
  if (!command) {
    err(name.startsWith('-')
      ? `bench: unknown option "${name}"`
      : `bench: unknown command "${name}" (known: ${COMMANDS.map((entry) => entry.name).join(', ')}, help)`)
    err('run "node bench/cli.mjs --help" for usage')
    return EXIT.usage
  }
  try {
    return await dispatch(command, rest, { out, err })
  } catch (error) {
    if (error instanceof UsageError) {
      err(`bench ${name}: ${error.message}`)
      err(`run "node bench/cli.mjs ${name} --help" for usage`)
      return EXIT.usage
    }
    err(`bench ${name}: ${String(error?.stack ?? error)}`)
    return EXIT.failure
  }
}
// Only when executed, not when imported by the suite.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
