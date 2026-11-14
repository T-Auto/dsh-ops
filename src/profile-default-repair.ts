/**
 * Clear a default agent preset that still names `ops-ptc` after the plugin left the profile.
 *
 * `global.forceDefaultOpsPtc` persists `selectedDefault: ops-ptc` on the
 * `agent-preset-registry` row of the profile patch. The row teardown gives it back,
 * but a removal that stops the profile first, runs without HMR, or happens while the
 * application is closed never reaches that teardown. The host resolves the default as
 * `selectedDefault ?? default` without checking that the preset exists, so the leftover
 * makes every new session fail with `Unknown agent preset: ops-ptc` (#881).
 *
 * Only the `selectedDefault: ops-ptc` line (and a directly preceding `config:` that
 * becomes childless) is removed: rows and comments are never deleted. Any other shape
 * that still names `ops-ptc` is left untouched and reported as `'unrecognized'`.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The profile row whose volatile `selectedDefault` names the default preset. */
const REGISTRY_ID = 'agent-preset-registry'
/** The preset this package registers at runtime and the leftover it may leave. */
const PRESET_ID = 'ops-ptc'

/** Optional YAML trailing comment; `#` must be preceded by whitespace. */
const TRAILING_COMMENT = '(?:\\s+#.*)?\\s*$'
/** One top-level sequence item: `- id: agent-preset-registry`, possibly quoted. */
const REGISTRY_ITEM = new RegExp(`^-\\s+id:\\s*(['"]?)${REGISTRY_ID}\\1${TRAILING_COMMENT}`, 'u')
/** A sibling `id:` line of a top-level item whose first key is something else. */
const REGISTRY_ID_LINE = new RegExp(`^\\s+id:\\s*(['"]?)${REGISTRY_ID}\\1${TRAILING_COMMENT}`, 'u')
const CONFIG_LINE = new RegExp(`^(\\s+)config:${TRAILING_COMMENT}`, 'u')
const SELECTED_LEFTOVER = new RegExp(`^(\\s+)selectedDefault:\\s*(['"]?)${PRESET_ID}\\2${TRAILING_COMMENT}`, 'u')
const STANDALONE_PRESET = new RegExp(`(?:^|[\\s'"[:,{])${PRESET_ID}(?=$|[\\s'"\\]},])`, 'u')

/** Outcome of inspecting and repairing a profile patch. */
export type DefaultRepairStatus = 'clean' | 'repaired' | 'unpaired' | 'unrecognized'

/** What one repair found. */
export interface DefaultRepair {
  /** The profile patch inspected. */
  readonly file: string
  /** Three-state outcome: `'clean'`, `'repaired'`, or `'unrecognized'`. */
  readonly status: 'clean' | 'repaired' | 'unrecognized'
  /** A `selectedDefault: ops-ptc` leftover was found on the registry row. */
  readonly dangling: boolean
  /** The leftover was removed on disk. */
  readonly changed: boolean
}

/** Leading spaces of one line. */
function indentOf(line: string): number {
  return /^ */u.exec(line)![0].length
}

/** Strip a YAML comment from one line when `#` is at line start or after whitespace. */
function stripComment(line: string): string {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('#')) return ''
  return line.replace(/\s+#.*$/u, '')
}

/** Whether non-comment lines still carry an unrecognized `ops-ptc` selection. */
function hasUnrecognizedLeftover(lines: readonly string[]): boolean {
  const active = lines.map(stripComment).filter(line => line.trim() !== '')
  const mentionsPreset = active.some(line => STANDALONE_PRESET.test(line))
  if (!mentionsPreset) return false
  return active.some(line => /\bselectedDefault\b|\bagent-preset-registry\b/u.test(line))
}

/**
 * Locate the leftover in one profile patch text across all `agent-preset-registry` rows.
 *
 * Only deletes `selectedDefault: ops-ptc` at the first indentation level under `config:`
 * (plus `config:` itself when it sits directly above and has no other children).
 * Never deletes a row and never touches comments.
 * @param text - the `cordis.patch.yml` contents.
 * @returns the 0-based line indexes to remove, ascending; empty when there is none.
 */
