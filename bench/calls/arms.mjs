/** Resolve each tool surface independently while sharing the runner's host and corpus. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from '../lib/env.mjs'

export function defaultWorker(root = REPO_ROOT) {
  return path.join(root, 'native', 'target', 'release', process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker')
}

export function resolveArms(options) {
  return options.projections.map(id => {
    if (id === 'official') return { id, projection: 'official' }
    const pluginRoot = path.resolve(id === 'baseline' ? options.baselinePluginRoot : options.pluginRoot ?? REPO_ROOT)
    const worker = path.resolve((id === 'baseline' ? options.baselineWorker : options.worker) ?? defaultWorker(pluginRoot))
    // host.mjs's legacy "baseline" projection is the 0.3.x API. Both version arms here
    // use the component API, even when the report labels one of them "baseline".
    return { id, projection: 'candidate', pluginRoot, worker }
  })
}

/** Check every build before importing any plugin, then fingerprint the actual measured bytes. */
export async function loadArms(arms) {
  for (const arm of arms.filter(arm => arm.projection === 'candidate')) {
    const needed = ['package.json', 'lib/policy.js', 'lib/components/file/index.js', 'lib/components/discovery/index.js']
      .map(file => path.join(arm.pluginRoot, file)).concat(arm.worker)
    const missing = needed.filter(file => !fs.existsSync(file) || !fs.statSync(file).isFile())
    if (missing.length) throw new Error(`${arm.id}: missing build input: ${missing.join('; ')} (build lib/ and the release worker in that checkout)`)
  }
  const loaded = []
  for (const arm of arms) {
    if (arm.projection === 'official') {
      const packages = Object.fromEntries(['dsh-tool-fs', 'dsh-tool-fs-search'].map(name => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8'))
        return [name, pkg.version]
      }))
      loaded.push({ ...arm, evidence: { projection: 'official', packages } })
      continue
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(arm.pluginRoot, 'package.json'), 'utf8'))
    const { publicToolName } = await import(pathToFileURL(path.join(arm.pluginRoot, 'lib/policy.js')).href)
    if (typeof publicToolName !== 'function') throw new Error(`${arm.id}: lib/policy.js must export publicToolName`)
    loaded.push({ ...arm, publicToolName, evidence: {
      projection: 'candidate', pluginRoot: arm.pluginRoot, version: pkg.version,
      libSha256: hashBuild(path.join(arm.pluginRoot, 'lib')),
      worker: { path: arm.worker, sha256: createHash('sha256').update(fs.readFileSync(arm.worker)).digest('hex') },
    } })
  }
  return loaded
}

function hashBuild(root) {
  const hash = createHash('sha256')
  const visit = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const relative = prefix + entry.name, file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file, relative + '/')
      else if (entry.isFile()) {
        hash.update(relative + '\0')
        hash.update(createHash('sha256').update(fs.readFileSync(file)).digest())
      } else throw new Error(`cannot fingerprint a non-regular build entry: ${file}`)
    }
  }
  visit(root)
  return hash.digest('hex')
}
