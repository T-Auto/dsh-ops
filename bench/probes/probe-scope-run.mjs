/**
 * Model-driven A/B of one guidance text: the same model, the same task, the same
 * retained REPL and the same `run_code` contract, so the only variable is the file.
 *
 * The host never composes a preset roster in a headless profile, so `bench/cli.mjs ab`
 * cannot put a session on the PTC surface; this probe drives that surface directly.
 * Every program a model writes is evaluated in ONE `node:repl` started with the same
 * options the host uses (`useGlobal: false`, filename `ptc-repl`), so a top-level
 * declaration outlives its program exactly as it does in production.
 *
 * Usage:
 *   node bench/probes/probe-scope-run.mjs --guidance prompts/batching-guidance.md
 *   node bench/probes/probe-scope-run.mjs --guidance /tmp/rev3.md --steps 24 --json
 *
 * Environment: PROBE_BASE_URL (default http://127.0.0.1:3425/v1), PROBE_MODEL,
 * PROBE_API_KEY (default magpie). The run is a measurement, never part of the gate.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { start } from 'node:repl'

const BASE_URL = process.env.PROBE_BASE_URL ?? 'http://127.0.0.1:3425/v1'
const MODEL = process.env.PROBE_MODEL ?? 'opencode-go/deepseek-v4.1-flash'
const API_KEY = process.env.PROBE_API_KEY ?? 'magpie'

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1]
}
const guidancePath = flag('guidance')
if (guidancePath === undefined) {
  console.error('usage: node bench/probes/probe-scope-run.mjs --guidance <file> [--steps N] [--json]')
  process.exit(2)
}
const maxSteps = Number(flag('steps', '20'))
const guidance = readFileSync(guidancePath, 'utf8').trim()

/** One fixture, six modules with cross imports, so the audit needs several programs. */
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'probe-scope-run-'))
  mkdirSync(path.join(root, 'src'))
  const modules = {
    'core.ts': "import { log } from './log'\nexport const version = '1.0'\nexport function boot() { log('boot') }\n",
    'log.ts': "export function log(message: string) { return message }\n",
    'api.ts': "import { boot } from './core'\nimport { log } from './log'\nexport function serve() { boot(); log('serve') }\nexport function stop() {}\n",
    'store.ts': "export const rows: string[] = []\nexport function put(row: string) { rows.push(row) }\n",
    'view.ts': "import { rows } from './store'\nexport function render() { return rows.join('\\n') }\n",
    'task.ts': "import { serve } from './api'\nimport { put } from './store'\nexport function run() { serve(); put('done') }\n",
  }
  for (const [name, body] of Object.entries(modules)) writeFileSync(path.join(root, 'src', name), body)
  writeFileSync(path.join(root, 'README.md'), '# fixture\nSix modules under src/.\n')
  return root
}
const root = workspace()

/** The OPS surface the shipped guidance tells a program to call, resolved against root. */
const tools = {
  ops_load_sdk: async ({ tools: names }) => ({ status: 'completed', tools: names, nextTurn: true }),
  ops_glob: async ({ pattern, limit = 100 }) => {
    const patterns = (Array.isArray(pattern) ? pattern : [pattern]).map(p => p.replace(/^\*\*\//u, ''))
    const found = []
    for (const dir of ['', 'src']) {
      for (const name of readdirSync(path.join(root, dir))) {
        const rel = dir === '' ? name : `${dir}/${name}`
        if (statSync(path.join(root, rel)).isDirectory()) continue
        if (patterns.some(p => new RegExp('^' + p.replace(/[.]/gu, '\\.').replace(/\*\*?/gu, '.*') + '$', 'u').test(rel))) found.push(rel)
      }
    }
    return { status: 'completed', data: { items: found.slice(0, limit).map(p => ({ path: p })), total: found.length, complete: found.length <= limit } }
  },
  ops_grep: async ({ pattern, path: where = '.', limit = 50 }) => {
    const hits = []
    const walk = dir => {
      for (const name of readdirSync(path.join(root, dir))) {
        const rel = dir === '.' ? name : `${dir}/${name}`
        if (statSync(path.join(root, rel)).isDirectory()) walk(rel)
        else readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, index) => {
          if (line.includes(pattern)) hits.push({ path: rel, line: index + 1, text: line.trim() })
        })
      }
    }
    walk(where)
    return { status: 'completed', data: { items: hits.slice(0, limit), total: hits.length, complete: hits.length <= limit } }
  },
  ops_read_files: async ({ files }) => ({
    status: 'completed',
    data: {
      items: files.map(file => {
        const lines = readFileSync(path.join(root, file.path), 'utf8').split('\n')
        const offset = file.offset ?? 1
        const limit = file.limit ?? 200
        return { path: file.path, items: lines.slice(offset - 1, offset - 1 + limit), lineCount: lines.length,
          complete: offset - 1 + limit >= lines.length, nextOffset: offset + limit > lines.length ? 0 : offset + limit }
      }),
    },
  }),
  ops_inspect_local_file: async ({ path: file, offset = 1, limit = 100 }) => {
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n')
    return { status: 'completed', data: { items: [{ path: file, text: lines.slice(offset - 1, offset - 1 + limit).join('\n'),
      lineCount: lines.length, complete: offset - 1 + limit >= lines.length, nextOffset: 0 }] } }
  },
  ops_stat: async ({ path: file }) => ({ status: 'completed', data: { path: file, revision: String(statSync(path.join(root, file)).mtimeMs) } }),
  ops_edit_file: async ({ path: file, edits }) => {
    let text = readFileSync(path.join(root, file), 'utf8')
    for (const edit of edits) text = text.replace(edit.oldText, edit.newText)
    writeFileSync(path.join(root, file), text)
    return { status: 'completed', data: { path: file, changed: true } }
  },
}

