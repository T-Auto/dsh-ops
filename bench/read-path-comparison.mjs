/**
 * Native worker vs the in-process reader: wall time and bytes on the same request.
 *
 * The two paths answer the same question — "give me these files" — with different machinery. The
 * native path spawns `dsh-ops-worker` once per call, so its cost is mostly process creation; the
 * in-process reader pays only for the reads themselves. Bytes matter as much as milliseconds: the
 * result is what the model reads, so a smaller answer is a cheaper turn.
 *
 * Run: node bench/read-path-comparison.mjs [files] [lines]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import assert from 'node:assert/strict'
import { callTool, envelopeOf } from '../test/lib/boundary.mjs'
import { readFilesCompat } from '../lib/file/parallel-read.js'
import { renderNative } from '../lib/projections/native/render.js'

const FILES = Number(process.argv[2] ?? 24)   // read_files caps a call at 32 files
const LINES = Number(process.argv[3] ?? 30)
const ROUNDS = 3
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bench-'))
const paths = []
for (let i = 0; i < FILES; i += 1) {
  const body = Array.from({ length: LINES }, (_, line) => `const v${i}_${line} = ${line} // padding padding padding`).join('\n')
  const file = path.join(root, `f${String(i).padStart(3, '0')}.ts`)
  fs.writeFileSync(file, body + '\n')
  paths.push(file)
}
const requests = paths.map(file => ({ path: file }))

async function timed(body, rounds = ROUNDS) {
  const times = []
  let last
  for (let i = 0; i < rounds; i += 1) {
    const started = process.hrtime.bigint()
    last = await body()
    times.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  return { ms: median(times), value: last }
}

const native = await timed(async () => envelopeOf(await callTool('read_files', { files: requests }, { root, writeRoots: [root], readOnly: true }), assert))
const ours = await timed(async () => readFilesCompat(requests))

// Compare what the model actually reads: both paths are rendered by the same native projection,
// so equal inputs must produce comparable text. Bytes are the honest token proxy here.
const nativeText = renderNative('read_files', { files: requests }, native.value)
const ourText = renderNative('read_files', { files: requests }, ours.value)
for (const [label, value] of [['native', native.value], ['in-process', ours.value]]) {
  if (!Array.isArray(value?.items) || value.items.length === 0) {
    console.error(label + ' produced no items:', JSON.stringify(value).slice(0, 300))
    process.exit(1)
  }
}
const row = (name, ms, text) => ({
  path: name,
  'median ms': ms.toFixed(1),
  bytes: Buffer.byteLength(text, 'utf8'),
  'est. tokens (bytes/4)': Math.round(Buffer.byteLength(text, 'utf8') / 4),
})
console.table([
  row('native worker (spawn per call)', native.ms, nativeText),
  row('engine/parallel-read (in-process)', ours.ms, ourText),
])
console.log(`speed-up: ${(native.ms / ours.ms).toFixed(1)}x   bytes: ${(100 * (1 - Buffer.byteLength(ourText) / Buffer.byteLength(nativeText))).toFixed(1)}% smaller`)
console.log(`fixture: ${FILES} files x ${LINES} lines, ${(Buffer.byteLength(paths.map(p => fs.readFileSync(p)).join('')) / 1024).toFixed(0)} KiB total`)
fs.rmSync(root, { recursive: true, force: true })
