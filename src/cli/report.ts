/**
 * Operator reporting for the `dsh-ops` CLI: the managed directories the
 * commands share, the `--config` row reader, and the read-only `ladder`
 * report of what this deployment resolves and which rungs the prompt ladder
 * actually renders.
 *
 * Split out of `bin/dsh-ops.mjs`; the command's argv surface, output and exit
 * codes are unchanged.
 *
 * @module dsh-ops/cli/report
 */

import fs from 'node:fs'
import { errorMessage } from '../shells/types.js'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE_ROOT, dshHome } from '../paths.js'
import { resolveConfig } from '../config.js'
import type { ResolvedConfig } from '../config.js'
import type { ShellResolution } from '../shells.js'
import {
  BASH_TOOL,
  FILE_TOOLS,
  ladderLevels,
  publicToolName,
  renderToolingPolicy,
} from '../policy.js'
import { resolveWorker } from '../execution/runtime.js'
import { bashIpcReport, restrictedCompatibility } from '../bash-ipc.js'
import type { BashIpcInventory } from '../bash-ipc.js'
import { resolveShells } from '../shells.js'

type WorkerReport = { resolved: true; executable: string; source: string; error: null }
  | { resolved: false; executable: null; source: null; error: string }
interface ShellReport { available: boolean; executable: string | null; source: string; detail: string; restricted?: { compatible: boolean; reason: string } | null }
interface LadderReport { worker: WorkerReport; shells: Record<'bash' | 'pwsh', ShellReport>; bashIpc: BashIpcInventory; policy: string }

/**
 * The unit `uninstall` removes: `<DSH_HOME>/dsh-ops`, holding what older
 * versions installed outside the profile (the former FastCtx runtime under
 * `bin/` with its `runtime.json`) and the shells `provision-shells` installed.
 * @returns {string} the absolute directory.
 */
export function managedDir() {
  return path.join(dshHome(), 'dsh-ops')
}

/**
 * The per-user state directory the removed FastCtx background backend used.
 *
 * FastCtx resolved this from the environment the host process received —
 * `~/.fastctx`, holding `config.toml` and the background-job registry under
 * `jobs/`. This version never creates or reads it; `uninstall` only reports it,
 * and removes it when the operator asks (`--purge-fastctx`), so leftovers from
 * an older version can be cleaned up. Another FastCtx install may still own it.
 * @returns {string} the absolute directory.
 */
export function fastctxDataDir() {
  return path.join(os.homedir(), '.fastctx')
}
/**
 * Read the `dsh-ops` row config a report should describe.
 *
 * The commands here are run outside a profile, so there is no loader to ask:
 * `--config` names a JSON file holding the row's own `config` object, and the
 * keys are the ones the row accepts. Passing it through `resolveConfig` is what
 * keeps this report and the plugin's mount answering the same question — an
 * unknown key fails here exactly as it would fail activation.
 * @param {string|undefined} file - the `--config` path, when one was given.
 * @returns {unknown} the raw row config.
 * @throws {Error} when the file cannot be read, does not parse, or is not an object.
 */
