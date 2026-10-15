#!/usr/bin/env node
/**
 * Boundary diagnostics: reproduces the four open reports against a real worker
 * and prints what the code does today. It ASSERTS NOTHING and always exits 0 —
 * these are observations to re-run after a fix, not a gate.
 *
 *   #75 read-side containment   (reads outside the session workspace)
 *   #76 write roots from os.tmpdir()  (a broad TMPDIR authorizes a broad tree)
 *   #77 the job manifest as an authority (a rewritten manifest is executed)
 *   #78 audit-store growth      (generations per run; release asymmetry)
 *
 * Run: node tools/boundary-probe.mjs   (build the worker first)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { invoke as invokeFile } from '../lib/file/worker.js'
import { invoke as invokePtc } from '../lib/ptc/worker.js'

const worker = process.env.DSH_OPS_WORKER_BIN
  ?? path.resolve('native/target/release', process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker')
if (!fs.existsSync(worker)) { console.error(`build the worker first (npm run build:rust); looked for ${worker}`); process.exit(2) }

// Scratch goes to the platform temporary directory: a diagnostic must not
// litter the home directory it is describing.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-boundary-'))
const ws = path.join(base, 'ws')
fs.mkdirSync(path.join(ws, 'src'), { recursive: true })
fs.mkdirSync(path.join(base, 'outside'), { recursive: true })
fs.writeFileSync(path.join(ws, 'src', 'a.txt'), 'alpha\n')
fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'OUTSIDE\n')

const file = (tool, args, scope = 'boundary') => invokeFile(
  { get: name => ({
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ws, sessionId: scope }) },
    subprocess: spawnService,
    sandbox: { confine: async argv => ({ enforcement: 'full', argv }) },
  })[name] },
  worker, tool, args,
  { agent: { session: { id: scope, mode: 'workspace-write', header: { cwd: ws } } } },
  new AbortController().signal,
)
const ptc = (tool, args, scope = 'boundary') => invokePtc(
  { get: name => ({
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: ws, sessionId: scope }) },
    subprocess: spawnService,
    sandbox: { confine: async argv => ({ enforcement: 'full', argv }) },
  })[name] },
  worker, tool, args,
  { agent: { session: { id: scope, mode: 'workspace-write', header: { cwd: ws } } } },
  new AbortController().signal,
)

/** Minimal subprocess service: one worker process per call, no host services. */
const spawnService = {
  spawn({ argv, stdio }) {
    const result = spawnSync(argv[0], argv.slice(1), { input: stdio.stdin.data, encoding: 'utf8', timeout: 60_000 })
    return {
      done: Promise.resolve({ exitCode: result.status ?? 1, signal: result.signal ?? null }),
      collected: {
        stdout: { readFrom: () => ({ text: result.stdout ?? '', lossy: false }) },
        stderr: { readFrom: () => ({ text: result.stderr ?? '' }) },
      },
    }
  },
}

const verdict = value => value?.error ? `${value.error.code}: ${String(value.error.message).slice(0, 60)}` : `status=${value?.status ?? '?'}`
const outside = path.join(base, 'outside', 'secret.txt')
const store = path.join(ws, '.dsh-ops')
const storeNames = () => fs.existsSync(store) ? fs.readdirSync(store) : []

console.log(`worker   ${worker}`)
console.log(`mode     workspace-write`)
console.log(`workspace ${ws}`)
console.log(`TMPDIR   ${process.env.TMPDIR ?? '(unset)'}   os.tmpdir() ${os.tmpdir()}   homedir ${os.homedir()}\n`)

// #75 — the read side has no workspace bound.
const readRelative = await file('inspect_local_file', { path: '../outside/secret.txt' })
const readAbsolute = await file('inspect_local_file', { path: outside })
console.log('#75 read outside the workspace')
console.log(`  relative ../outside/secret.txt   ${verdict(readRelative)}`)
console.log(`  absolute ${outside.slice(-28)}    ${verdict(readAbsolute)}`)
console.log(`  expected once #75 is fixed: POLICY_DENIED for both\n`)

// #76 — the platform temp directory is a write root.
const writeOutside = await file('replace', { path: outside, pattern: 'OUTSIDE', replacement: 'HACKED' })
const broadTemp = path.resolve(os.tmpdir()) === path.resolve(os.homedir())
console.log('#76 write roots include os.tmpdir()')
console.log(`  os.tmpdir() == homedir()  ${broadTemp}${broadTemp ? '  <- a home directory is authorized wholesale' : ''}`)
console.log(`  replace outside the workspace   ${verdict(writeOutside)}   file changed ${fs.readFileSync(outside, 'utf8') !== 'OUTSIDE\n'}`)
console.log(`  expected once #76 is fixed: POLICY_DENIED unless the target is a DSH-owned temporary area\n`)

// #77 — the manifest is the authority, and the file path can rewrite it.
const run = await ptc('batch', { action: 'plan', operations: [{ op: 'copy', path: 'src/a.txt', to: 'planned.txt' }] })
const manifest = storeNames().find(name => name.startsWith(run.id) && name.endsWith('.json'))
const manifestPath = path.join(store, manifest)
const record = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
record.items[0].operation.to = 'forged.txt'
fs.writeFileSync(manifestPath, JSON.stringify(record))
const resumed = await ptc('batch', { action: 'resume', id: run.id })
console.log('#77 a rewritten manifest is executed')
console.log(`  plan target planned.txt -> rewritten to forged.txt`)
console.log(`  resume ${verdict(resumed)}   forged.txt exists ${fs.existsSync(path.join(ws, 'forged.txt'))}   planned.txt exists ${fs.existsSync(path.join(ws, 'planned.txt'))}`)
console.log(`  expected once #77 is fixed: the manifest cannot be rewritten through the file path, or resume detects it\n`)

// #78 — generations per run, and what can be reclaimed in band.
const generations = storeNames().filter(name => name.startsWith(run.id))
const releaseJob = await ptc('result', { action: 'release', id: run.id })
const pageJob = await ptc('result', { action: 'page', id: run.id })
console.log('#78 audit-store growth')
console.log(`  generations for one job: ${generations.length}  (${generations.join(', ')})`)
console.log(`  release a job audit      ${verdict(releaseJob)}`)
console.log(`  page the same job        ${pageJob?.error ? verdict(pageJob) : 'ok'}
  expected once #78 is fixed: superseded generations are pruned, or job audits can be archived\n`)

fs.rmSync(base, { recursive: true, force: true })
