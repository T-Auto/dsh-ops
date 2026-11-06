/**
 * AST tools against the native ops tools: wall time and bytes the model reads.
 *
 * This exists because three separate one-off scripts produced three numbers that
 * were wrong: one measured an O(n²) dedup, one measured a request the worker had
 * refused, one measured a path the worker refused outright. Every one of them
 * looked plausible.
 *
 * The rule here is that a duration is only printed for a measurement whose answer
 * was also checked. Each scene declares what a correct answer looks like for both
 * sides; a scene that fails that check prints FAIL and contributes no timing. A
 * benchmark that cannot tell "fast" from "wrong" is worse than none.
 *
 * @module dsh-ops/bench/tools/ast-vs-native
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callTool } from '../../test/lib/boundary.mjs'
import { invokeAst } from '../../lib/execution/ast-inproc.js'
import { definition } from '../../lib/projections/native/contract.js'

const SIZES = [200, 1000, 3000, 10000]
const ROUNDS = 5
const PATTERN = 'greet($A)'
const REWRITE = 'welcome($A)'

/** Build a repository of `n` source files with one known definition and three call sites. */
function buildFixture(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `staffix-${n}-`))
  const dirs = Math.max(8, Math.round(Math.sqrt(n)))
  for (let i = 0; i < n; i++) {
    const dir = path.join(root, 'src', `m${i % dirs}`)
    if (i < dirs) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `f${i}.ts`), `export function helper${i}() { return ${i} }\n`)
  }
  fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/lib/greet.ts'),
    'export function greet(name: string) {\n  return `hi ${name}`\n}\n')
  for (const [name, body] of [['a', "console.log(greet('x'))\n"], ['b', "greet('y')\n"], ['c', 'greet(name)\n']]) {
    fs.writeFileSync(path.join(root, `src/use${name}.ts`), body)
  }
  fs.writeFileSync(path.join(root, 'src/notes.ts'), '// greet is the entry point\nexport const hint = "call greet() first"\n')
  // Only greet.ts defines greet; the audit pair is a separate symbol so the locate expectation stays
  // exactly one hit and a wrong hit count is a real failure.
  fs.writeFileSync(path.join(root, 'src/before.ts'), 'export function shrink(n: string) { return n }\n')
  fs.writeFileSync(path.join(root, 'src/after.ts'), 'export function shrink(n: string) {\n\n  return n }\n')
  return root
}

/**
 * Count the fixture's source files on disk and refuse a fixture that is not what it claims.
 *
 * The script that produced the first wrong number built its files relative to the process cwd,
 * so the tree it measured was empty while the files sat in the repository.
 *
 * @param root - fixture root.
 * @param expected - number of generated `f*.ts` files.
 */
function assertFixture(root, expected) {
  let seen = 0
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.name.startsWith('f') && entry.name.endsWith('.ts')) seen++
    }
  }
  walk(root)
  if (seen !== expected) throw new Error(`fixture self-check: expected ${expected} files, found ${seen}`)
  for (const name of ['src/lib/greet.ts', 'src/notes.ts', 'src/before.ts', 'src/after.ts']) {
    if (!fs.existsSync(path.join(root, name))) throw new Error(`fixture self-check: missing ${name}`)
  }
}

const ctx = root => ({ get: k => k === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } : undefined })
const exec = root => ({ agent: { session: { id: 'ast-bench', header: { cwd: root } } } })
const ast = (root, tool, args) => invokeAst(tool, ctx(root), args, exec(root), new AbortController().signal)

const astTokens = (tool, args, value) => {
  const def = definition(tool, async () => value)
  return Buffer.byteLength(def.output.render(args, value).map(b => b.text).join('\n'), 'utf8')
}
const nativeTokens = value => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** Run `fn` `ROUNDS` times after one warm-up and report every sample plus the median. */
async function sample(fn) {
  await fn()
  const times = []
  let produced
  for (let i = 0; i < ROUNDS; i++) {
    const started = performance.now()
    produced = await fn()
    times.push(performance.now() - started)
  }
  const sorted = [...times].sort((a, b) => a - b)
  return { produced, times, median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] }
}

/**
 * Scenes, each with the answer both sides must produce.
 *
 * `check` receives both results and returns a reason string when either is wrong; returning
 * nothing means both answered. A scene that cannot be checked does not belong here.
 */
