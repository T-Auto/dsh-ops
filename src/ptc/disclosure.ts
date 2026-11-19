/** The one first-round disclosure plan; publication and diagnostics read the same derivation. */
import { PTC_RESIDENT_TOOLS } from '../capabilities/registry.js'
import type { ApiName, PtcConfig } from './config.js'

/** The plan one PTC scope publishes before any loader call, derived once from config and gates. */
export interface DisclosurePlan {
  /** Whether the explicit full first-round tier (#979 §2) is active. */
  full: boolean
  /** Names registered for this scope: the resident surface plus the selectable candidates. */
  pool: ApiName[]
  /** Names visible in the first round without any loader call. */
  firstRound: ApiName[]
  /** Whether the `load_sdk` loader is published in this scope. */
  loader: boolean
  /** APIs a loader call may still select, including `result`; empty selection set when the loader is off. */
  loadable: ApiName[]
}

/**
 * Derive the disclosure plan one PTC row publishes.
 *
 * D3 (#987) defined the tiers; D4 (#988) makes the diagnostics read this same
 * derivation instead of guessing expected names, so a selectable-but-unselected
 * API (for example `result` on the on-demand tier) is never a publication gap.
 *
 * @param config - the row's parsed PTC slice.
 * @param resident - whether the consumer grants the resident surface (`residentTools`).
 * @param dynamic - whether the consumer grants progressive loading (`discovery`).
 * @returns the plan; every member of `firstRound` is visible this step, and
 *   `loader` is false exactly when no `load_sdk` is registered.
 */
export function disclosurePlan(config: Pick<PtcConfig, 'allowedTools' | 'alwaysLoaded' | 'disclosurePolicy'>, resident: boolean, dynamic: boolean): DisclosurePlan {
  const full = config.disclosurePolicy === 'full'
  // A residentTools:false scope drops the resident surface entirely, including
  // alwaysLoaded (truth-table row 5); the tier itself survives.
  const residentSet: ApiName[] = resident ? [...PTC_RESIDENT_TOOLS, ...config.alwaysLoaded] : []
  // A loader-less scope can never select the allowed pool: registering it only lets
  // a host that renders registered definitions declare unreachable APIs. The full
  // tier is loader-less by design, so its pool must register.
  const selectable: ApiName[] = dynamic === false && !full ? [] : [...config.allowedTools, 'result']
  const loadable = [...new Set<ApiName>([...config.allowedTools, 'result'])]
  return {
    full,
    pool: [...new Set([...residentSet, ...selectable])],
    firstRound: [...new Set([...residentSet, ...(full ? selectable : [])])],
    loader: dynamic !== false && !full,
    loadable,
  }
}
