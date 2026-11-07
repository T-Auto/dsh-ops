/**
 * Ownership registry for every disk resource the OPS plugin creates.
 *
 * The registry is data, not policy: it names each resource family, where it
 * lives, who owns it, which category it belongs to and which cleanup entry (if
 * any) may reclaim it. `dsh-ops disk status` measures it read-only; this module
 * never creates, deletes or renames anything.
 *
 * Ids R1-R13 follow the cross-cutting report on issue #714
 * (`_ops-work/issue-714/05-ownership-gc.md`); R9b splits the ACL backups out of
 * the installed-shells row because the two have different default actions.
 *
 * @module dsh-ops/disk/ownership
 */
import path from 'node:path'
import { ConfigError } from '../config-error.js'
import type { MeasureTarget } from './measure.js'

/** What the resource is, in the retention vocabulary of issue #723. */
export type DiskCategory = 'renewable' | 'diagnostic' | 'user-artifact' | 'host-owned'

/** The default action for the resource; `disk status` performs none of them. */
export type DiskAction = 'report-only' | 'explicit-command' | 'never-touch'

/** Who owns the resource, so a reader never mistakes a shared tree for OPS state. */
export type DiskOwner = 'dsh-ops' | 'session' | 'workspace' | 'host-subprocess-local' | 'repository-tooling'

/** A reason a renewable resource cannot be reclaimed yet. */
export interface ReclaimBlocked {
  reason: string
  evidence: string
}

/** The reclaim judgement for one resource. */
export interface ReclaimEvidence {
  reclaimableBytes: number
  blocked: ReclaimBlocked | null
}

/** The environment one report resolves its paths in. Injected for tests. */
export interface DiskContext {
  home: string
  tempRoot: string
  workspace: string
  platform: NodeJS.Platform
  config: DiskConfig
  bashFile?: string
}

/** Read-only status limits. */
export interface DiskStatusConfig {
  includeRepository: boolean
  maxEntries: number
}

/** Reserved retention contract; this release only validates and reports it. */
export interface DiskRetentionConfig {
  enabled: boolean
  maxAgeDays: number
  maxBytes: number
}

/** The `disk` row section. */
export interface DiskConfig {
  status: DiskStatusConfig
  retention: DiskRetentionConfig
}

/** Shipped defaults; keep `cordis.patch.yml` equal to these values. */
export const DEFAULT_DISK_CONFIG: DiskConfig = Object.freeze({
  status: Object.freeze({ includeRepository: false, maxEntries: 5000 }),
  retention: Object.freeze({ enabled: false, maxAgeDays: 0, maxBytes: 0 }),
})

const STATUS_KEYS = ['includeRepository', 'maxEntries']
const RETENTION_KEYS = ['enabled', 'maxAgeDays', 'maxBytes']

function rejectKeys(raw: Record<string, unknown>, known: readonly string[], prefix: string): void {
  const unknown = Object.keys(raw).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new ConfigError(`unknown key(s) ${unknown.map((key) => JSON.stringify(`${prefix}${key}`)).join(', ')}; accepted keys are ${known.map((key) => JSON.stringify(`${prefix}${key}`)).join(', ')}`)
  }
}

function section(raw: unknown, key: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`disk.${key} must be an object, got ${JSON.stringify(raw)}`)
  }
  return raw as Record<string, unknown>
}

