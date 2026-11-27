import fs from 'node:fs'
import path from 'node:path'
import { capability, FILE_TOOLS, PTC_TOOLS } from '../capabilities/registry.js'
import { dshHome } from '../paths.js'
import { PACKAGE_ROOT } from './runtime.js'

export interface ToolIndexConfig { userFile?: string }
export interface IndexedTool { id: string; name: string; description: string; executor: string }
export interface ToolIndex { entries: readonly IndexedTool[]; sourceCount: number }
const MAX_FILE_BYTES = 256 * 1024
const MAX_ENTRIES = 256
const EXECUTORS = new Set<string>([...FILE_TOOLS, ...PTC_TOOLS])

export function parseToolIndex(value: unknown, source: string): IndexedTool[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(source + ' must contain a JSON object')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1 || !Array.isArray(raw.tools)) throw new Error(source + ' must use version 1 and a tools array')
  if (raw.tools.length > MAX_ENTRIES) throw new Error(source + ' exceeds the 256-entry limit')
  const ids = new Set<string>()
  return raw.tools.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(source + ' tools[' + index + '] must be an object')
    const entry = item as Record<string, unknown>
    const { id, name, description, executor } = entry
    if (Object.keys(entry).some(key => !['id', 'name', 'description', 'executor'].includes(key))) throw new Error(source + ' tools[' + index + '] has unknown fields')
    if (typeof id !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(id)) throw new Error(source + ' tools[' + index + '].id is invalid')
    if (ids.has(id)) throw new Error(source + ' contains duplicate id ' + id)
    if (typeof name !== 'string' || name.trim() !== name || name.length < 1 || name.length > 80) throw new Error(source + ' tools[' + index + '].name is invalid')
    if (typeof description !== 'string' || description.trim() !== description || description.length < 1 || description.length > 2048) throw new Error(source + ' tools[' + index + '].description is invalid')
    if (typeof executor !== 'string' || !EXECUTORS.has(executor) || !capability(executor)) throw new Error(source + ' tools[' + index + '].executor is not a built-in OPS executor')
    ids.add(id)
    return { id, name, description, executor }
  })
}

function readIndex(file: string, source: string): IndexedTool[] {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(source + ' must be a regular JSON file no larger than 256 KiB')
  return parseToolIndex(JSON.parse(fs.readFileSync(file, 'utf8')), source)
}

export function loadToolIndex(config: ToolIndexConfig = {}): ToolIndex {
  const bundledPath = path.join(PACKAGE_ROOT, 'lib', 'ptc', 'ops-tools.json')
  const bundled = readIndex(bundledPath, 'OPS bundled index')
  if (!config.userFile) return { entries: bundled, sourceCount: 1 }
  const home = dshHome()
  const userPath = path.resolve(home, config.userFile)
  if (userPath !== home && !userPath.startsWith(home + path.sep)) throw new Error('user tool index path must stay under the DSH home')
  const user = readIndex(userPath, 'user tool index')
  const ids = new Set(bundled.map(entry => entry.id))
  for (const entry of user) if (ids.has(entry.id)) throw new Error('user tool index cannot shadow OPS entry id ' + entry.id)
  return { entries: [...bundled, ...user], sourceCount: 2 }
}

export function searchToolIndex(index: ToolIndex, query: string, limit = 8): IndexedTool[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const ranked = index.entries.map(entry => {
    const text = (entry.id + ' ' + entry.name + ' ' + entry.description + ' ' + entry.executor).toLocaleLowerCase()
    return { entry, score: terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0) }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
  return ranked.slice(0, Math.max(1, Math.min(limit, 16))).map(item => item.entry)
}
