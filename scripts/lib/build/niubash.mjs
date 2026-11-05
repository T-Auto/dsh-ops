/** Reproducible full Niubash injection; no npm platform package or Git Bash fallback. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NIUBASH_PIN, NIUBASH_PACKAGE_PATH, stageNiubashArchive, verifyNiubashTree } from '../../../lib/cli/niubash-payload.js'
import { download } from './download.js'
import { REPO_ROOT } from './util.js'

export async function assembleNiubash(context) {
  const archive = context.niubashArchive ?? path.join(context.dist, 'downloads', NIUBASH_PIN.archive)
  if (!fs.existsSync(archive)) {
    if (context.offline || context.niubashArchive) throw Error(`Missing Niubash archive: ${archive}; no Git Bash fallback`)
    await download(NIUBASH_PIN.url, archive, { proxy: context.proxy, expectedBytes: NIUBASH_PIN.archiveBytes })
  }
  const target = path.join(context.dist, 'stage', 'niubash-win32-x64')
  stageNiubashArchive(archive, target)
  context.niubash = { stage: target, archiveSha256: NIUBASH_PIN.archiveSha256 }
  return context.niubash
}

export function checkNiubash(context) {
  const stage = context.niubash?.stage ?? path.join(context.dist, 'stage', 'niubash-win32-x64')
  verifyNiubashTree(stage)
  return stage
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import('node:util')
  const { resolveProxy } = await import('./download.js')
  const { values } = parseArgs({ options: { archive: { type: 'string' }, target: { type: 'string' }, offline: { type: 'boolean' }, check: { type: 'boolean' } } })
  try {
    if (values.check) {
      verifyNiubashTree(path.join(REPO_ROOT, NIUBASH_PACKAGE_PATH))
      console.log('Niubash complete payload verified')
    } else {
      const context = { dist: path.join(REPO_ROOT, 'dist'), niubashArchive: values.archive,
        offline: values.offline, proxy: resolveProxy(undefined, false) }
      const { stage } = await assembleNiubash(context)
      const target = path.resolve(values.target ?? path.join(REPO_ROOT, NIUBASH_PACKAGE_PATH))
      // Re-stage the pinned archive, never copy an unverified cached extraction.
      stageNiubashArchive(values.archive ?? path.join(context.dist, 'downloads', NIUBASH_PIN.archive), target)
      console.log(`Niubash ${NIUBASH_PIN.upstreamVersion}: ${verifyNiubashTree(target)} (verified ${stage})`)
    }
  } catch (error) {
    console.error(`stage:niubash: ${error.message}`)
    process.exitCode = 1
  }
}
