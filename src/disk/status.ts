/**
 * The read-only `disk status` report: resolve every registered resource
 * family, measure it without following links, and explain what is reclaimable
 * and what is being retained on purpose.
 *
 * The report never deletes anything. `reclaimableBytes` only names bytes a
 * future cleanup could take *with ownership evidence*; today only the Windows
 * Bash IPC cache (R8) has that evidence model, so every other renewable family
 * reports 0 with the reason it is blocked.
 *
 * @module dsh-ops/disk/status
 */
import os from 'node:os'
import path from 'node:path'
import { dshHome } from '../paths.js'
import { bashIpcReport } from '../bash-ipc.js'
import { DEFAULT_DISK_CONFIG, RESOURCES } from './ownership.js'
import type { DiskConfig, DiskContext, ReclaimBlocked, ReclaimEvidence } from './ownership.js'
import { combineMeasures, measureFamily, measureTree } from './measure.js'
import type { Measure, MeasureSkip } from './measure.js'

/** Stable schema tag; a reader must reject a tag it does not know. */
export const DISK_STATUS_SCHEMA = 'dsh-ops/disk-status@1'

/** Inputs of one report; every path is injectable so a fixture can be measured. */
export interface DiskStatusOptions {
  home?: string
  tempRoot?: string
  workspace?: string
  platform?: NodeJS.Platform
  config?: DiskConfig
  now?: () => number
  bashFile?: string
}

/** One resource row of the report. */
export interface DiskResourceReport {
  id: string
  name: string
  category: string
  owner: string
  action: string
  cleanupEntry: string | null
  description: string
  paths: string[]
  samples: string[]
  bytes: number
  files: number
  count: number
  ageMs: number | null
  reclaimableBytes: number
  reclaimBlocked: ReclaimBlocked | null
  truncated: boolean
  skippedCount: number
  skipped: MeasureSkip[]
}

/** Report totals over top-level resources only (nested rows are excluded). */
export interface DiskTotals {
  resources: number
  bytes: number
  files: number
  count: number
  reclaimableBytes: number
  byCategory: Record<string, number>
}

/** The whole report, stable under `--json`. */
export interface DiskStatusReport {
  schema: string
  generatedAt: string
  platform: string
  home: string
  tempRoot: string
  workspace: string
  config: DiskConfig
  resources: DiskResourceReport[]
  totals: DiskTotals
  notes: string[]
}

const CATEGORIES = ['renewable', 'diagnostic', 'user-artifact', 'host-owned'] as const

/**
 * The one resource with a real evidence model today: the Windows Bash IPC cache
 * keeps a managed marker plus leases, so its inventory can name reclaimable
 * generations. Every other family stays at 0 with the static reason on its row.
 */
function bashIpcReclaim(ctx: DiskContext): ReclaimEvidence {
  try {
    const inventory = bashIpcReport(ctx.bashFile, { home: ctx.home })
    if (inventory.current === null) {
      return { reclaimableBytes: 0, blocked: {
        reason: 'current-generation-unknown',
        evidence: 'no resolved confined Bash runtime on this host; every generation is retained',
      } }
    }
    if (inventory.reclaimableBytes === 0) {
      return { reclaimableBytes: 0, blocked: {
        reason: 'nothing-reclaimable',
        evidence: 'the current generation and one retained predecessor are kept by design',
      } }
    }
    return { reclaimableBytes: inventory.reclaimableBytes, blocked: null }
  } catch (error) {
    return { reclaimableBytes: 0, blocked: {
      reason: 'inventory-unavailable',
      evidence: 'the Bash IPC inventory could not be read: ' + (error instanceof Error ? error.message : String(error)),
    } }
  }
}

function emptyMeasure(): Measure {
  return { bytes: 0, files: 0, count: 0, ageMs: null, samples: [], skipped: [], skippedCount: 0, truncated: false, buckets: {} }
}

/** Measure one target: a tree, or the matching children of a family. */
function measureTarget(target: { path: string; match?: RegExp; buckets?: Readonly<Record<string, RegExp>>; boundary: string }, options: { now: () => number; maxEntries: number }): Measure {
  const measured = target.match !== undefined
    ? measureFamily(target.path, target.match, { ...options, boundary: target.boundary, ...(target.buckets ? { buckets: target.buckets } : {}) })
    : measureTree(target.path, { ...options, boundary: target.boundary })
  if (target.match === undefined && target.buckets !== undefined) {
    for (const [key, pattern] of Object.entries(target.buckets)) {
      measured.buckets[key] = measureFamily(target.path, pattern, { ...options, boundary: target.boundary })
    }
  }
  return measured
}

/**
 * Build the read-only report.
 * @param options - resolved paths and configuration (injectable for tests).
 * @returns the report value.
 */
