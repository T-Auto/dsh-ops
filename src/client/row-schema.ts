/**
 * The single row's page, exactly as the maintainer specified it.
 *
 * Two bundle switches, four switches per preset, and one card for the three
 * opt-in features. Every switch is addressed by a path (`[section, key]`) so the
 * three opt-in switches can share one card while still writing their own section.
 */
import type { SettingsPathOpView } from '../adapter/dsh/types.js'
import type { Translator } from './locales.js'

/** A key of the OPS locale namespace. */
export type LocaleKey = Parameters<Translator>[0]

/** One editable switch. */
export interface FieldSpec {
  readonly path: readonly [string, string]
  readonly label: LocaleKey
  readonly hint?: LocaleKey
  /** Bundle switch that must be on for this field to apply. */
  readonly gatedBy?: BundleGate
}

/** One bundle switch name, for the page's gating hints. */
export type BundleGate = 'bash' | 'hidePwsh' | 'hideOfficialTools' | 'dynamicTools'

/** One page group. */
export interface GroupSpec {
  readonly id: string
  readonly label: LocaleKey
  readonly hint?: LocaleKey
  /** Groups with a toggle carry their own enable switch as `[id, enabled]`. */
  readonly toggle: boolean
  readonly fields: readonly FieldSpec[]
}

/** The row id the single bundle row declares. */
export const ROW_ID = 'dsh-ops'

/** Draft values, keyed by `section.key`. */
export type RowDraft = Record<string, boolean>

const at = (section: string, key: string): readonly [string, string] => [section, key]
const field = (path: readonly [string, string], label: LocaleKey, hint?: LocaleKey, gatedBy?: BundleGate): FieldSpec =>
  ({ path, label, hint, ...(gatedBy === undefined ? {} : { gatedBy }) })

/** The two bundle switches. */
export const GLOBAL: readonly FieldSpec[] = Object.freeze([
  field(at('global', 'bash'), 'swBash', 'globalBashHint'),
  field(at('global', 'hidePwsh'), 'swHidePwsh', 'globalHidePwshHint'),
  field(at('global', 'hideOfficialTools'), 'hideOfficialTools', 'hideOfficialToolsHint'),
  field(at('global', 'dynamicTools'), 'dynamicTools', 'dynamicToolsHint'),
])

/** The four preset switches, identical in every mode. */
const MODE_FIELDS = (section: string, resident: boolean): readonly FieldSpec[] => Object.freeze([
  field(at(section, 'bash'), 'swBash', 'swBashHint', 'bash'),
  field(at(section, 'hidePwsh'), 'swHidePwsh', 'swHidePwshHint', 'hidePwsh'),
  field(at(section, 'hideOfficialTools'), 'hideOfficialTools', 'swHideOfficialToolsHint', 'hideOfficialTools'),
  ...(resident ? [field(at(section, 'residentTools'), 'swResidentTools', 'swResidentToolsHint')] : []),
  field(at(section, 'dynamicTools'), 'dynamicTools', 'swDynamicToolsHint', 'dynamicTools'),
])

const modeGroup = (id: string, label: LocaleKey, hint: LocaleKey, resident: boolean): GroupSpec =>
  ({ id, label, hint, toggle: true, fields: MODE_FIELDS(id, resident) })

/** Every group, in page order. */
export const GROUPS: readonly GroupSpec[] = Object.freeze([
  { id: 'global', label: 'groupGlobal', hint: 'groupGlobalHint', toggle: false, fields: GLOBAL },
  modeGroup('minimal', 'featureMinimal', 'featureMinimalHint', false),
  modeGroup('standard', 'featureStandard', 'featureStandardHint', true),
  modeGroup('ptc', 'featurePtc', 'featurePtcHint', true),
  modeGroup('cordis', 'featureCordis', 'featureCordisHint', true),
  // The three opt-in features share one card: separate cards for one switch each
  // read as three empty shells next to the presets.
  { id: 'other', label: 'groupOther', hint: 'groupOtherHint', toggle: false, fields: Object.freeze([
    field(at('panel', 'enabled'), 'featurePanel', 'featurePanelHint'),
    field(at('tui', 'enabled'), 'featureTui', 'featureTuiHint'),
    field(at('other', 'pwsh7Link'), 'featurePwsh7Link', 'featurePwsh7LinkHint'),
  ]) },
])

