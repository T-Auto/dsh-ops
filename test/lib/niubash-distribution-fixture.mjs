/** Real frozen distribution and its import closure for release/IPC fixtures only. */
import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT } from './harness.mjs'
import { NIUBASH_PACKAGE_PATH, stageNiubashArchive, verifyNiubashTree } from '../../lib/cli/niubash-payload.js'

export const NIUBASH_MODULES = ['niubash/runtime.js', 'niubash/faces.js',
  'niubash/seal.js', 'cli/niubash-payload.js', 'cli/niubash-payload-manifest.json']

export function copyFixtureModules(root, files = NIUBASH_MODULES) {
  for (const file of files) {
    const target = path.join(root, 'lib', file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(PACKAGE_ROOT, 'lib', file), target)
  }
}

export function stageFixtureNiubash(target) {
  if (process.env.DSH_OPS_NIUBASH_ARCHIVE) {
    stageNiubashArchive(process.env.DSH_OPS_NIUBASH_ARCHIVE, target)
  } else {
    const source = path.join(PACKAGE_ROOT, NIUBASH_PACKAGE_PATH)
    verifyNiubashTree(source)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(source, target, { recursive: true, dereference: false })
  }
  verifyNiubashTree(target)
  return target
}
