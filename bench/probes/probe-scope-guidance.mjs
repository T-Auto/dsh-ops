/**
 * Runs every fenced `ts` example of one guidance file TWICE inside one persistent
 * REPL, the way a model copies a trajectory and later re-uses its shape.
 *
 * PTC evaluates each program in a retained REPL, so a top-level declaration outlives
 * the program: the second run of the same example is a compile-time redeclaration
 * unless the body is scoped. This probe answers the only question the guidance text
 * controls — is a trajectory safe to copy twice — without a model and without tokens.
 *
 * Usage: node bench/probes/probe-scope-guidance.mjs <guidance.md> [--json]
 *
 * The `return` normalization is deliberate: `repl` rejects a top-level return, and
 * leaving it in would make the example fail to compile for an unrelated reason and
 * hide the redeclaration this probe measures.
 */
import { readFileSync } from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import { start } from 'node:repl'

/** Minimal typed surface every example calls; values never matter, only scoping does. */
const tools = {
  ops_load_sdk: async () => ({ status: 'completed', data: { tools: ['glob'] } }),
  ops_glob: async () => ({ status: 'completed', data: { items: [{ path: 'src/a.ts' }] } }),
  ops_grep: async () => ({ status: 'completed', data: { items: [{ path: 'src/a.ts' }] } }),
  ops_read_files: async () => ({ status: 'completed', data: { items: [{ items: [], lineCount: 1, complete: true, nextOffset: 0 }] } }),
  ops_inspect_local_file: async () => ({ status: 'completed', data: { items: [{ lineCount: 1, text: '' }] } }),
  ops_stat: async () => ({ status: 'completed', data: { revision: 'rev-1' } }),
  ops_edit_file: async () => ({ status: 'completed', data: { changed: true } }),
}

/** Every fenced `ts` block that carries a body (the bare plan-line template has none). */
function examples(markdown) {
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map(match => match[1].replace(/\n+$/u, ''))
    .filter(block => !block.includes('<operation>'))
}

/** Give the trailing `return X` a name so the repl accepts it; scoping is untouched. */
function normalizeReturn(block, index) {
  // A name per example: a shared one would collide across examples and report a
  // redeclaration the guidance never caused.
  return block.replace(/^return /mu, `const __out${index} = `)
}

/** Evaluate one program in the shared REPL; syntax errors print instead of calling back. */
function evaluate(repl, code) {
  return new Promise(resolve => {
    const printed = []
    repl._probeOut.length = 0
    let settled = false
    const finish = value => { if (!settled) { settled = true; resolve(value) } }
    const timer = setTimeout(() => finish({ error: null, text: repl._probeOut.join('').trim() }), 400)
    repl.eval(code + '\n', repl.context, 'ptc-repl', (error, value) => {
      clearTimeout(timer)
      finish({ error: error ? error.message : null, text: printed.join(''), value })
    })
  })
}

const path = process.argv[2]
if (!path) {
  console.error('usage: node bench/probes/probe-scope-guidance.mjs <guidance.md> [--json]')
  process.exit(2)
}
const captured = []
const input = new PassThrough()
const output = new Writable({ write(chunk, _encoding, callback) { captured.push(chunk.toString()); callback() } })
const repl = start({ input, output, terminal: false, prompt: '', useGlobal: false, ignoreUndefined: true })
Object.defineProperty(repl.context, 'tools', { configurable: true, enumerable: true, writable: true, value: tools })
Object.defineProperty(repl, '_probeOut', { configurable: true, enumerable: false, writable: true, value: captured })

const blocks = examples(readFileSync(path, 'utf8'))
const rows = []
for (const [index, block] of blocks.entries()) {
  const code = normalizeReturn(block, index + 1)
  const first = await evaluate(repl, code)
  const second = await evaluate(repl, code)
  const redeclared = /already been declared/u.test(second.text)
  rows.push({
    example: index + 1,
    plan: (block.split('\n')[0] || '').slice(0, 58),
    first: first.error ?? (/Uncaught/u.test(first.text) ? first.text.split('\n')[0] : 'ok'),
    second: second.error ?? (/Uncaught/u.test(second.text) ? second.text.split('\n')[0] : 'ok'),
    redeclared,
  })
}
repl.close()
input.destroy()
output.destroy()

const failed = rows.filter(row => row.redeclared)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ file: path, examples: rows.length, redeclared: failed.length, rows }, null, 2))
} else {
  console.log(`${path}: ${rows.length} example(s), ${failed.length} not copyable twice`)
  for (const row of rows) {
    console.log(`  ${row.redeclared ? 'REDECLARE' : 'ok        '} #${row.example} ${row.plan}`)
    if (row.redeclared) console.log(`             second run: ${row.second}`)
    else if (row.first !== 'ok') console.log(`             first run:  ${row.first}`)
  }
}
process.exitCode = failed.length > 0 ? 1 : 0
