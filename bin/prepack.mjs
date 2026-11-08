#!/usr/bin/env node
/**
 * `npm pack` / `npm publish` build the checkout before the tarball is assembled.
 *
 * `scripts/` and the build toolchain are repository-only: `files` never publishes
 * them. An installed or unpacked package already carries a finished `lib/`, so
 * packing it must not fail on a build script that is not there (#713). Only a
 * checkout, recognised by `scripts/build.mjs`, runs the build and the payload
 * check.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (!existsSync(path.join(root, 'scripts', 'build.mjs'))) process.exit(0)

const steps = [
  ['scripts/build.mjs'],
  ['scripts/lib/build/niubash.mjs', '--check'],
]

for (const [script, ...args] of steps) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