const SCENES = [
  {
    name: 'find a definition',
    astArgs: { symbol: 'greet' },
    nativeTool: 'grep',
    nativeArgs: root => ({ path: path.join(root, 'src'), pattern: 'greet', outputMode: 'content', lineNumbers: true }),
    check(astValue, nativeValue) {
      const hits = astValue.hits ?? []
      if (hits.length !== 1) return `ast_locate returned ${hits.length} hits, expected 1`
      if (!hits[0].file.endsWith('greet.ts')) return `ast_locate pointed at ${hits[0].file}`
      if (!/function greet/.test(hits[0].signature ?? '')) return 'ast_locate signature is not the definition'
      const text = JSON.stringify(nativeValue)
      if (!text.includes('greet.ts')) return 'grep did not reach greet.ts'
      return undefined
    },
  },
  {
    name: 'preview a rename',
    astArgs: { pattern: PATTERN, rewrite: REWRITE, mode: 'preview' },
    nativeTool: 'replace',
    nativeArgs: root => ({ path: path.join(root, 'src'), pattern: 'greet(', replacement: 'welcome(', dryRun: true }),
    check(astValue, nativeValue) {
      if (astValue.status !== 'completed') return `ast_refactor was ${astValue.status}`
      if (!(astValue.planned >= 1)) return `ast_refactor planned ${astValue.planned} files`
      if (astValue.mode !== 'preview') return 'ast_refactor did not stay in preview'
      if (nativeValue?.status !== 'completed') return `replace was ${nativeValue?.status}`
      return undefined
    },
  },
  {
    name: 'format-only check',
    astArgs: { file: 'src/after.ts', beforeFile: 'src/before.ts' },
    nativeTool: 'diff',
    nativeArgs: root => ({ path: path.join(root, 'src/before.ts'), content: fs.readFileSync(path.join(root, 'src/after.ts'), 'utf8') }),
    check(astValue, nativeValue) {
      if (astValue.status !== 'completed') return `ast_audit was ${astValue.status}`
      if (astValue.formatOnly !== true) return `ast_audit said formatOnly=${astValue.formatOnly} for a whitespace-only change`
      if (nativeValue?.status !== 'completed') return `diff was ${nativeValue?.status}`
      return undefined
    },
  },
]

const rows = []
const failures = []

for (const size of SIZES) {
  const root = buildFixture(size)
  try {
    assertFixture(root, size)
    for (const scene of SCENES) {
      const nativeArgs = typeof scene.nativeArgs === 'function' ? scene.nativeArgs(root) : scene.nativeArgs
      const astRun = () => ast(root, toolOf(scene), scene.astArgs)
      const nativeRun = () => callTool(scene.nativeTool, nativeArgs, { root })
      let a, n
      try {
        a = await sample(astRun)
        n = await sample(nativeRun)
      } catch (error) {
        failures.push(`${size} ${scene.name}: threw ${error?.message ?? error}`)
        continue
      }
      const reason = scene.check(a.produced, n.produced?.body)
      if (reason) {
        failures.push(`${size} ${scene.name}: ${reason}`)
        continue
      }
      rows.push({
        size, scene: scene.name,
        astMs: a.median, astSpread: [a.min, a.max],
        nativeMs: n.median, nativeSpread: [n.min, n.max],
        astTok: Math.round(astTokens(scene.tool ?? 'ast_locate', scene.astArgs, a.produced) / 4),
        nativeTok: Math.round(nativeTokens(n.produced.body) / 4),
      })
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function toolOf(scene) {
  if (scene.name.startsWith('find')) return 'ast_locate'
  if (scene.name.startsWith('preview')) return 'ast_refactor'
  return 'ast_audit'
}

console.log('')
console.log('files  scene                 ast median (min-max)      native median (min-max)    speed   tokens')
for (const r of rows) {
  const speed = (r.nativeMs / r.astMs).toFixed(2)
  const delta = r.nativeTok - r.astTok
  console.log(
    `${String(r.size).padStart(5)}  ${r.scene.padEnd(20)}` +
    `${r.astMs.toFixed(1).padStart(6)} ms (${r.astSpread[0].toFixed(0)}-${r.astSpread[1].toFixed(0)})`.padEnd(26) +
    `${r.nativeMs.toFixed(1).padStart(6)} ms (${r.nativeSpread[0].toFixed(0)}-${r.nativeSpread[1].toFixed(0)})`.padEnd(28) +
    `${speed.padStart(6)}x  ${String(r.astTok).padStart(4)}/${String(r.nativeTok).padEnd(4)} ${delta >= 0 ? 'saves ' + delta : 'costs ' + -delta}`)
}
console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} scene(s) produced a wrong answer and are excluded — their timings mean nothing:`)
  for (const f of failures) console.log('  ' + f)
  process.exitCode = 1
} else {
  console.log(`all ${rows.length} scene(s) answered correctly; every duration above belongs to a checked answer`)
}
console.log(`node ${process.version} on ${process.platform}-${process.arch}, ${os.cpus().length} cores, ${ROUNDS} rounds after one warm-up`)