const RUN_CODE_DESCRIPTION = 'Execute a TypeScript program against the available tools. Takes two required '
  + 'arguments: `code`, the program to execute, and `description`, a short summary of what the program does. '
  + 'Call tools as `await tools.name(args)` per the declarations in the system prompt. Curate the program output. '
  + 'The program contains TypeScript REPL statements; only erasable syntax is accepted. Top-level declarations '
  + 'and await are supported; top-level return is not supported. Emit output with console.log(...) or a final '
  + 'lossless JSON expression.'

const system = [
  'You are a coding agent powered by the model. Your working directory is the project root.',
  '',
  'All tool calls happen inside run_code programs. The available APIs:',
  '  tools.ops_load_sdk({ tools: string[] })',
  '  tools.ops_glob({ pattern: string|string[], limit?: number })',
  '  tools.ops_grep({ pattern: string, path?: string, limit?: number })',
  '  tools.ops_read_files({ files: [{ path: string, offset?: number, limit?: number }] })',
  '  tools.ops_inspect_local_file({ path: string, offset?: number, limit?: number })',
  '  tools.ops_stat({ path: string })',
  '  tools.ops_edit_file({ path: string, expectedRevision?: string, edits: [{ oldText: string, newText: string }] })',
  'ops_inspect_local_file is resident; every other name is loaded by ops_load_sdk, which takes effect on the',
  'NEXT program. Write files only through ops_edit_file.',
  // The tool contract, restated here so the A/B isolates scoping: the same sentence is in
  // the shipped run_code description, and a program that returns never runs.
  'A program cannot return: emit output with console.log(...) and nothing else.',
  '',
  guidance,
].join('\n')

const TASK = 'Audit the six TypeScript modules under src/. For each module report its line count and whether it '
  + 'imports ./core. Then write report.md with one line per module: "<name> <lines> imports-core=<yes|no>". '
  + 'Finish with a one-sentence summary.'

const messages = [{ role: 'system', content: system }, { role: 'user', content: TASK }]

async function chat() {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: [{ type: 'function', function: {
      name: 'run_code', description: RUN_CODE_DESCRIPTION,
      parameters: { type: 'object', properties: { code: { type: 'string' }, description: { type: 'string' } },
        required: ['code', 'description'] } } }], tool_choice: 'auto', max_tokens: 4096 }),
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response.json()
}

/** One retained REPL for the whole run, started the way the host starts it. */
const captured = []
const input = new PassThrough()
const output = new Writable({ write(chunk, _encoding, callback) { captured.push(chunk.toString()); callback() } })
const repl = start({ input, output, terminal: false, prompt: '', useGlobal: false, ignoreUndefined: true })
Object.defineProperty(repl.context, 'tools', { configurable: true, enumerable: true, writable: true, value: tools })

function evaluate(code) {
  return new Promise(resolve => {
    captured.length = 0
    let settled = false
    const finish = value => { if (!settled) { settled = true; resolve(value) } }
    const timer = setTimeout(() => finish({ ok: false, text: captured.join('').trim() }), 400)
    repl.eval(code + '\n', repl.context, 'ptc-repl', (error, value) => {
      clearTimeout(timer)
      const printed = captured.join('').trim()
      finish(error ? { ok: false, text: `${error.name}: ${error.message}` } : { ok: true, text: printed || (value === undefined ? '' : JSON.stringify(value)) })
    })
  })
}

const programs = []
let steps = 0
let final = ''
while (steps < maxSteps) {
  steps += 1
  const reply = await chat()
  const message = reply.choices?.[0]?.message ?? {}
  const calls = message.tool_calls ?? []
  messages.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) })
  if (!calls.length) { final = message.content ?? ''; break }
  for (const call of calls) {
    let args = {}
    try { args = JSON.parse(call.function.arguments ?? '{}') } catch { /* keep empty */ }
    const outcome = await evaluate(String(args.code ?? ''))
    const redeclared = /already been declared/u.test(outcome.text)
    programs.push({ step: steps, chars: String(args.code ?? '').length, redeclared, first: outcome.text.split('\n')[0].slice(0, 120), code: String(args.code ?? '').slice(0, 400),
      names: [...outcome.text.matchAll(/Identifier '([^']+)' has already been declared/gu)].map(m => m[1]),
      ok: outcome.ok })
    messages.push({ role: 'tool', tool_call_id: call.id,
      content: outcome.ok ? (outcome.text || '(no output)')
        : `Error: code run failed (exception): Uncaught ${outcome.text.split('\n')[0]}\nFile sandbox: danger-full-access.` })
  }
}
repl.close()
input.destroy()
output.destroy()

const failed = programs.filter(p => p.redeclared)
const names = [...new Set(failed.flatMap(p => p.names))]
const report = { guidance: guidancePath, model: MODEL, steps, programs: programs.length,
  redeclared: failed.length, names, writes: readdirSync(root).includes('report.md'), final: final.slice(0, 160) }
if (process.argv.includes('--json')) console.log(JSON.stringify({ ...report, detail: programs }, null, 2))
else {
  console.log(`${path.basename(guidancePath)}: ${programs.length} program(s) in ${steps} step(s), `
    + `${failed.length} discarded by a redeclaration${names.length ? ' (' + names.join(', ') + ')' : ''}`)
  for (const program of programs) {
    console.log(`  ${program.redeclared ? 'REDECLARE' : program.ok ? 'ok        ' : 'error     '} step ${program.step}${program.names.length ? ' ' + program.names.join(',') : ''}`)
  }
}
