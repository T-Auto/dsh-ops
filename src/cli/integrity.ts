/** CLI-only, read-only Windows image-label evidence; never a runtime health test. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

type Label = 'unlabeled' | 'untrusted' | 'low' | 'medium' | 'high' | 'system' | 'other' | 'unknown'
interface IntegrityEntry { path: string; role: 'image' | 'ancestor'; label: Label; rid: number | null; reason?: string }
export interface IntegrityReport { status: 'complete' | 'partial' | 'not-applicable'; entries: IntegrityEntry[]; warnings: string[] }
interface RawEntry { path?: unknown; sddl?: unknown; error?: unknown }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Parse only a successful LABEL_SECURITY_INFORMATION response; errors are never Medium. */
export function integrityLabel(sddl: string): Pick<IntegrityEntry, 'label' | 'rid'> {
  if (sddl === '' || /^S:(?:P|AI|AR)*(?:NO_ACCESS_CONTROL)?$/.test(sddl)) return { label: 'unlabeled', rid: null }
  const labels = [...sddl.matchAll(/\(ML;[^;]*;[^;]*;[^;]*;[^;]*;([^;)]+)\)/g)]
  if (labels.length !== 1) return { label: 'unknown', rid: null }
  const sid = labels[0][1]
  const aliases: Record<string, number> = { UN: 0, LW: 4096, ME: 8192, MP: 8448, HI: 12288, SI: 16384 }
  const rid = aliases[sid] ?? (/^S-1-16-\d+$/.test(sid) ? Number(sid.slice(7)) : NaN)
  if (!Number.isSafeInteger(rid)) return { label: 'unknown', rid: null }
  const names: Record<number, Label> = { 0: 'untrusted', 4096: 'low', 8192: 'medium', 8448: 'medium', 12288: 'high', 16384: 'system' }
  return { label: names[rid] ?? 'other', rid }
}

function targets(file: string): { path: string; role: 'image' | 'ancestor' }[] {
  const images = [path.resolve(file)]
  try { images.push(fs.realpathSync.native(file)) } catch { /* query will report unknown */ }
  // PortableGit's bin/bash.exe starts usr/bin/bash.exe; both images matter.
  for (const image of [...images]) {
    if (path.basename(path.dirname(image)).toLowerCase() === 'bin' && path.basename(path.dirname(path.dirname(image))).toLowerCase() !== 'usr') {
      const actual = path.resolve(path.dirname(image), '../usr/bin/bash.exe')
      if (fs.existsSync(actual)) {
        images.push(actual)
        try { images.push(fs.realpathSync.native(actual)) } catch { /* query will report unknown */ }
      }
    }
  }
  const entries = new Map<string, { path: string; role: 'image' | 'ancestor' }>()
  for (const image of images) entries.set(image.toLowerCase(), { path: image, role: 'image' })
  for (const image of images) {
    let directory = path.dirname(image)
    for (;;) {
      if (!entries.has(directory.toLowerCase())) entries.set(directory.toLowerCase(), { path: directory, role: 'ancestor' })
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return [...entries.values()]
}

export function bashIntegrityReport(file?: string): IntegrityReport {
  if (process.platform !== 'win32' || !file) return { status: 'not-applicable', entries: [], warnings: [] }
  const requested = targets(file)
  let raw: RawEntry[] = [], failure = 'integrity query returned no usable result'
  try {
    const script = fs.readFileSync(new URL('./integrity-labels.ps1', import.meta.url), 'utf8')
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      input: JSON.stringify(requested.map(entry => entry.path)), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })
    if (result.error || result.status !== 0) failure = result.error?.message ?? `PowerShell label query exited ${result.status}`
    else {
      const value: unknown = JSON.parse(result.stdout.trim())
      if (record(value) && Array.isArray(value.entries)) raw = value.entries.filter(record)
      if (record(value) && typeof value.error === 'string') failure = value.error
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error) }
  const entries: IntegrityEntry[] = requested.map(entry => {
    const result = raw.find(item => item.path === entry.path)
    if (result && typeof result.sddl === 'string' && !result.error) {
      const label = integrityLabel(result.sddl)
      return { ...entry, ...label, ...(label.label === 'unknown' ? { reason: `unrecognized label descriptor: ${result.sddl}` } : {}) }
    }
    return { ...entry, label: 'unknown', rid: null, reason: typeof result?.error === 'string' ? result.error : failure }
  })
  const warnings = []
  for (const entry of entries.filter(entry => entry.rid !== null && entry.rid < 8192)) {
    warnings.push(entry.role === 'image'
      ? `Bash image has Low or lower integrity: ${entry.path}. Full access does not remove image labels; a Low child cannot write existing Medium/unlabeled files.`
      : `Bash ancestor has Low or lower integrity: ${entry.path}. Future descendants may inherit a Low label; this alone does not establish the current image's label.`)
  }
  const unknown = entries.some(entry => entry.label === 'unknown')
  if (unknown) warnings.push('Some integrity labels are unknown; this is not evidence of Medium integrity or successful startup.')
  return { status: unknown ? 'partial' : 'complete', entries, warnings }
}