function integer(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number, prefix: string): number {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${prefix}${key} must be an integer from ${min} to ${max}, got ${JSON.stringify(value)}`)
  }
  return value
}

function boolean(raw: Record<string, unknown>, key: string, fallback: boolean, prefix: string): boolean {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new ConfigError(`${prefix}${key} must be a boolean, got ${JSON.stringify(value)}`)
  return value
}

/**
 * Validate the `disk` section, applying every default.
 * @param raw - the raw `disk` value, or undefined for the defaults.
 * @returns the resolved disk configuration.
 * @throws {ConfigError} naming the offending key.
 */
export function resolveDiskConfig(raw?: unknown): DiskConfig {
  if (raw === undefined || raw === null) return DEFAULT_DISK_CONFIG
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`disk must be an object, got ${JSON.stringify(raw)}`)
  }
  const input = raw as Record<string, unknown>
  // The merged row carries a section-level `enabled`; it is accepted and reserved.
  rejectKeys(input, ['enabled', 'status', 'retention'], 'disk.')
  boolean(input, 'enabled', true, 'disk.')
  const status = section(input.status, 'status')
  rejectKeys(status, STATUS_KEYS, 'disk.status.')
  const retention = section(input.retention, 'retention')
  rejectKeys(retention, RETENTION_KEYS, 'disk.retention.')
  return {
    status: {
      includeRepository: boolean(status, 'includeRepository', false, 'disk.status.'),
      maxEntries: integer(status, 'maxEntries', 5000, 1, 100_000, 'disk.status.'),
    },
    retention: {
      enabled: boolean(retention, 'enabled', false, 'disk.retention.'),
      maxAgeDays: integer(retention, 'maxAgeDays', 0, 0, 3650, 'disk.retention.'),
      maxBytes: integer(retention, 'maxBytes', 0, 0, Number.MAX_SAFE_INTEGER, 'disk.retention.'),
    },
  }
}

/** One resource family in the registry. */
export interface ResourceSpec {
  id: string
  name: string
  category: DiskCategory
  owner: DiskOwner
  action: DiskAction
  cleanupEntry: string | null
  description: string
  nested?: { parent: string; bucket: string }
  resolve(ctx: DiskContext): MeasureTarget[]
  blocked?: ReclaimBlocked
}

const TRUSTED_AUTHORITY: ReclaimBlocked = {
  reason: 'authority-bound-purge',
  evidence: 'only a live session dispose may purge, under the sandbox authority that created the cache',
}

/**
 * Every resource family the plugin writes. Order is report order; nested rows
 * follow their parent. R13 is included only when `disk.status.includeRepository`
 * is on, because repository gate scratch is not part of a user install.
 */
export const RESOURCES: readonly ResourceSpec[] = Object.freeze([
  {
    id: 'R1', name: 'niubash-execution-copies', category: 'renewable', owner: 'dsh-ops',
    action: 'report-only', cleanupEntry: null,
    description: 'Per-call Niubash execution copies, removed by the call that created them.',
    blocked: {
      reason: 'no-orphan-registry',
      evidence: 'an execution copy carries no liveness receipt; a crashed host leaves no cross-restart owner',
    },
    resolve: (ctx: DiskContext) => [{
      path: ctx.tempRoot, match: /^dsh-ops-niu-exec-[A-Za-z0-9]{6}$/, boundary: ctx.tempRoot,
    }],
  },
  {
    id: 'R2', name: 'result-cache-roots', category: 'renewable', owner: 'dsh-ops',
    action: 'report-only', cleanupEntry: null,
    description: 'Per-session result cache roots under the OS temporary directory.',
    blocked: TRUSTED_AUTHORITY,
    resolve: (ctx: DiskContext) => [{
      path: ctx.tempRoot, match: /^dsh-ops-results-[a-f0-9]{64}$/, boundary: ctx.tempRoot,
      buckets: { snapshots: /^s-[a-f0-9]{64}$/, audit: /^\.dsh-ops$/ },
    }],
  },
  {
    id: 'R3', name: 'result-snapshots', category: 'renewable', owner: 'dsh-ops',
    action: 'report-only', cleanupEntry: null,
    description: 'Result snapshots nested inside the result cache roots.',
    nested: { parent: 'R2', bucket: 'snapshots' },
    blocked: TRUSTED_AUTHORITY,
    resolve: () => [],
  },
  {
    id: 'R4', name: 'batch-audit-stores', category: 'diagnostic', owner: 'dsh-ops',
    action: 'never-touch', cleanupEntry: null,
    description: 'Batch job audit stores: the only record of operation facts.',
    nested: { parent: 'R2', bucket: 'audit' },
    blocked: {
      reason: 'audit-record',
      evidence: 'audit generations are the only durable record of batch operation facts',
    },
    resolve: () => [],
  },
  {
    id: 'R5', name: 'session-temporary-directories', category: 'user-artifact', owner: 'session',
    action: 'never-touch', cleanupEntry: null,
    description: 'Per-session temporary directories that hold user/model work.',
    blocked: {
      reason: 'user-content',
      evidence: 'the plugin deliberately never deletes these directories; a later call may still expect them',
    },
    resolve: (ctx: DiskContext) => [{
      path: ctx.tempRoot, match: /^dsh-ops-session-[a-f0-9]{16}$/, boundary: ctx.tempRoot,
    }],
  },
  {
    id: 'R6', name: 'panel-capture', category: 'diagnostic', owner: 'workspace',
    action: 'never-touch', cleanupEntry: null,
    description: 'Panel capture reports written into the session workspace.',
    blocked: {
      reason: 'workspace-artifact',
      evidence: 'capture documents can hold conversation and tool text; the operator prunes them explicitly',
    },
    resolve: (ctx: DiskContext) => {
      // Same ownership rule as the collector: never report a capture directory
      // inside the DSH home, and never name a relative workspace.
      const relative = path.relative(ctx.home, ctx.workspace)
      const insideHome = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
      if (insideHome) return []
      return [{ path: path.join(ctx.workspace, '.dsh-ops', 'panel'), boundary: ctx.workspace }]
      return []
    },
  },
  {
    id: 'R7', name: 'host-subprocess-spill', category: 'host-owned', owner: 'host-subprocess-local',
    action: 'report-only', cleanupEntry: null,
    description: 'Host subprocess spill directories; not owned by this plugin.',
    blocked: {
      reason: 'host-owned',
      evidence: 'the host subprocess provider retains completed spill files until its own cleanup',
    },
    resolve: (ctx: DiskContext) => [{
      path: ctx.tempRoot, match: /^dsh-subprocess-/, boundary: ctx.tempRoot,
    }],
  },
  {
    id: 'R8', name: 'bash-ipc-generations', category: 'renewable', owner: 'dsh-ops',
    action: 'explicit-command', cleanupEntry: 'dsh-ops bash-runtime clean-cache --yes --all-hosts-stopped',
    description: 'Private confined-Bash runtime generations under the DSH home.',
    blocked: {
      reason: 'current-generation-unknown',
      evidence: 'the Bash IPC inventory decides what is reclaimable; clean-cache is the only reclaim entry',
    },
    resolve: (ctx: DiskContext) => {
      const managed = path.join(ctx.home, 'dsh-ops')
      return [{ path: path.join(managed, 'bash-ipc'), boundary: managed }]
    },
  },
  {
    id: 'R9', name: 'installed-shells', category: 'renewable', owner: 'dsh-ops',
    action: 'explicit-command', cleanupEntry: 'dsh-ops bash-runtime remove --yes',
    description: 'Receipt-owned shell payloads provisioned under the DSH home.',
    blocked: {
      reason: 'explicit-operator-command',
      evidence: 'remove only the receipt-owned copies listed by dsh-ops bash-runtime remove --dry-run',
    },
    resolve: (ctx: DiskContext) => {
      const managed = path.join(ctx.home, 'dsh-ops')
      return [{ path: path.join(managed, 'shells'), boundary: managed, buckets: { swap: /^niubash\.(?:stage|previous)-/ } }]
    },
  },
  {
    id: 'R11', name: 'niubash-payload-swap', category: 'renewable', owner: 'dsh-ops',
    action: 'report-only', cleanupEntry: null,
    description: 'Staging and previous Niubash payload siblings from an interrupted swap.',
    nested: { parent: 'R9', bucket: 'swap' },
    blocked: {
      reason: 'owner-process-unknown',
      evidence: 'a rollback may still need these siblings; no process proof is recorded',
    },
    resolve: () => [],
  },
  {
    id: 'R9b', name: 'workspace-acl-backups', category: 'diagnostic', owner: 'dsh-ops',
    action: 'never-touch', cleanupEntry: null,
    description: 'Workspace ACL backup receipts used to roll preparation back.',
    blocked: {
      reason: 'acl-backup',
      evidence: 'these receipts are the recovery evidence for workspace ACL preparation',
    },
    resolve: (ctx: DiskContext) => {
      const managed = path.join(ctx.home, 'dsh-ops')
      return [{ path: path.join(managed, 'acl-backups'), boundary: managed }]
    },
  },
  {
    id: 'R10', name: 'provision-download-scratch', category: 'renewable', owner: 'dsh-ops',
    action: 'report-only', cleanupEntry: null,
    description: 'Provisioning download scratch; failed downloads are kept for diagnosis.',
    blocked: {
      reason: 'owner-process-unknown',
      evidence: 'a failed download is kept for diagnosis and carries no process proof',
    },
    resolve: (ctx: DiskContext) => [{
      path: ctx.tempRoot, match: /^dsh-ops-(?:bash|pwsh|niubash)-[A-Za-z0-9]{6}$/, boundary: ctx.tempRoot,
    }],
  },
  {
    id: 'R12', name: 'review-probe-scratch', category: 'renewable', owner: 'dsh-ops',
    action: 'report-only', cleanupEntry: null,
    description: 'Isolated merge-probe repositories of dsh-ops review snapshot.',
    blocked: {
      reason: 'owner-process-unknown',
      evidence: 'the probe removes its scratch in finally; a crash leaves no ownership receipt',
    },
    resolve: (ctx: DiskContext) => [{
      path: ctx.tempRoot, match: /^dsh-ops-review-[A-Za-z0-9]{6}$/, boundary: ctx.tempRoot,
    }],
  },
  {
    id: 'R13', name: 'repository-gate-scratch', category: 'renewable', owner: 'repository-tooling',
    action: 'report-only', cleanupEntry: null,
    description: 'Repository gate and packaging scratch; not shipped plugin state.',
    blocked: {
      reason: 'repository-tooling',
      evidence: 'created by repository gate scripts, not by the shipped plugin',
    },
    resolve: (ctx: DiskContext) => (ctx.config.status.includeRepository ? [
      { path: ctx.tempRoot, match: /^dsh-ops-(?:gate|pack|legacy-bash-fixture)-[A-Za-z0-9]{6}$/, boundary: ctx.tempRoot },
      { path: ctx.tempRoot, match: /^ops-ipc-build-[A-Za-z0-9]{6}$/, boundary: ctx.tempRoot },
    ] : []),
  },
])
