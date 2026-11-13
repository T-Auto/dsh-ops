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
 * Only that one line is removed: the registry then falls back to its own `default`,
 * exactly as if the operator had never chosen. Any other shape is left untouched and
 * reported, never guessed at.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The profile row whose volatile `selectedDefault` names the default preset. */
const REGISTRY_ID = 'agent-preset-registry'
/** The preset this package registers at runtime and the leftover it may leave. */
const PRESET_ID = 'ops-ptc'

/** One top-level sequence item: `- id: agent-preset-registry`, possibly quoted. */
const REGISTRY_ITEM = new RegExp(`^-\\s+id:\\s*(['"]?)${REGISTRY_ID}\\1\\s*(?:#.*)?$`, 'u')
/** A nested `id:` line of a top-level item whose first key is something else. */
const REGISTRY_ID_LINE = new RegExp(`^\\s+id:\\s*(['"]?)${REGISTRY_ID}\\1\\s*(?:#.*)?$`, 'u')
const SELECTED_LEFTOVER = new RegExp(`^(\\s+)selectedDefault:\\s*(['"]?)${PRESET_ID}\\2\\s*(?:#.*)?$`, 'u')
const CONFIG_LINE = /^(\s+)config:\s*(?:#.*)?$/u

/** What one repair found. */
export interface DefaultRepair {
  /** The profile patch inspected. */
  readonly file: string
  /** A `selectedDefault: ops-ptc` line was found on the registry row. */
  readonly dangling: boolean
  /** The line was removed (false for a dry run or when nothing was found). */
  readonly changed: boolean
}

/** Leading spaces of one line. */
function indentOf(line: string): number {
  return /^ */u.exec(line)![0].length
}

/**
 * Locate the leftover in one profile patch text.
 *
 * Mirrors the host config editor: when the selection was the only `config` key the
 * empty `config:` goes too, and a row left with only `id`/`name` is dropped.
 * @param text - the `cordis.patch.yml` contents.
 * @returns the 0-based line indexes to remove, ascending; empty when there is none.
 */
export function findDanglingDefault(text: string): number[] {
  const lines = text.split(/\r?\n/u)
  const topLevel = (line: string) => /^-(?:\s|$)/u.test(line)
  let start = 0
  while (start < lines.length) {
    // Each top-level item starts at column 0 with `- `; the next one ends it.
    let end = start + 1
    while (end < lines.length && !topLevel(lines[end]!)) end += 1
    if (topLevel(lines[start]!)) {
      const item = lines.slice(start, end)
      const isRegistry = REGISTRY_ITEM.test(item[0]!) || item.slice(1).some(line => REGISTRY_ID_LINE.test(line))
      if (isRegistry) {
        let config = -1
        for (let index = 1; index < item.length; index += 1) {
          const line = item[index]!
          if (CONFIG_LINE.test(line)) { config = index; continue }
          const selected = SELECTED_LEFTOVER.exec(line)
          // Only a key nested directly under `config:` is the registry selection.
          if (selected === null || config < 0 || selected[1]!.length <= indentOf(item[config]!)) continue
          const children = item.slice(config + 1).filter((child, offset) => config + 1 + offset !== index
            && child.trim() !== '' && !child.trim().startsWith('#'))
            .filter(child => indentOf(child) > indentOf(item[config]!))
          if (children.length > 0) return [start + index]
          const rest = item.filter((other, offset) => offset !== 0 && offset !== config && offset !== index
            && other.trim() !== '' && !other.trim().startsWith('#'))
          const onlyIdentity = rest.every(other => /^\s+(?:id|name):/u.test(other)) && /^-\s+(?:id|name):/u.test(item[0]!)
          if (onlyIdentity) return Array.from({ length: end - start }, (_, offset) => start + offset)
          return [start + config, start + index]
        }
      }
    }
    start = end
  }
  return []
}

/**
 * Remove a dangling `selectedDefault: ops-ptc` from one profile's patch.
 * @param profileDir - the profile directory holding `cordis.patch.yml`.
 * @param options - `dryRun` reports without writing.
 * @returns what was found and whether the file changed; a missing patch is clean.
 */
export function repairDanglingDefault(profileDir: string, { dryRun = false }: { dryRun?: boolean } = {}): DefaultRepair {
  const file = path.join(profileDir, 'cordis.patch.yml')
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, dangling: false, changed: false }
    throw error
  }
  const remove = findDanglingDefault(text)
  if (remove.length === 0) return { file, dangling: false, changed: false }
  if (dryRun) return { file, dangling: true, changed: false }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const dropped = new Set(remove)
  const lines = text.split(/\r?\n/u).filter((_, index) => !dropped.has(index))
  // The host config editor requires a top-level YAML sequence; when the removed
  // entry was the only item, leave an empty sequence behind any header comments.
  if (!lines.some(line => /^-(?:\s|$)|^\s*\[/u.test(line))) {
    if (lines.length > 0 && lines.at(-1) === '') lines.splice(lines.length - 1, 0, '[]')
    else lines.push('[]', '')
  }
  const mode = fs.statSync(file).mode & 0o777
  // Write beside the target and rename, so a crash never leaves a half-written profile.
  const temporary = `${file}.dsh-ops-${process.pid}.tmp`
  fs.writeFileSync(temporary, lines.join(newline), { mode })
  fs.renameSync(temporary, file)
  return { file, dangling: true, changed: true }
}
