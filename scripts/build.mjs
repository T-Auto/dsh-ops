#!/usr/bin/env node
/** Compile source to the published lib paths, then copy component and panel assets. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleClient } from './lib/build/client.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'src')
const output = path.join(root, 'lib')
const compiler = path.join(root, 'node_modules/typescript/lib/tsc.js')
const codeFile = /\.(?:[cm]?[jt]s|[jt]sx)$/i

function requireTypedSource(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const from = path.join(directory, entry.name)
    if (entry.isDirectory()) requireTypedSource(from)
    else if (entry.isFile() && /\.(?:[cm]?js|jsx)$/i.test(entry.name)) {
      throw new Error(`JavaScript source is not supported: ${path.relative(root, from)}; migrate it to TypeScript.`)
    }
  }
}

function copyAssets(directory) {
  let count = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const from = path.join(directory, entry.name)
    if (entry.isDirectory()) count += copyAssets(from)
    else if (entry.isFile() && !codeFile.test(entry.name)) {
      const to = path.join(output, path.relative(source, from))
      mkdirSync(path.dirname(to), { recursive: true })
      copyFileSync(from, to)
      count++
    } else if (!entry.isFile()) {
      throw new Error(`Unsupported source entry: ${path.relative(root, from)}`)
    }
  }
  return count
}

try {
  if (!existsSync(compiler)) throw new Error('TypeScript is missing; run npm ci --ignore-scripts first.')
  // Both paths are fixed children of this checkout. Remove only generated output so deleted
  // source modules cannot remain importable after a successful rebuild.
  rmSync(output, { recursive: true, force: true })
  // tsc silently ignores unimported JavaScript when allowJs is disabled. Refuse it explicitly
  // so a missed source migration cannot produce an apparently successful incomplete package.
  requireTypedSource(source)
  const result = spawnSync(process.execPath, [compiler, '-p', path.join(root, 'tsconfig.json')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    console.error('build: TypeScript compilation failed; assets were not copied.')
  } else {
    bundleClient(root)
    const assets = copyAssets(source)
    if (existsSync(path.join(source, 'ptc/contract.ts'))) {
      const { writePtcDeclarations } = await import('./lib/build/ptc-sdk.mjs')
      const sdk = await writePtcDeclarations(root)
      console.log(`build: generated PTC declarations for ${sdk.tools} capabilities (${sdk.bytes} bytes)`)
    }
    console.log(`build: compiled src/ to lib/ and copied ${assets} assets`)
  }
} catch (error) {
  console.error(`build: ${error.message}`)
  process.exitCode = 1
}
