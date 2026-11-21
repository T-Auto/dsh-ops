/**
 * The host support boundary this package declares: engines.dsh in package.json
 * names the floor, and activation time is where an older host must hear it (#701).
 *
 * A host below the floor used to load anyway and fail later - TypeError scope
 * errors backstage, EXECUTOR_UNAVAILABLE in front. The host's own behaviour
 * while loading an unsupported plugin remains upstream; what this package owns
 * is refusing, at activation, in one named diagnosis. A version the host will
 * not reveal can never be proven below the floor, so 'unknown' loads as before.
 */
import fs from 'node:fs'
import type { Context } from './types.js'
import { runtimeVersion } from './runtime-version.js'

/** One semver triple plus prerelease identifiers; build metadata never affects precedence. */
interface SemVer { major: number; minor: number; patch: number; pre: string[] }

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+)?$/u
const NUMERIC = /^[0-9]+$/u

/** Parse one strict semver; anything else is not a version this check can judge. */
function parseSemVer(value: string): SemVer | undefined {
  const match = SEMVER.exec(value)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] === undefined ? [] : match[4].split('.') }
}

/** Whether left sorts strictly before right under semver precedence rules. */
function precedes(left: SemVer, right: SemVer): boolean {
  if (left.major !== right.major) return left.major < right.major
  if (left.minor !== right.minor) return left.minor < right.minor
  if (left.patch !== right.patch) return left.patch < right.patch
  if (left.pre.length === 0) return false
  if (right.pre.length === 0) return true
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const a = left.pre[index], b = right.pre[index]
    if (a === undefined) return true
    if (b === undefined) return false
    if (a === b) continue
    if (NUMERIC.test(a) && NUMERIC.test(b)) return Number(a) < Number(b)
    if (NUMERIC.test(a)) return true
    if (NUMERIC.test(b)) return false
    return a < b
  }
  return false
}

/**
 * The floor this package declares for its host, from the first lower bound of
 * engines.dsh; undefined when the manifest names no floor, which disables the check.
 * The manifest is read once from the package root beside this module's own tree,
 * so the declared range stays the single source of truth, never a copy.
 * @returns the declared lower bound, or undefined.
 */
export function declaredHostFloor(): string | undefined {
  if (cache === undefined) {
    cache = null
    try {
      const manifest = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { engines?: { dsh?: unknown } }
      const range = manifest.engines?.dsh
      if (typeof range === 'string') cache = range
    } catch { /* An unreadable manifest disables the floor rather than guessing one. */ }
  }
  if (cache === null) return undefined
  const floor = />=\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(cache)
  return floor?.[1]
}

/** One read of the declared engines.dsh range; null marks "no floor declared". */
let cache: string | null | undefined

/**
 * Whether an actual host version sorts strictly below the declared floor.
 * @param {string} actual - the host-reported version.
 * @param {string} floor - the declared lower bound.
 * @returns {boolean} true only when both parse and actual sorts below floor.
 */
export function versionBelowFloor(actual: string, floor: string): boolean {
  const left = parseSemVer(actual), right = parseSemVer(floor)
  return left !== undefined && right !== undefined && precedes(left, right)
}

/**
 * Refuse activation with one named diagnosis when the host is provably older
 * than the declared floor; an unknown version is released, never punished.
 * @param {Context} ctx - the host context the version probe reads.
 * @returns {Promise<void>} resolves when the host is at or above the floor.
 */
export async function assertHostFloor(ctx: Context): Promise<void> {
  const floor = declaredHostFloor()
  if (floor === undefined) return
  const { runtimeVersion: version } = await runtimeVersion(ctx)
  if (version === 'unknown') return
  if (versionBelowFloor(version, floor)) {
    throw new Error(`This dsh-ops build requires DSH ${floor} or newer (package.json engines.dsh); the running host reports ${version}. Upgrade the host runtime instead of reloading this plugin: an older host loads it halfway at best, showing TypeError scope errors backstage and EXECUTOR_UNAVAILABLE in front.`)
  }
}