export function readRowConfig(file: string | undefined): Record<string, unknown> {
  if (file === undefined) return {}
  const resolved = path.resolve(file)
  let text
  try {
    text = fs.readFileSync(resolved, 'utf8')
  } catch (error) {
    throw new Error(`--config does not name a readable file: ${resolved} (${errorMessage(error)})`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`--config must hold one JSON object (the \`dsh-ops\` row's config): ${errorMessage(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`--config must hold one JSON object (the \`dsh-ops\` row's config), got ${typeof value}`)
  }
  return value as Record<string, unknown>
}

/**
 * The native worker resolution as a report value — the same `resolveWorker` the
 * file component runs at mount, including the packaged runtime's provenance
 * check. Nothing is spawned; the resolver's own error text explains a miss.
 * @param {import('../config.js').ResolvedConfig} config - the plugin configuration.
 * @returns {{resolved: boolean, executable: string|null, source: string|null, error: string|null}} the report value.
 */
export function workerReport(config: ResolvedConfig): WorkerReport {
  try {
    const file = resolveWorker(config)
    const source = config.binaryPath !== undefined ? 'config.binaryPath'
      : process.env.DSH_OPS_WORKER_BIN !== undefined ? 'DSH_OPS_WORKER_BIN'
        : path.relative(PACKAGE_ROOT, file).split(path.sep)[0] === 'runtime' ? 'packaged runtime' : 'source-tree build'
    return { resolved: true, executable: file, source, error: null }
  } catch (error) {
    return { resolved: false, executable: null, source: null, error: errorMessage(error) }
  }
}

/**
 * One shell rung as a report value: `executable` is null exactly when the rung
 * is unavailable, and `detail` is the resolver's own reason either way.
 * @param {import('../shells.js').ShellResolution} resolution - the rung's resolution.
 * @returns {{available: boolean, executable: string|null, source: string, detail: string}} the report value.
 */
export function shellReport(resolution: ShellResolution): ShellReport {
  return {
    available: resolution.available === true,
    executable: resolution.file ?? null,
    source: resolution.source,
    detail: resolution.detail,
  }
}

/**
 * Whether read-only / workspace-write sessions can run the resolved bash: they
 * accept only the pinned MSYS the IPC proxies were verified against (#42).
 * @param {import('../shells.js').ShellResolution} resolution - the bash rung.
 * @returns {{compatible: boolean, reason: string}|null} null when there is no bash to check.
 */
export function restrictedReport(resolution: ShellResolution) {
  if (resolution.available !== true || typeof resolution.file !== 'string') return null
  try {
    const { compatible, reason } = restrictedCompatibility(resolution.file)
    return { compatible, reason }
  } catch (error) {
    return { compatible: false, reason: errorMessage(error) }
  }
}

/**
 * The rungs this deployment can reach, from the same derivation the plugin's
 * prompt uses.
 *
 * The plugin asks the live registry; this command has no registry, so it
 * answers from resolution instead: a resolved native worker stands in for the
 * published file tools, and a resolved bash stands in for the published
 * `ops_bash` tool (which also needs the host's `subprocess` service).
 * `ladderLevels` still decides, so the rungs and their numbering come from the
 * renderer that ships them rather than from a second copy here.
 * @param {object} options - the ladder input.
 * @param {{resolved: boolean}} options.worker - the native worker report value.
 * @param {{bash: {available: boolean}, pwsh: {available: boolean}}} options.shells - the shell resolutions.
 * @param {import('../config.js').ResolvedConfig} options.config - the plugin configuration.
 * @returns {import('../policy.js').LadderLevels} the rungs.
 */
export function ladderFor({ worker, shells, config }: { worker: { resolved: boolean }; shells: { bash: { available: boolean }; pwsh: { available: boolean } }; config: ResolvedConfig }) {
  const published = worker.resolved ? FILE_TOOLS.map(publicToolName) : []
  if (config.publishBashTool && shells.bash.available) published.push(BASH_TOOL)
  if (shells.pwsh.available) published.push('pwsh')
  return ladderLevels({ published, pwsh: shells.pwsh.available })
}

/**
 * The `## Rung …` headings of a rendered ladder, as numbered titles.
 * @param {string} text - the rendered tooling section.
 * @returns {{number: number, title: string}[]} one entry per rendered rung, in render order.
 */
export function renderedRungs(text: string) {
  const rungs = []
  for (const line of text.split('\n')) {
    const match = /^## Rung (\d+) — (.*)$/u.exec(line)
    if (match !== null) rungs.push({ number: Number(match[1]), title: match[2] })
  }
  return rungs
}

/**
 * Print one ladder report for a human.
 * @param {object} report - the report value `commandLadder` assembled.
 * @returns {void}
 */
export function printLadder(report: LadderReport) {
  console.log('Native worker (file tools)')
  if (report.worker.resolved) {
    console.log(`  executable: ${report.worker.executable}`)
    console.log(`  source:     ${report.worker.source}`)
  } else {
    console.log('  executable: missing')
    for (const line of report.worker.error.split('\n')) console.log(`  ${line}`)
  }

  console.log('\nShell rungs (lib/shells.js resolveShells)')
  for (const kind of ['bash', 'pwsh'] as const) {
    const rung = report.shells[kind]
    console.log(`  ${kind}`)
    console.log(`    available:  ${rung.available ? 'yes' : 'no'}`)
    console.log(`    executable: ${rung.executable ?? 'missing'}`)
    console.log(`    source:     ${rung.source}`)
    console.log(`    detail:     ${rung.detail}`)
    if (rung.restricted) {
      console.log(`    restricted: ${rung.restricted.compatible ? 'yes' : 'no'} (${rung.restricted.reason})`)
    }
  }

  const megabytes = (bytes: number) => (bytes / 1048576).toFixed(0)
  console.log('\nBash IPC runtime cache (Windows confined calls only)')
  console.log(`  root:        ${report.bashIpc.root}`)
  console.log(`  current:     ${report.bashIpc.current ?? 'not resolved on this host'}`)
  console.log(`  generations: ${report.bashIpc.generations} (${megabytes(report.bashIpc.totalBytes)} MB in this cache)`)
  if (report.bashIpc.entries.length > 0) {
    const quarantined = report.bashIpc.entries.filter((entry) => entry.kind === 'quarantine').length
    const suffix = quarantined > 0 ? ` + ${quarantined} quarantined generation(s)` : ''
    console.log(`  reclaimable: ${megabytes(report.bashIpc.reclaimableBytes)} MB${suffix} — the next confined Windows Bash call reclaims it`)
  }

  console.log('\nRouting: repository tools → bash → host PowerShell')
  console.log(report.policy || '(no file tools resolved)')
  console.log('\nResolution only: command visibility requires a live host session and sandboxPolicy.')
  console.log('Resolved candidates only; bash also needs the host subprocess service. Full access runs the executable directly;')
  console.log('read-only / workspace-write additionally require the pinned MSYS (see "restricted"), so a custom bashPath works only in full access. Nothing is spawned.')
}

/**
 * `ladder`: report what this deployment resolves and which rungs the model is
 * actually told it can reach — the three questions a missing bundled shell
 * would otherwise need a fresh session to answer.
 *
 * Nothing is spawned. Missing rungs are the report,
 * not a failure, so the exit code is 0 whenever a report was produced and 1 only
 * for a config this command cannot honour.
 * @param {object} options - ladder inputs.
 * @param {boolean} options.json - print the machine-readable report instead of the human one.
 * @param {string|undefined} options.configFile - the `--config` path, when one was given.
 * @returns {number} the exit code.
 */
export function commandLadder({ json, configFile }: { json: boolean; configFile?: string }) {
  let config
  try {
    config = resolveConfig(readRowConfig(configFile))
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }

  const worker = workerReport(config)
  const shells = resolveShells(config)
  const levels = ladderFor({ worker, shells, config })
  const report = {
    worker,
    shells: { bash: { ...shellReport(shells.bash), restricted: restrictedReport(shells.bash) }, pwsh: shellReport(shells.pwsh) },
    bashIpc: bashIpcReport(shells.bash.available ? shells.bash.file : undefined),
    levels,
    rungs: [],
    policy: renderToolingPolicy({
      published: [
        ...(worker.resolved ? FILE_TOOLS.map(publicToolName) : []),
        ...(levels.bash ? [BASH_TOOL] : []),
        ...(levels.pwsh ? ['pwsh'] : []),
      ],
      extraGuidance: config.extraGuidance,
    }),
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }
  printLadder(report)
  return 0
}
