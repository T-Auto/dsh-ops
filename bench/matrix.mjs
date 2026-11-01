/**
 * Where the bytes and the milliseconds actually go, across request shapes.
 *
 * Three questions this answers: how much of the rendered text is source and how much is framing;
 * whether the in-process reader wins at small, medium and large sizes; and what the native worker's
 * per-call cost is when the work itself is trivial.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

import { callTool, envelopeOf } from '../test/lib/boundary.mjs'
import { readFilesCompat } from '../lib/file/parallel-read.js'
import { renderNative } from '../lib/projections/native/render.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-matrix-'))
const median = v => v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)]
const n = v => Buffer.byteLength(v, 'utf8')

function fixture(count, lines) {
  const made = []
  for (let i = 0; i < count; i += 1) {
    const body = Array.from({ length: lines }, (_, l) => `export const v${i}_${l} = ${l}; // filler filler filler`).join('\n')
    const file = path.join(root, `m${count}_${lines}_${i}.ts`)
    fs.writeFileSync(file, body + '\n')
    made.push(file)
  }
  return made
}

async function time(body) {
  const t = []
  let value
  for (let i = 0; i < 3; i += 1) {
    const s = process.hrtime.bigint()
    value = await body()
    t.push(Number(process.hrtime.bigint() - s) / 1e6)
  }
  return { ms: median(t), value }
}

const shapes = [[24, 30], [8, 800], [2, 8000], [1, 20000]]
const rows = []
for (const [count, lines] of shapes) {
  const files = fixture(count, lines)
  const requests = files.map(f => ({ path: f }))
  const sourceBytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0)
  const native = await time(async () => envelopeOf(await callTool('read_files', { files: requests }, { root, writeRoots: [root], readOnly: true }), assert))
  const ours = await time(async () => readFilesCompat(requests))
  const nativeText = renderNative('read_files', { files: requests }, native.value)
  const ourText = renderNative('read_files', { files: requests }, ours.value)
  rows.push({
    shape: `${count}f x ${lines}L`,
    'source KiB': (sourceBytes / 1024).toFixed(0),
    'native ms': native.ms.toFixed(1),
    'ours ms': ours.ms.toFixed(1),
    'speedup': (native.ms / ours.ms).toFixed(1) + 'x',
    'native KiB': (n(nativeText) / 1024).toFixed(1),
    'ours KiB': (n(ourText) / 1024).toFixed(1),
    'framing %': (100 * (1 - sourceBytes / n(nativeText))).toFixed(0) + '%',
  })
}
console.table(rows)
fs.rmSync(root, { recursive: true, force: true })