export function findDanglingDefault(text: string): number[] {
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = clean.split(/\r?\n/u)
  const topLevel = (line: string) => /^-(?:\s|$)/u.test(line)
  const remove: number[] = []
  let start = 0
  while (start < lines.length) {
    let end = start + 1
    while (end < lines.length && !topLevel(lines[end]!)) end += 1
    if (topLevel(lines[start]!)) {
      const item = lines.slice(start, end)
      const itemKeyIndent = /^-\s+/u.exec(item[0]!)?.[0].length ?? 2
      const isRegistry = REGISTRY_ITEM.test(item[0]!)
        || item.slice(1).some(line => indentOf(line) === itemKeyIndent && REGISTRY_ID_LINE.test(line))
      if (isRegistry) {
        let index = 1
        while (index < item.length) {
          const configMatch = CONFIG_LINE.exec(item[index]!)
          if (configMatch === null || configMatch[1]!.length !== itemKeyIndent) {
            index += 1
            continue
          }
          const configIndex = index
          const configIndent = configMatch[1]!.length
          let configEnd = configIndex + 1
          while (configEnd < item.length) {
            const candidate = item[configEnd]!
            if (candidate.trim() !== '' && !candidate.trim().startsWith('#') && indentOf(candidate) <= configIndent) break
            configEnd += 1
          }
          let childIndent = -1
          for (let cursor = configIndex + 1; cursor < configEnd; cursor += 1) {
            const candidate = item[cursor]!
            if (candidate.trim() === '' || candidate.trim().startsWith('#')) continue
            childIndent = indentOf(candidate)
            break
          }
          if (childIndent > configIndent) {
            const matchedInConfig: number[] = []
            for (let cursor = configIndex + 1; cursor < configEnd; cursor += 1) {
              const selected = SELECTED_LEFTOVER.exec(item[cursor]!)
              if (selected !== null && selected[1]!.length === childIndent) {
                matchedInConfig.push(cursor)
              }
            }
            if (matchedInConfig.length > 0) {
              const matchedSet = new Set(matchedInConfig)
              const hasOtherContent = item.slice(configIndex + 1, configEnd).some((candidate, offset) => {
                if (matchedSet.has(configIndex + 1 + offset)) return false
                if (candidate.trim() === '') return false
                return indentOf(candidate) > configIndent
              })
              if (!hasOtherContent && matchedInConfig[0] === configIndex + 1) {
                remove.push(start + configIndex)
              }
              for (const cursor of matchedInConfig) remove.push(start + cursor)
            }
          }
          index = configEnd
        }
      }
    }
    start = end
  }
  return remove
}

/**
 * Remove a dangling `selectedDefault: ops-ptc` from one profile's patch.
 * @param profileDir - the profile directory holding `cordis.patch.yml`.
 * @param warn - warning sink for unrecognized shapes or held profile locks.
 * @returns what was found and whether the file changed; a missing patch is clean.
 */
export function repairDanglingDefault(
  profileDir: string,
  warn: (message: string) => void = message => console.warn(message),
): DefaultRepair {
  const file = path.join(profileDir, 'cordis.patch.yml')
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, status: 'clean', dangling: false, changed: false }
    throw error
  }
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text
  const remove = findDanglingDefault(clean)
  const dropped = new Set(remove)
  const lines = clean.split(/\r?\n/u).filter((_, index) => !dropped.has(index))
  if (hasUnrecognizedLeftover(lines)) {
    warn(`dsh-ops: cannot clear selectedDefault: ${PRESET_ID} in ${file}: unrecognized patch shape; edit cordis.patch.yml manually if new sessions fail.`)
    return { file, status: 'unrecognized', dangling: true, changed: false }
  }
  if (remove.length === 0) return { file, status: 'clean', dangling: false, changed: false }
  const lockFile = path.join(profileDir, 'package.json.lock')
  if (fs.existsSync(lockFile)) {
    warn(`dsh-ops: skipping cordis.patch.yml repair in ${profileDir}: ${lockFile} is present.`)
    return { file, status: 'unrecognized', dangling: true, changed: false }
  }
  const newline = clean.includes('\r\n') ? '\r\n' : '\n'
  const mode = fs.statSync(file).mode & 0o777
  const temporary = `${file}.dsh-ops-${process.pid}.tmp`
  fs.writeFileSync(temporary, lines.join(newline), { mode })
  fs.renameSync(temporary, file)
  return { file, status: 'repaired', dangling: true, changed: true }
}
