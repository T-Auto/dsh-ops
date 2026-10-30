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
  readonly path: readonly string[]
  readonly label: LocaleKey
  readonly hint?: LocaleKey
  /** Bundle switch that must be on for this field to apply. */
  readonly gatedBy?: BundleGate
  readonly disabled?: boolean
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
  readonly labelText?: string
  readonly togglePath?: readonly string[]
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
export const flatKey = (path: readonly string[]): string => path.join('.')

/** What the saved config leaves open, decided by the host rather than by a stored boolean. */
export interface ReadOptions {
  /** Whether the companion plugin is installed; it decides an unsaved link. */
  readonly pwsh7Installed?: boolean
}

/**
 * Read the page values out of the raw saved config.
 * @param raw - the host-provided saved values.
 * @param options - detection inputs the saved values do not carry.
 * @returns one value per switch.
 */
export function groupsFor(raw: Record<string, unknown>): readonly GroupSpec[] {
  const presets = raw.presets && typeof raw.presets === 'object' && !Array.isArray(raw.presets) ? raw.presets as Record<string, unknown> : {}
  const custom = Object.keys(presets).map(id => {
    const options = presets[id] as Record<string, unknown>
    const ptc = (options.presentation ?? (options.profile === 'ptc' ? 'ptc' : 'native')) === 'ptc'
    const spec = (key: string, label: LocaleKey, gatedBy?: BundleGate, disabled = false, hint?: LocaleKey): FieldSpec => ({ path: ['presets', id, key], label, gatedBy, disabled, hint })
    return { id: `presets.${id}`, label: 'customPreset' as const, labelText: id, toggle: true, togglePath: ['presets', id, 'enabled'], fields: [
      spec('files', 'swFiles', undefined, ptc, ptc ? 'ptcFilesRequired' : undefined), spec('residentTools', 'swResidentTools'), spec('shell', 'swBash', 'bash', false, 'shellOffClears'),
      spec('hidePwsh', 'swHidePwsh', 'hidePwsh'), spec('replaceOfficial', 'hideOfficialTools', 'hideOfficialTools'),
      spec('discovery', 'dynamicTools', 'dynamicTools'), spec('promptPolicy', 'swPromptPolicy'),
    ] }
  })
  return [...GROUPS.slice(0, -1), ...custom, GROUPS[GROUPS.length - 1]!]
}

export function readRowValues(raw: Record<string, unknown>, options: ReadOptions = {}): RowDraft {
  const draft: RowDraft = {}
  const section = (id: string): Record<string, unknown> => {
    const value = raw[id]
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  const read = (path: readonly string[]): boolean => {
    let node: unknown = raw
    for (const key of path) node = node && typeof node === 'object' ? Reflect.get(node, key) : undefined
    const value = node
    if (typeof value === 'boolean') return value
    if (path[0] === 'presets') {
      const preset = section('presets')[path[1]!] as Record<string, unknown>
      const profile = preset.profile ?? 'native', key = path[2]
      if (key === 'files') return profile === 'native' || profile === 'ptc'
      if (key === 'shell') return profile === 'shell'
      if (key === 'hidePwsh') return preset.replaceOfficial === true && (preset.shell === true || profile === 'shell')
      if (key === 'replaceOfficial') return false
      if (key === 'discovery') return profile !== 'shell'
      return true
    }
    // The link follows detection until the operator sets it explicitly.
    if (path[0] === 'other' && path[1] === 'pwsh7Link' && options.pwsh7Installed === true) return true
    return DEFAULTS[`${path[0]}.${path[1]}`] ?? true
  }
  for (const group of groupsFor(raw)) {
    if (group.toggle) {
      const path = group.togglePath ?? [group.id, 'enabled']
      draft[flatKey(path)] = read(path)
    }
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
 *
 * The baseline is read with the same detection the draft used. Without that, an
 * unsaved link on an installed companion reads as `false` in the baseline and any
 * save — even of an unrelated switch — writes it as an explicit `true`, freezing
 * a value the operator never touched. With it, an untouched link produces no
 * operation and keeps following detection, while a switch the operator flipped
 * differs from the same baseline and is always written.
 *
 * @param draft - the current page values.
 * @param raw - the saved values the draft was read from.
 * @param options - detection inputs used to read `raw`, as the draft was.
 * @returns path operations for `form.mutate`.
 */
export function changedFields(draft: RowDraft, raw: Record<string, unknown>, options: ReadOptions = {}): SettingsPathOpView[] {
  const baseline = readRowValues(raw, options)
  const operations: SettingsPathOpView[] = []
  for (const group of groupsFor(raw)) {
    const paths = group.toggle
      ? [group.togglePath ?? at(group.id, 'enabled'), ...group.fields.map(spec => spec.path)]
      : group.fields.map(spec => spec.path)
    for (const path of paths) {
      const flat = flatKey(path)
      if (path[0] === 'presets' && path.at(-1) === 'hidePwsh' && draft[flatKey(['presets', path[1]!, 'shell'])] === false) continue
      if (draft[flat] === baseline[flat]) continue
      const spec = group.fields.find(field => field.path === path)
      if (path[0] === 'presets' && path.at(-1) === 'files' && spec?.disabled) continue
      operations.push({ op: 'set', path: [...path], value: draft[flat] })
    }
  }
  return operations
}