export function diskStatus(options: DiskStatusOptions = {}): DiskStatusReport {
  const now = options.now ?? Date.now
  const home = path.resolve(options.home ?? dshHome())
  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir())
  const workspace = path.resolve(options.workspace ?? process.cwd())
  const config = options.config ?? DEFAULT_DISK_CONFIG
  const platform = options.platform ?? process.platform
  const ctx: DiskContext = { home, tempRoot, workspace, platform, config, ...(options.bashFile === undefined ? {} : { bashFile: options.bashFile }) }
  const measured = new Map<string, Measure>()
  const targetsByResource = new Map<string, string[]>()
  const rows: DiskResourceReport[] = []
  for (const spec of RESOURCES) {
    if (spec.nested !== undefined) continue
    const targets = spec.resolve(ctx)
    const parts = targets.map((target) => measureTarget(target, { now, maxEntries: config.status.maxEntries }))
    const combined = parts.length === 1 ? parts[0]! : combineMeasures(parts)
    measured.set(spec.id, combined)
    targetsByResource.set(spec.id, targets.map((target) => target.path))
  }
  for (const spec of RESOURCES) {
    let source: Measure
    let paths: string[]
    if (spec.nested !== undefined) {
      const parent = measured.get(spec.nested.parent) ?? emptyMeasure()
      source = parent.buckets[spec.nested.bucket] ?? emptyMeasure()
      paths = targetsByResource.get(spec.nested.parent) ?? []
    } else {
      source = measured.get(spec.id) ?? emptyMeasure()
      paths = targetsByResource.get(spec.id) ?? []
    }
    const reclaim = spec.nested === undefined && spec.id === 'R8'
      ? bashIpcReclaim(ctx)
      : { reclaimableBytes: 0, blocked: spec.blocked ?? null }
    rows.push({
      id: spec.id, name: spec.name, category: spec.category, owner: spec.owner,
      action: spec.action, cleanupEntry: spec.cleanupEntry, description: spec.description,
      paths, samples: source.samples, bytes: source.bytes, files: source.files, count: source.count,
      ageMs: source.ageMs, reclaimableBytes: reclaim.reclaimableBytes, reclaimBlocked: reclaim.blocked,
      truncated: source.truncated, skippedCount: source.skippedCount, skipped: source.skipped,
    })
  }
  const top = rows.filter((row) => RESOURCES.find((spec) => spec.id === row.id)?.nested === undefined)
  const byCategory: Record<string, number> = {}
  for (const category of CATEGORIES) byCategory[category] = 0
  for (const row of top) byCategory[row.category] = (byCategory[row.category] ?? 0) + row.bytes
  return {
    schema: DISK_STATUS_SCHEMA,
    generatedAt: new Date(now()).toISOString(),
    platform,
    home, tempRoot, workspace, config,
    resources: rows,
    totals: {
      resources: top.length,
      bytes: top.reduce((sum, row) => sum + row.bytes, 0),
      files: top.reduce((sum, row) => sum + row.files, 0),
      count: top.reduce((sum, row) => sum + row.count, 0),
      reclaimableBytes: top.reduce((sum, row) => sum + row.reclaimableBytes, 0),
      byCategory,
    },
    notes: [
      'read-only: disk status creates, deletes and renames nothing',
      'nested rows (R3, R4, R11) are counted inside their parent and excluded from totals',
      'host-owned R7 is reported only; this plugin never cleans another provider',
      'retention keys are a validated contract only; this release does not evict anything',
    ],
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B'
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return (value < 10 ? value.toFixed(1) : String(Math.round(value))) + ' ' + units[unit]!
}

function humanAge(ageMs: number | null): string {
  if (ageMs === null) return '-'
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 60) return String(minutes) + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return String(hours) + 'h'
  return String(Math.floor(hours / 24)) + 'd'
}

/**
 * Render one report for a human operator.
 * @param report - the report value.
 * @returns the text to print.
 */
export function renderDiskStatus(report: DiskStatusReport): string {
  const lines: string[] = []
  lines.push('dsh-ops disk status - read-only report; nothing was created or deleted')
  lines.push('  home:      ' + report.home)
  lines.push('  tempRoot:  ' + report.tempRoot)
  lines.push('  workspace: ' + report.workspace)
  lines.push('  limits:    maxEntries=' + report.config.status.maxEntries
    + ' includeRepository=' + report.config.status.includeRepository
    + ' retention=' + (report.config.retention.enabled ? 'enabled' : 'disabled'))
  lines.push('')
  lines.push(pad('id', 5) + pad('resource', 34) + pad('category', 14) + pad('owner', 22) + pad('action', 17) + pad('count', 7) + pad('files', 7) + pad('bytes', 11) + pad('oldest', 8) + 'reclaimable')
  for (const row of report.resources) {
    const partial = row.truncated || row.skippedCount > 0
    const state = partial ? ' (partial)' : row.count === 0 ? ' (missing)' : ''
    lines.push(pad(row.id, 5) + pad(row.name, 34) + pad(row.category, 14) + pad(row.owner, 22)
      + pad(row.action, 17) + pad(String(row.count), 7) + pad(String(row.files), 7)
      + pad(humanBytes(row.bytes), 11) + pad(humanAge(row.ageMs), 8) + humanBytes(row.reclaimableBytes) + state)
    if (partial) {
      lines.push('      measurement: truncated=' + row.truncated + ' skipped=' + row.skippedCount)
      for (const skip of row.skipped) {
        lines.push('      skipped: ' + skip.reason + (skip.code ? ' (' + skip.code + ')' : '') + ' - ' + skip.path)
      }
      if (row.skippedCount > row.skipped.length) lines.push('      skipped: ' + (row.skippedCount - row.skipped.length) + ' additional entries not shown')
    }
    if (row.reclaimBlocked !== null && row.count > 0) {
      lines.push('      retained: ' + row.reclaimBlocked.reason + ' - ' + row.reclaimBlocked.evidence)
    }
    if (!row.cleanupEntry) continue
    lines.push('      cleanup:  ' + row.cleanupEntry)
  }
  lines.push('')
  const partial = report.resources.some((row) => row.truncated || row.skippedCount > 0)
  lines.push('totals' + (partial ? ' (partial; measured bytes only)' : '') + ': ' + humanBytes(report.totals.bytes) + ' in ' + String(report.totals.files) + ' files across '
    + String(report.totals.count) + ' items; reclaimable now: ' + humanBytes(report.totals.reclaimableBytes))
  lines.push('categories: ' + CATEGORIES.map((category) => category + '=' + humanBytes(report.totals.byCategory[category] ?? 0)).join(' '))
  for (const note of report.notes) lines.push('note: ' + note)
  return lines.join('\n')
}