/** What a switch runs with when it is absent. */
const DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({
  'global.bash': true, 'global.hidePwsh': true, 'global.hideOfficialTools': true, 'global.dynamicTools': true,
  'minimal.enabled': true, 'minimal.bash': true, 'minimal.hidePwsh': true, 'minimal.hideOfficialTools': true, 'minimal.dynamicTools': true,
  'standard.enabled': true, 'standard.residentTools': true, 'standard.bash': true, 'standard.hidePwsh': true, 'standard.hideOfficialTools': true, 'standard.dynamicTools': true,
  'ptc.enabled': true, 'ptc.residentTools': true, 'ptc.bash': true, 'ptc.hidePwsh': true, 'ptc.hideOfficialTools': true, 'ptc.dynamicTools': true,
  'cordis.enabled': true, 'cordis.residentTools': true, 'cordis.bash': true, 'cordis.hidePwsh': true, 'cordis.hideOfficialTools': true, 'cordis.dynamicTools': true,
  'panel.enabled': false, 'tui.enabled': false, 'other.pwsh7Link': false,
})

/** The draft key of one switch. */
export const flatKey = (path: readonly [string, string]): string => `${path[0]}.${path[1]}`

/**
 * Read the page values out of the raw saved config.
 * @param raw - the host-provided saved values.
 * @returns one value per switch.
 */
export function readRowValues(raw: Record<string, unknown>, options: { pwsh7Installed?: boolean } = {}): RowDraft {
  const draft: RowDraft = {}
  const section = (id: string): Record<string, unknown> => {
    const value = raw[id]
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  const read = (path: readonly [string, string]): boolean => {
    const value = section(path[0])[path[1]]
    if (typeof value === 'boolean') return value
    // The link follows detection until the operator sets it explicitly.
    if (path[0] === 'other' && path[1] === 'pwsh7Link' && options.pwsh7Installed === true) return true
    return DEFAULTS[`${path[0]}.${path[1]}`] ?? true
  }
  for (const group of GROUPS) {
    // A group's own switch lives in its section; a shared card's switches each
    // read their own section (panel/tui sit together in the "other" card).
    if (group.toggle) draft[`${group.id}.enabled`] = read([group.id, 'enabled'])
    for (const spec of group.fields) draft[flatKey(spec.path)] = read(spec.path)
  }
  return draft
}

/**
 * The bundle switches as the draft holds them.
 * @param draft - the current page values.
 * @returns the gate each preset's gated switches are checked against.
 */
export function bundleGates(draft: RowDraft): Record<BundleGate, boolean> {
  return {
    bash: draft['global.bash'] !== false,
    hidePwsh: draft['global.hidePwsh'] !== false,
    hideOfficialTools: draft['global.hideOfficialTools'] !== false,
    dynamicTools: draft['global.dynamicTools'] !== false,
  }
}

/**
 * The nested write operations that turn the saved values into the draft.
 * @param draft - the current page values.
 * @param raw - the saved values the draft was read from.
 * @returns path operations for `form.mutate`.
 */
export function changedFields(draft: RowDraft, raw: Record<string, unknown>): SettingsPathOpView[] {
  const baseline = readRowValues(raw)
  const operations: SettingsPathOpView[] = []
  for (const group of GROUPS) {
    const paths = group.toggle
      ? [at(group.id, 'enabled'), ...group.fields.map(spec => spec.path)]
      : group.fields.map(spec => spec.path)
    for (const path of paths) {
      const flat = flatKey(path)
      if (draft[flat] === baseline[flat]) continue
      operations.push({ op: 'set', path: [path[0], path[1]], value: draft[flat] })
    }
  }
  return operations
}
