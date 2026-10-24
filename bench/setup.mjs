#!/usr/bin/env node
/**
 * The `setup` entry point: the self-checks first, then the two profiles — one command, one
 * exit code.
 *
 * `setup/preflight.mjs` answers whether a sweep could mean anything (the permission
 * combination, `PSModulePath`, the local build the candidate executes) and
 * `setup/profile.mjs` does the idempotent preparation itself (the overlay, both profiles,
 * the shell pin, the permission pin, the candidate install, the `--dump-config` read-back).
 * This module is only the order and the verdict: it runs the preflight, refuses before
 * touching a profile when a check failed, otherwise hands the pair to `prepareProfiles` and
 * prints the one command that runs the sweep.
 *
 * Failing before the preparation is deliberate: a broken build or a permission combination
 * that would measure the modes is not something a profile rewrite repairs, and setting up
 * profiles behind a fixable refusal would only make the next run's message harder to read.
 * Everything the preflight found is reported in one pass, so one run names every fix.
 *
 * `main(argv, io)` returns its exit code and never calls `process.exit`, because `bench/cli.mjs`
 * calls it and owns the process; every path it writes comes from `--dsh-home`/`io`, so a test
 * runs against a temporary home and a temporary checkout and never the real `~/.dsh`.
 *
 * @module dsh-ops/bench/setup
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { REPO_ROOT, resolveDshEntry, spawnPlan } from './lib/env.mjs'
import { USAGE as PROFILE_USAGE, dshHomeFor, nextStepLines, parseArgs, prepareProfiles, spawnInvoker } from './setup/profile.mjs'
import { EXTRA_FLAGS, USAGE_EXTRA, closingLines, preflight } from './setup/preflight.mjs'
import { SWITCH_USAGE, extractSwitches, configureSwitches } from './setup/switches.mjs'

/** Exit codes: 0 prepared, 1 a check or a step failed, 2 usage. `bench/cli.mjs`'s own
 * `EXIT.pending` (3) never applies here — this module exists, so `setup` is implemented. */
export const EXIT = { ok: 0, failure: 1, usage: 2 }

/** The whole help: `profile.mjs`'s flags plus setup B's own. */
export const USAGE = `${PROFILE_USAGE}\n${USAGE_EXTRA}\n${SWITCH_USAGE}`

/**
 * The injectable half of `main`. `bench/cli.mjs` passes `{out, err}`; a suite passes the
 * rest so nothing real is spawned, installed or written.
 * @typedef {object} SetupIo
 * @property {(line: string) => void} [out] - stdout sink (default `console.log`).
 * @property {(line: string) => void} [err] - stderr sink (default `console.error`).
 * @property {Record<string, string|undefined>} [env] - the environment to read (default `process.env`).
 * @property {string} [platform] - the target platform (default the host).
 * @property {string} [arch] - the target architecture (default the host).
 * @property {string} [repoRoot] - the checkout `local` installs and the build check reads.
 * @property {{file: string, kind: 'js'|'exe', notes?: string[]}} [entry] - the resolved dsh
 *   launcher, bypassing `resolveDshEntry` (and the npm lookup it may do).
 * @property {(args: string[]) => {status: number|null, stdout: string, stderr: string, errorCode: string|null}} [invoke]
 *   - how dsh is run (default `spawnInvoker` over the resolved entry).
 * @property {(target: string) => {status: number|null, stdout: string, stderr: string, errorCode: string|null}} [runGate]
 *   - the canonical `bin/native-runtime.mjs check` (default spawns it).
 * @property {(file: string) => boolean} [isDirectory] - the module-directory probe the
 *   `PSModulePath` check uses.
 * @property {string} [overlay] - the filled-in LLM overlay (default `bench/llm.patch.yml`).
 * @property {string} [overlayExample] - the committed template (default the `.example.yml`).
 */

/**
 * Prepare the two bench profiles after their preflight, and return the exit code.
 * @param {string[]} argv - arguments after the command name.
 * @param {SetupIo} [io] - the output sinks and the injectable collaborators.
 * @returns {Promise<number>} 0 prepared (or only planned under `--dry-run`), 1 a preflight
 *   check or a preparation step failed, 2 a usage error.
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  let options, switches
  try {
    const extracted = extractSwitches(argv)
    switches = extracted.switches
    options = parseArgs(extracted.argv, { ...EXTRA_FLAGS, platform: io.platform })
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`)
    return EXIT.usage
  }
  if (options.help) { out(USAGE); return EXIT.ok }

  const env = io.env ?? process.env
  const platform = io.platform ?? process.platform
  const arch = io.arch ?? process.arch
  const root = io.repoRoot ?? REPO_ROOT
  // profile.mjs closes its own narration with a two-line "next" block (the sweep, then its
  // --show variant). setup owns the closing presentation and the contract is ONE command, so
  // that block is filtered out here — through the function that produces it, not by matching
  // words — and replaced by preflight's single-line hint below.
  const replaced = new Set(['\n— next —', ...nextStepLines(options)])
  const log = (line) => { if (!replaced.has(line)) out(line) }
  const home = dshHomeFor(options, { env })

  log(`DSH_HOME: ${home}`)
  log(`node ${process.version}, ${platform}-${arch}${options.dryRun ? ', [--dry-run] plan only' : ''}`)

  const checks = preflight(options, { home, env, platform, arch, root, log, runGate: io.runGate, isDirectory: io.isDirectory })
  if (checks.problems.length > 0) {
    for (const warning of checks.warnings) err(`\n*** ${warning}`)
    err(`\npreflight refused: ${checks.problems.join('; ')}`)
    err('nothing was prepared: fix the above and run this command again.')
    return EXIT.failure
  }

  let entry = io.entry
  if (!entry) {
    try { entry = resolveDshEntry(options.dsh, { env, platform }) } catch (error) { err(error.message); return EXIT.failure }
  }
  const plan = spawnPlan(entry)
  log(`dsh entry: ${entry.kind === 'js' ? entry.file : `${entry.file} (exe)`}`)
  if (entry.notes?.length) log(`  found via: ${entry.notes.join('; ')}`)

  const invoke = io.invoke ?? spawnInvoker({
    command: plan.command,
    env: { ...env, ...(options.dshHome ? { DSH_HOME: home } : {}) },
  })
  const prepared = prepareProfiles(options, {
    home, log, invoke, prefix: plan.args,
    dryRun: options.dryRun, template: options.template, repoRoot: root,
    overlay: io.overlay, overlayExample: io.overlayExample,
  })

  for (const warning of [...checks.warnings, ...prepared.warnings]) err(`\n*** ${warning}`)
  if (prepared.problems.length > 0) {
    err(`\nsetup is not finished: ${prepared.problems.join('; ')}`)
    return EXIT.failure
  }
  try { configureSwitches(options, { home, log, invoke, prefix: plan.args, overlay: io.overlay }, switches) }
  catch (error) { err(`component switches: ${error.message}`); return EXIT.failure }
  out('\n— next —')
  for (const line of closingLines(options)) out(line)
  out(options.dryRun ? '\n[dry-run] everything above is a plan; nothing was changed.' : '\nsetup complete.')
  return EXIT.ok
}

// Only when executed, not when `bench/cli.mjs` imports it.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
