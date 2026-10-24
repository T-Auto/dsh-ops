#!/usr/bin/env node
/**
 * The data panel: a single-file, zero-dependency, offline viewer for ONE run document, honouring the
 * three hard boundaries of issue #205 §1/#4 as properties of the code: (1) **data lives in JSON
 * only** — the document is read once for its contract version and dropped, the template's only
 * substitution is the data file's *name*, and the page fetches it at view time; (2) **HTML is a
 * viewer** — every value is written with `textContent`, so a `<script>` in a transcript is displayed,
 * never parsed, and "纯文本模式" degrades every tab to plain text (Inspect's `--no-trust-content`);
 * (3) **file:// fallback plus a local server** — the page also takes a dropped/picked file, and
 * `--serve <dir>` runs a zero-dependency `node:http` server on 127.0.0.1 and an ephemeral port. The
 * reader knows nothing about the runner, on purpose: the bench sweep and the runtime collection
 * (P14) are two producers of one contract. `test/bench-panel.test.mjs` proves the no-inline-data
 * property with a sentinel planted in every string field. The reader knows nothing about the runner
 * on purpose: the bench sweep and the runtime collection (P14) share one contract.
 * @module dsh-ops/bench/report/panel
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The one file this module writes, and the only page it serves. */
export const PANEL_FILE = 'panel.html'
/** The contract revision this reader understands (`bench/run.schema.json`). */
export const PANEL_SCHEMA_VERSION = 1
/** The only interface the server binds: a loopback address, never `0.0.0.0`. */
export const PANEL_HOST = '127.0.0.1'
/** Exit codes, numerically equal to `bench/cli.mjs`'s `EXIT`. */
export const EXIT = { ok: 0, failure: 1, usage: 2 }
/** The canonical payload the page documents as "always text, never markup". */
const XSS_EXAMPLE = '<script>alert(1)</script>'

/** Escape `& < > " '` for an HTML context (the page itself needs this only for static text). */
export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** File extension -> content type; an unknown extension is served as binary. */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
}

/** The whole page: a constant whose only substitution is the data file's name (configuration). */
function panelHtml(dataFile) {
  return HTML_TEMPLATE
    .split('__DATA_FILE_JSON__').join(JSON.stringify(dataFile).replace(/</g, '\\u003c'))
    .split('__DATA_FILE__').join(escapeHtml(dataFile))
    .split('__XSS_EXAMPLE__').join(escapeHtml(XSS_EXAMPLE))
}

/**
 * The page template. Two rules for editors: no `${` and no backticks (it is a template literal),
 * and no value that came out of a run document — a field belongs in `run.json`.
 */
const HTML_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-ops panel · 读 JSON 的查看器</title>
<style>
:root{--bg:#10131a;--card:#171b23;--fg:#e7eaf0;--dim:#98a2b3;--line:#262c38;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Segoe UI",system-ui,"Noto Sans SC",sans-serif}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.dim{color:var(--dim)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
header{padding:12px 16px 8px;border-bottom:1px solid var(--line)}h1{font-size:15px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 8px}h3{font-size:13px;margin:0 0 8px;color:var(--dim)}
.controls{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:8px}input[type=file]{color:var(--dim)}
button{background:#21262d;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer}
button[aria-selected=true]{background:var(--accent);border-color:var(--accent);color:#06101f;font-weight:600}
#conclusion{margin:12px 16px;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card)}.verdict{font-size:15px}
.chip{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--line);font-size:12px;margin-right:6px}
.chip.ok{color:var(--ok);border-color:var(--ok)}.chip.bad{color:var(--bad);border-color:var(--bad)}
nav{display:flex;gap:6px;padding:0 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}main{padding:0 16px 24px}.tab[hidden]{display:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--dim)}td.num,th.num{text-align:right}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12.5px}pre.plain{background:#0b0e14;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:70vh;overflow:auto}
.badge{grid-column:1/-1;color:var(--warn);border-top:1px dashed var(--warn);border-bottom:1px dashed var(--warn);padding:2px 6px;font-size:12px}
.turn-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;border-bottom:1px solid var(--line);padding:6px 0}
.turn{background:var(--card);border:1px solid var(--line);border-left-width:3px;border-radius:6px;padding:8px 10px;min-width:0}.turn.tool_call{border-left-color:var(--accent)}.turn.tool_result{border-left-color:#7ee787}.turn.thinking{border-left-color:#bc8cff}.turn.final{border-left-color:var(--ok)}
.lane{display:grid;grid-template-columns:82px 96px 1fr;gap:8px;padding:3px 6px;border-bottom:1px solid var(--line);align-items:start}.lane .t{color:var(--dim);font-size:12px}.lane .l{font-size:12px}
.lane-tool .l{color:var(--accent)}.lane-stall .l{color:var(--bad);font-weight:700}.lane-milestone .l,.lane-stderr .l{color:var(--warn)}.lane-boot .l,.lane-outcome .l{color:var(--ok)}
.bars{display:grid;grid-template-columns:minmax(90px,200px) 1fr 74px;gap:6px 10px;align-items:center;font-size:12.5px}
.bar{height:9px;background:#0b0e14;border:1px solid var(--line);border-radius:4px;overflow:hidden}.bar span{display:block;height:100%;background:var(--accent)}
.fallback{margin:16px;padding:14px;border:1px dashed var(--warn);border-radius:8px}.dropping{outline:2px dashed var(--accent);outline-offset:-6px}
footer{padding:12px 16px 28px;border-top:1px solid var(--line);font-size:12.5px}
</style>
</head>
<body>
<header>
  <h1>dsh-ops panel <span class="dim">· 读 JSON 的查看器(不内联数据)</span></h1>
  <div class="dim mono">数据源:__DATA_FILE__(同目录,只读)</div>
  <div class="controls"><label><input type="checkbox" id="plain"> 纯文本模式</label>
    <button type="button" id="reload">重新读取</button><span class="dim" id="status">正在读取 __DATA_FILE__ …</span></div>
</header>
<section id="conclusion" aria-label="结论条">
  <div class="verdict" id="verdict">读取中 …</div>
  <div class="dim" id="noise"></div>
</section>
<nav id="tabs" role="tablist" aria-label="面板标签">
  <button type="button" role="tab" data-tab="overview" aria-selected="true">概览</button><button type="button" role="tab" data-tab="conversation" aria-selected="false">对话</button>
  <button type="button" role="tab" data-tab="trace" aria-selected="false">轨迹</button><button type="button" role="tab" data-tab="scoring" aria-selected="false">判卷</button>
  <button type="button" role="tab" data-tab="raw" aria-selected="false">原始 JSON</button>
</nav>
<main>
  <section class="tab" id="panel-overview" role="tabpanel" aria-label="概览"></section>
  <section class="tab" id="panel-conversation" role="tabpanel" aria-label="对话" hidden></section>
  <section class="tab" id="panel-trace" role="tabpanel" aria-label="轨迹" hidden></section><section class="tab" id="panel-scoring" role="tabpanel" aria-label="判卷" hidden></section>
  <section class="tab" id="panel-raw" role="tabpanel" aria-label="原始 JSON" hidden></section>
</main>
<section class="fallback" id="fallback" hidden aria-label="file:// 回退">
  <h2>读不到 __DATA_FILE__</h2>
  <p>直接双击(<code>file://</code>)时 <code>fetch</code> 会被 CORS 拦下。选择同目录的 JSON,或把它拖到本页任意位置:
  <input type="file" id="pick" accept=".json,.ndjson,application/json"></p>
  <p class="dim" id="fallback-error"></p>
</section>
<footer class="dim">
  <p>安全寿命:本页不解析任何来自 JSON 的文本 —— 每个值都写进 <code>textContent</code>,页面里没有任何把字符串当
  HTML 解析的接口,所以 <code>__XSS_EXAMPLE__</code> 只会原样显示。勾选「纯文本模式」可把标签页降级为纯文本。
  零依赖、可离线;<code>file://</code> 双击用上面的文件选择/拖拽,或跑 <code>node bench/cli.mjs panel --serve &lt;dir&gt;</code>。</p>
</footer>
<script>
'use strict'
/* This page carries no run data: DATA_FILE is fetched at view time and written as text. */
const DATA_FILE = __DATA_FILE_JSON__
const TABS = ['overview', 'conversation', 'trace', 'scoring', 'raw']
const PANEL_ID = { overview: 'panel-overview', conversation: 'panel-conversation', trace: 'panel-trace', scoring: 'panel-scoring', raw: 'panel-raw' }
const EVENT_OF = new Map()
const PICK = { task: null, repeat: null, arm: 'base' }
let RUN = null, SUMMARY = null, PLAIN = false, TAB = 'overview'
const $ = (id) => document.getElementById(id)
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const arr = (v) => (Array.isArray(v) ? v : [])
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)
const has = (v) => typeof v === 'number' && isFinite(v)
const int = (v) => num(v).toLocaleString('en-US')
const pct = (v) => (has(v) ? (v > 0 ? '+' : '') + v.toFixed(1) + '%' : 'n/a')
const j = (v) => { try { const t = JSON.stringify(v); return t === undefined ? String(v) : t } catch (e) { return String(v) } }
const clip = (v, n) => { const t = typeof v === 'string' ? v : j(v); return t.length > n ? t.slice(0, n) + ' …(共 ' + t.length + ' 字符)' : t }
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n }
const add = (parent, kids) => { kids.forEach((k) => { if (k) parent.appendChild(k) }); return parent }
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n }
const plain = (n, v) => n.appendChild(el('pre', 'plain', typeof v === 'string' ? v : j(v)))
const rowPass = (r) => { const c = arr(obj(r).verify); return c.length > 0 && c.every((x) => x.pass === true) }
const tokens = (u) => { const t = obj(u); return num(t.inputTokens) + num(t.outputTokens) + num(t.cacheReadTokens) + num(t.cacheWriteTokens) + num(t.reasoningTokens) }
const eventsOf = (r) => (EVENT_OF.has(r) ? EVENT_OF.get(r) : arr(obj(obj(r).events).inline))
const pairKeys = () => [SUMMARY.baseKey, SUMMARY.candKey]
/* A trace item is either a narrated row ({role, kind, text, event}) or a raw event itself. */
const eventOf = (item) => { const n = obj(item); const e = obj(n.event); return Object.keys(e).length > 0 ? e : n }
/** The arm keys the document describes (base/cand), their labels, and label -> key. */
function armLabel(run, key) { return str(obj(obj(run.arms)[key]).label) || str(obj(obj(obj(run).meta).arms[key]).label) || key }
function armIndex(run) {
  const keys = []
  for (const source of [obj(run.arms), obj(obj(run).meta).arms]) for (const key in source) if (hasOwn(source, key)) keys.push(key)
  const list = keys.length > 0 ? keys : ['base', 'cand']
  const keyOf = {}
  list.forEach((key) => { keyOf[key] = key; keyOf[armLabel(run, key)] = key })
  return { list, keyOf }
}
/** The A/A noise floor if the document carries one: contract v1 does not define the field. */
function noiseOf(run) {
  for (const candidate of [run.noise, obj(run.meta).noise, run.noiseFloor, obj(run.compare).noise]) {
    if (has(candidate)) return { pct: candidate, source: 'document' }
    for (const key of ['pct', 'percent', 'aaPct', 'noisePct']) if (has(obj(candidate)[key])) return { pct: obj(candidate)[key], source: 'document' }
  }
  return { pct: null, source: 'contract' }
}
/** Per-step token totals when the events carry status/step_end usage; [] otherwise. */
function stepTotals(rows) {
  const totals = {}
  let max = 0
  rows.forEach((row) => eventsOf(row).forEach((item) => {
    const event = eventOf(item)
    if (event.type !== 'status' || event.phase !== 'step_end' || tokens(event.usage) <= 0) return
    const step = num(event.step) || max + 1
    totals[step] = num(totals[step]) + tokens(event.usage)
    if (step > max) max = step
  }))
  const list = []
  for (let step = 1; step <= max; step += 1) list.push({ step, tokens: num(totals[step]) })
  return list
}
/** Every number the five tabs show, derived from the document alone. */
function buildSummary(run) {
  const rows = arr(obj(run).results)
  const { list: keys, keyOf } = armIndex(run)
  const [baseKey, candKey = keys[0]] = keys
  const blank = (key, label) => ({ key, label, rows: [], tokens: 0, pass: 0, fail: 0, tools: {}, steps: [] })
  const arms = {}
  const tasks = []
  const taskIndex = {}
  const keyFor = (row) => keyOf[str(row.arm)] || str(row.arm)
  keys.forEach((key) => { arms[key] = blank(key, armLabel(run, key)) })
  rows.forEach((row) => {
    const key = keyFor(row)
    const arm = arms[key] || (arms[key] = blank(key, key))
    const metrics = obj(row.metrics)
    arm.rows.push(row)
    arm.tokens += tokens(metrics.usage)
    if (rowPass(row)) arm.pass += 1; else arm.fail += 1
    for (const name in obj(metrics.toolCallsByName)) arm.tools[name] = num(arm.tools[name]) + num(obj(metrics.toolCallsByName)[name])
    const id = str(row.taskId)
    if (!hasOwn(taskIndex, id)) { taskIndex[id] = { id, arms: {} }; tasks.push(taskIndex[id]) }
    const slot = taskIndex[id].arms[key] || (taskIndex[id].arms[key] = { rows: [], tokens: 0, pass: true, checks: 0, failed: 0 })
    slot.rows.push(row)
    slot.tokens += tokens(metrics.usage)
    slot.checks += arr(row.verify).length
    slot.failed += arr(row.verify).filter((check) => check.pass !== true).length
    slot.pass = slot.pass && rowPass(row)
  })
  const pairs = { count: 0, total: 0, base: 0, cand: 0, deltaPct: null }
  const paired = {}
  rows.forEach((row) => {
    const id = str(row.taskId) + '#' + str(row.repeatIndex)
    if (!hasOwn(paired, id)) paired[id] = {}
    paired[id][keyFor(row)] = row
  })
  for (const id in paired) {
    const base = paired[id][baseKey]
    const cand = paired[id][candKey]
    if (!base || !cand) continue
    pairs.total += 1
    // 通过率先行: only a pair where BOTH sides pass, and both reported usage, carries a cost claim.
    if (!rowPass(base) || !rowPass(cand)) continue
    if (obj(base.metrics).usageReported !== true || obj(cand.metrics).usageReported !== true) continue
    pairs.count += 1
    pairs.base += tokens(obj(base.metrics).usage)
    pairs.cand += tokens(obj(cand.metrics).usage)
  }
  if (pairs.base > 0) pairs.deltaPct = ((pairs.cand - pairs.base) / pairs.base) * 100
  const noise = noiseOf(run)
  const steps = {}
  keys.forEach((key) => { steps[key] = stepTotals(arms[key].rows) })
  return {
    baseKey, candKey, arms, tasks, rows, pairs, noise, steps, keyOf,
    degraded: obj(obj(run).verify).degraded === true,
    readable: pairs.deltaPct !== null && noise.pct !== null && Math.abs(pairs.deltaPct) > noise.pct,
  }
}
/** One row's conversation: assistant text, thinking, tool calls and results, in order. */
function turnsOf(row) {
  return eventsOf(row).map((item) => {
    const narrated = obj(item)
    const event = eventOf(item)
    const kind = str(narrated.kind) || str(event.type) || 'note'
    const text = str(narrated.text) || clip(event, 300)
    if (event.type === 'text' || kind === 'text') return { kind: 'assistant', text: str(event.text) || text }
    if (event.type === 'thinking' || kind === 'thinking') return { kind: 'thinking', text: str(event.text) || text }
    if (kind === 'tool_call' || kind === 'tool') return { kind: 'tool_call', text: str(event.tool || event.name) ? 'tool ' + str(event.tool || event.name) + ' ← ' + clip(event.input, 4000) : text }
    if (kind === 'tool_result' || kind === 'tool_result_error') return { kind: 'tool_result', text: str(event.result) ? 'tool result ' + str(event.status) + ' ' + clip(event.result, 4000) : text }
    if (event.type === 'final' || kind === 'final') return { kind: 'final', text: str(event.text) || text }
    return { kind: 'note', text }
  })
}
/** The index of the first turn that differs between the two arms, or -1 for identical. */
function divergence(a, b) {
  const squash = (text) => str(text).replace(/\\s+/g, ' ').trim()
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index]
    const right = b[index]
    if (!left || !right) return index
    if (left.kind !== right.kind || squash(left.text) !== squash(right.text)) return index
  }
  return -1
}
/** One trace line: which lane, what it says, and when (offset or clock time). */
function lane(item) {
  const narrated = obj(item)
  const event = eventOf(item)
  const type = str(event.type) || str(narrated.kind)
  const role = str(narrated.role)
  const name = role || (type === 'tool_call' || type === 'tool_result' ? 'tool' : type === 'heartbeat' || type === 'stall' || type === 'milestone' ? type : 'event')
  let text = str(narrated.text)
  if (text === '' && event.type === 'status' && event.phase === 'step_end') text = 'step ' + num(event.step) + ': ' + tokens(event.usage) + ' tokens'
  if (text === '' && event.type === 'tool_call') text = 'tool ' + str(event.tool) + ' ← ' + clip(event.input, 400)
  if (text === '' && event.type === 'tool_result') text = 'tool result ' + str(event.status) + ' ' + clip(event.result, 400)
  const at = str(narrated.at) || str(event.at)
  const time = has(narrated.offsetMs) ? '+' + (num(narrated.offsetMs) / 1000).toFixed(1) + 's' : at ? at.replace('T', ' ').replace(/Z$/, '').slice(11, 23) : ''
  return { lane: name, text: text || (type || 'event') + ' ' + clip(event, 400), time }
}
/** Append a table (every cell text, never markup). */
function table(node, headers, rows) {
  const head = el('thead')
  const headRow = el('tr')
  headers.forEach((cell) => headRow.appendChild(el('th', cell.num ? 'num' : null, cell.label)))
  head.appendChild(headRow)
  const body = el('tbody')
  rows.forEach((cells) => {
    const tr = el('tr')
    cells.forEach((cell, index) => tr.appendChild(el('td', headers[index] && headers[index].num ? 'num' : null, cell)))
    body.appendChild(tr)
  })
  add(node, [head, body])
}
/** Append labelled horizontal bars, scaled to the largest value. */
function bars(node, items) {
  const max = Math.max(1, ...items.map((item) => item.value))
  const wrap = el('div', 'bars')
  items.forEach((item) => {
    const track = el('div', 'bar')
    const fill = el('span')
    fill.style.width = ((item.value / max) * 100) + '%'
    track.appendChild(fill)
    add(wrap, [el('span', 'dim', item.label), track, el('span', 'mono', item.text)])
  })
  node.appendChild(wrap)
}
/** A select bound to a change handler; option values are strings by construction. */
function select(label, options, value, onPick) {
  const wrap = el('label', 'dim')
  wrap.appendChild(document.createTextNode(label + ' '))
  const node = el('select')
  options.forEach((option) => {
    const item = el('option', null, option.label)
    item.value = String(option.value)
    if (String(option.value) === String(value)) item.selected = true
    node.appendChild(item)
  })
  node.addEventListener('change', () => onPick(node.value))
  wrap.appendChild(node)
  return wrap
}
/** The task / repeat / arm pickers the conversation and trace tabs share. */
function controlBar(withArm) {
  const tasks = []
  const repeats = []
  SUMMARY.rows.forEach((row) => {
    const id = str(row.taskId)
    const index = num(row.repeatIndex)
    if (!tasks.some((item) => item.value === id)) tasks.push({ value: id, label: id })
    if (!repeats.some((item) => item.value === index)) repeats.push({ value: index, label: 'repeat ' + index })
  })
  const pick = (label, options, value, set) => select(label, options, value, (next) => { set(next); renderTab() })
  const bar = el('div', 'controls')
  add(bar, [
    pick('任务', tasks, PICK.task, (v) => { PICK.task = v }),
    pick('重复', repeats, PICK.repeat, (v) => { PICK.repeat = Number(v) }),
    withArm ? pick('arm', pairKeys().map((key) => ({ value: key, label: SUMMARY.arms[key].label })), PICK.arm, (v) => { PICK.arm = v }) : null,
  ])
  return bar
}
function pickRow(taskId, repeatIndex, armKey) {
  for (const row of SUMMARY.rows) {
    const key = SUMMARY.keyOf[str(row.arm)] || str(row.arm)
    if (str(row.taskId) === str(taskId) && num(row.repeatIndex) === num(repeatIndex) && key === str(armKey)) return row
  }
  return null
}
/** The conclusion bar: pass rate first, then paired tokens, then whether a direction reads. */
function renderConclusion() {
  const verdict = clear($('verdict'))
  const noise = clear($('noise'))
  if (!SUMMARY) { verdict.textContent = '读取中 …'; return }
  const base = SUMMARY.arms[SUMMARY.baseKey]
  const cand = SUMMARY.arms[SUMMARY.candKey]
  let regressions = 0
  SUMMARY.tasks.forEach((task) => {
    const before = task.arms[SUMMARY.baseKey]
    const after = task.arms[SUMMARY.candKey]
    if (before && before.pass && after && !after.pass) regressions += 1
  })
  add(verdict, [
    el('span', 'chip ' + (regressions > 0 ? 'bad' : 'ok'), regressions > 0 ? '⚠' : '✅'),
    el('span', null, '通过率 ' + (regressions > 0 ? regressions + ' 个任务出现回归' : '无回归') + ' · ' + base.label + ' ' + base.pass + '/' + base.rows.length + ' → ' + cand.label + ' ' + cand.pass + '/' + cand.rows.length),
    el('span', 'dim', ' · token Δ ' + pct(SUMMARY.pairs.deltaPct) + '(配对 ' + SUMMARY.pairs.count + '/' + SUMMARY.pairs.total + ') · '),
    el('span', SUMMARY.degraded ? 'warn' : 'dim', SUMMARY.degraded ? '有行无法支撑成本结论(usage 未报全/超时)' : 'usage 全报'),
  ])
  noise.textContent = SUMMARY.noise.pct === null
    ? '噪声底(A/A):n/a —— 本契约(run.schema.json v1)没有 A/A 字段,只报区间不报方向。' + (SUMMARY.pairs.deltaPct === null ? '' : '本次配对 Δ 为 ' + pct(SUMMARY.pairs.deltaPct) + ',仅供参考。')
    : '噪声底(A/A)±' + SUMMARY.noise.pct.toFixed(1) + '% → ' + (SUMMARY.readable ? '超过噪声 ⇒ 可读方向' : '落在噪声内 ⇒ 只报区间,不报方向')
}
function renderOverview(node) {
  const environment = el('div', 'card')
  environment.appendChild(el('h3', null, 'Platform / component configuration'))
  environment.appendChild(el('pre', null, JSON.stringify({ platform: obj(RUN.meta).platform || 'unknown', components: Object.fromEntries(Object.entries(obj(RUN.arms)).map(([key, arm]) => [key, obj(arm).components || null])) }, null, 2)))
  node.appendChild(environment)
  const keys = pairKeys()
  const taskRows = SUMMARY.tasks.map((task) => {
    const base = task.arms[keys[0]]
    const cand = task.arms[keys[1]]
    const delta = base && cand && base.tokens > 0 ? ((cand.tokens - base.tokens) / base.tokens) * 100 : null
    return [task.id, base ? int(base.tokens) : '-', cand ? int(cand.tokens) : '-', pct(delta),
      (base ? (base.pass ? '✅' : '❌') : '—') + '→' + (cand ? (cand.pass ? '✅' : '❌') : '—')]
  })
  const pairCard = el('div', 'card')
  pairCard.appendChild(el('h3', null, '每任务配对(task / base / cand / Δ% / pass)'))
  table(pairCard, [{ label: 'task' }, { label: 'base', num: true }, { label: 'cand', num: true }, { label: 'Δ%', num: true }, { label: 'pass(base→cand)' }], taskRows)
  const noiseCard = el('div', 'card')
  noiseCard.appendChild(el('h3', null, '噪声条(A/A 噪声带 vs 本次 Δ)'))
  const delta = SUMMARY.pairs.deltaPct
  bars(noiseCard, [
    { label: 'A/A 噪声带', value: num(SUMMARY.noise.pct), text: SUMMARY.noise.pct === null ? 'n/a' : '±' + SUMMARY.noise.pct.toFixed(1) + '%' },
    { label: '本次 Δ', value: Math.abs(num(delta)), text: pct(delta) },
  ])
  noiseCard.appendChild(el('p', 'dim', SUMMARY.noise.pct === null
    ? '契约 v1 没有 A/A 字段,画不出噪声带 ⇒ 只报区间,不报方向。'
    : '本次 Δ ' + pct(delta) + (SUMMARY.readable ? ' 超过噪声 ⇒ 可读方向' : ' 落在噪声内 ⇒ 只报区间')))
  const stepCard = el('div', 'card')
  stepCard.appendChild(el('h3', null, 'token 归因(按 step,来自事件里的 step_end usage)'))
  const stepBars = keys.flatMap((key) => SUMMARY.steps[key].map((item) => ({ label: SUMMARY.arms[key].label + ' · step ' + item.step, value: item.tokens, text: int(item.tokens) })))
  if (stepBars.length === 0) stepCard.appendChild(el('p', 'dim', '事件里没有逐步 usage(status/step_end + usage),无法按 step 归因;此处留位。'))
  else bars(stepCard, stepBars)
  const toolCard = el('div', 'card')
  toolCard.appendChild(el('h3', null, '工具归因(调用次数;契约没有逐工具 token 桶)'))
  const names = {}
  keys.forEach((key) => Object.keys(SUMMARY.arms[key].tools).forEach((name) => { names[name] = 1 }))
  const toolBars = Object.keys(names).sort().flatMap((name) => keys.map((key) => ({ label: SUMMARY.arms[key].label + ' · ' + name, value: num(SUMMARY.arms[key].tools[name]), text: int(SUMMARY.arms[key].tools[name]) })))
  if (toolBars.length === 0) toolCard.appendChild(el('p', 'dim', 'metrics.toolCallsByName 为空,没有可分组的工具调用。'))
  else bars(toolCard, toolBars)
  node.appendChild(el('h2', null, '概览'))
  const grid = el('div', 'grid')
  add(grid, [pairCard, noiseCard, stepCard, toolCard])
  node.appendChild(grid)
}
function turnCell(turn) {
  if (!turn) return el('div', 'turn dim', '(该轮缺失)')
  const cell = el('div', 'turn ' + turn.kind)
  cell.appendChild(el('span', 'chip', turn.kind))
  cell.appendChild(el('pre', null, clip(turn.text, 4000)))
  return cell
}
function renderConversation(node) {
  node.appendChild(el('h2', null, '对话(左 base / 右 cand,同任务同 repeat;首个分歧点加标记)'))
  node.appendChild(controlBar(false))
  const baseRow = pickRow(PICK.task, PICK.repeat, SUMMARY.baseKey)
  const candRow = pickRow(PICK.task, PICK.repeat, SUMMARY.candKey)
  if (!baseRow || !candRow) { node.appendChild(el('p', 'dim', '这一 task/repeat 没有两侧成对的行。')); return }
  const baseTurns = turnsOf(baseRow)
  const candTurns = turnsOf(candRow)
  const diverge = divergence(baseTurns, candTurns)
  node.appendChild(el('p', 'dim', 'base = ' + SUMMARY.arms[SUMMARY.baseKey].label + ' · cand = ' + SUMMARY.arms[SUMMARY.candKey].label
    + ' · 轮数 ' + baseTurns.length + '/' + candTurns.length + (diverge === -1 ? ' · 逐轮一致' : ' · 首个分歧点:第 ' + (diverge + 1) + ' 轮 ▼')))
  const wrap = el('div', 'convo')
  for (let index = 0; index < Math.max(baseTurns.length, candTurns.length); index += 1) {
    if (index === diverge) wrap.appendChild(el('div', 'badge', '▼ 首个分歧点(第 ' + (index + 1) + ' 轮)'))
    const line = el('div', 'turn-row')
    add(line, [turnCell(baseTurns[index]), turnCell(candTurns[index])])
    wrap.appendChild(line)
  }
  node.appendChild(wrap)
}
function renderTrace(node) {
  node.appendChild(el('h2', null, '轨迹(时间线 tool_call / tool_result / 里程碑 / 心跳 / stall)'))
  const row = pickRow(PICK.task, PICK.repeat, PICK.arm)
  node.appendChild(controlBar(true))
  if (!row) { node.appendChild(el('p', 'dim', '没有匹配的行。')); return }
  const events = eventsOf(row)
  node.appendChild(el('p', 'dim', '共 ' + events.length + ' 条事件;' + (obj(row.events).format === 'ndjson'
    ? '本行事件仍在 NDJSON 文件里(' + str(obj(row.events).file) + '),file:// 下读不到时请用 --serve。'
    : '事件内联在这份 JSON 里。')))
  if (events.length === 0) { node.appendChild(el('p', 'dim', '这一行没有事件。')); return }
  events.forEach((item) => {
    const line = lane(item)
    const rowNode = el('div', 'lane lane-' + line.lane)
    add(rowNode, [el('span', 't', line.time), el('span', 'l', line.lane), el('pre', null, line.text)])
    node.appendChild(rowNode)
  })
}
function renderScoring(node) {
  node.appendChild(el('h2', null, '判卷(verifier 明细:检查项 / 期望 / 实际 / 证据路径)'))
  const rollup = obj(obj(RUN).verify)
  node.appendChild(el('p', 'dim', 'run 汇总:checks ' + int(rollup.checks) + ' · passed ' + int(rollup.passed) + ' · failed ' + int(rollup.failed) + ' · degraded ' + String(rollup.degraded === true)))
  arr(rollup.notes).forEach((note) => node.appendChild(el('p', 'warn', 'note: ' + str(note))))
  SUMMARY.rows.forEach((row) => {
    const card = el('div', 'card')
    card.appendChild(el('h3', null, str(row.taskId) + ' · repeat ' + num(row.repeatIndex) + ' · ' + str(row.arm) + ' · ' + (rowPass(row) ? '✅' : '❌')))
    const checks = arr(row.verify)
    if (checks.length === 0) card.appendChild(el('p', 'dim', '没有声明检查项。'))
    else table(card, [{ label: '检查项' }, { label: '目标' }, { label: '结果' }, { label: '期望/实际' }, { label: '证据路径' }],
      checks.map((check) => [str(check.type), str(check.target), check.pass === true ? '✅' : '❌', str(check.detail), str(check.evidence)]))
    node.appendChild(card)
  })
}
function copyRaw() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(j(RUN)).then(
      () => { $('status').textContent = '已复制原始 JSON' },
      () => { $('status').textContent = '复制失败(浏览器要求 https 或 localhost)' })
    return
  }
  $('status').textContent = '这个浏览器没有剪贴板接口,请手动选择文本'
}
function downloadRaw() {
  const url = URL.createObjectURL(new Blob([j(RUN)], { type: 'application/json' }))
  const link = el('a')
  link.href = url
  link.download = DATA_FILE.split('/').pop() || 'run.json'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function renderRaw(node) {
  node.appendChild(el('h2', null, '原始 JSON(只读视图 + 复制 + 下载)'))
  const bar = el('div', 'controls')
  const button = (label, handler) => { const node2 = el('button', null, label); node2.type = 'button'; node2.addEventListener('click', handler); return node2 }
  add(bar, [button('复制', copyRaw), button('下载', downloadRaw), el('span', 'dim', DATA_FILE + ' · ' + j(RUN).length + ' 字节')])
  node.appendChild(bar)
  node.appendChild(el('pre', 'plain', j(RUN)))
}
/** 纯文本模式:把当前标签的内容降级成一段文本,不画任何结构。 */
function plainSlice() {
  if (TAB === 'scoring') return j({ verify: obj(RUN).verify, rows: SUMMARY.rows.map((row) => ({ taskId: row.taskId, repeatIndex: row.repeatIndex, arm: row.arm, verify: row.verify })) })
  if (TAB === 'raw') return j(RUN)
  if (TAB === 'conversation') return pairKeys().flatMap((key) => {
    const row = pickRow(PICK.task, PICK.repeat, key)
    return ['=== ' + SUMMARY.arms[key].label + ' ==='].concat(row ? turnsOf(row).map((turn) => '[' + turn.kind + '] ' + turn.text) : ['(该 arm 没有这一行)'])
  }).join('\\n')
  if (TAB === 'trace') {
    const row = pickRow(PICK.task, PICK.repeat, PICK.arm)
    return row ? eventsOf(row).map((item) => lane(item).time + ' [' + lane(item).lane + '] ' + lane(item).text).join('\\n') : '(没有这一行)'
  }
  return j(SUMMARY)
}
function renderTab() {
  const node = clear($(PANEL_ID[TAB] || PANEL_ID.overview))
  if (!RUN) return
  if (PLAIN) { plain(node, plainSlice()); return }
  if (TAB === 'conversation') renderConversation(node)
  else if (TAB === 'trace') renderTrace(node)
  else if (TAB === 'scoring') renderScoring(node)
  else if (TAB === 'raw') renderRaw(node)
  else renderOverview(node)
}
function setTab(name) {
  TAB = TABS.includes(name) ? name : 'overview'
  document.querySelectorAll('#tabs button').forEach((button) => button.setAttribute('aria-selected', String(button.getAttribute('data-tab') === TAB)))
  TABS.forEach((key) => { $(PANEL_ID[key]).hidden = key !== TAB })
  renderTab()
}
/** A row's events: inline objects, or the NDJSON file the row still points at. */
function loadEvents(row) {
  const ref = obj(obj(row).events)
  if (arr(ref.inline).length > 0) return Promise.resolve(ref.inline)
  if (str(ref.file) === '') return Promise.resolve([])
  return fetch(str(ref.file), { cache: 'no-store' })
    .then((response) => (response.ok ? response.text() : ''))
    .then((text) => text.split('\\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch (error) { return { type: 'raw', text: line } }
    }))
    .catch(() => [])
}
async function adopt(run, source) {
  RUN = run
  EVENT_OF.clear()
  const rows = arr(obj(run).results)
  for (const row of rows) if (row && typeof row === 'object') EVENT_OF.set(row, await loadEvents(row))
  SUMMARY = buildSummary(run)
  if (rows.length > 0) { PICK.task = str(rows[0].taskId); PICK.repeat = num(rows[0].repeatIndex) }
  $('fallback').hidden = true
  $('status').textContent = '已读取 ' + source + '(' + rows.length + ' 行)'
  renderConclusion()
  setTab(TAB)
}
function showFallback(reason) {
  $('fallback').hidden = false
  $('fallback-error').textContent = '原因:' + reason + ' —— file:// 下 fetch 会被 CORS 拦,用上面的选择框/拖拽,或跑 --serve。'
  $('status').textContent = '未读到 ' + DATA_FILE
  $('verdict').textContent = '等待选择 JSON 文件 …'
}
function pickFile(file) {
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try { adopt(JSON.parse(String(reader.result)), file.name) }
    catch (error) { $('fallback-error').textContent = '不是合法 JSON:' + error.message }
  }
  reader.onerror = () => { $('fallback-error').textContent = '读取文件失败' }
  reader.readAsText(file)
}
async function boot() {
  $('verdict').textContent = '读取中 …'
  try {
    const response = await fetch(DATA_FILE + '?_=' + Date.now(), { cache: 'no-store' })
    if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText)
    await adopt(await response.json(), DATA_FILE)
  } catch (error) {
    showFallback(error && error.message ? error.message : String(error))
  }
}
function wire() {
  document.querySelectorAll('#tabs button').forEach((button) => button.addEventListener('click', () => setTab(button.getAttribute('data-tab'))))
  $('plain').addEventListener('change', (event) => { PLAIN = event.currentTarget.checked; renderTab() })
  $('reload').addEventListener('click', boot)
  $('pick').addEventListener('change', (event) => pickFile(event.currentTarget.files[0]))
  document.addEventListener('dragover', (event) => { event.preventDefault(); document.body.classList.add('dropping') })
  document.addEventListener('dragleave', () => document.body.classList.remove('dropping'))
  document.addEventListener('drop', (event) => {
    event.preventDefault()
    document.body.classList.remove('dropping')
    if (event.dataTransfer && event.dataTransfer.files.length) pickFile(event.dataTransfer.files[0])
  })
  boot()
}
wire()
</script>
</body>
</html>
`

/**
 * Read only what the reader needs to judge the document, never the document itself: an unknown
 * version is refused, an absent one is tolerated (P14 streams its document while filling it in).
 * @param {string} runJsonPath - the document to inspect.
 * @returns {number|null} the declared `schemaVersion`, or null when it is absent.
 */
export function readContractVersion(runJsonPath) {
  let document
  try {
    document = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'))
  } catch (error) {
    throw new Error(`${runJsonPath} is not JSON: ${error.message}`)
  }  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error(`${runJsonPath} must hold one JSON object (the run document)`)
  const version = document.schemaVersion
  if (version !== undefined && version !== PANEL_SCHEMA_VERSION) {
    throw new Error(`${runJsonPath} declares schemaVersion ${JSON.stringify(version)}; this panel reads ${PANEL_SCHEMA_VERSION} only (bench/run.schema.json)`)
  }
  return version ?? null
}

/**
 * Write `panel.html` where the run document can be fetched next to it. The document is read for its
 * contract version and then discarded — the returned object carries no field of it, which is what
 * makes "no inline data" a property of the code rather than of today's template.
 * @param {{runJsonPath: string, outDir: string, dataFile?: string|null}} options - the wiring.
 * @returns {{htmlPath: string, dataFile: string, bytes: number, schemaVersion: number|null, outsideRoot: boolean}} the written panel.
 */
export function renderPanel({ runJsonPath, outDir, dataFile = null } = {}) {
  if (typeof runJsonPath !== 'string' || runJsonPath === '') throw new Error('renderPanel needs runJsonPath (the run.json to view)')
  if (typeof outDir !== 'string' || outDir === '') throw new Error('renderPanel needs outDir (where panel.html goes)')
  const jsonPath = path.resolve(runJsonPath)
  const dir = path.resolve(outDir)
  const schemaVersion = readContractVersion(jsonPath)
  const relative = dataFile ?? path.relative(dir, jsonPath).split(path.sep).join('/')
  if (relative === '') throw new Error(`${jsonPath} is not a file below ${dir}`)
  fs.mkdirSync(dir, { recursive: true })
  const html = panelHtml(relative)
  const htmlPath = path.join(dir, PANEL_FILE)
  fs.writeFileSync(htmlPath, html)
  return { htmlPath, dataFile: relative, bytes: Buffer.byteLength(html, 'utf8'), schemaVersion, outsideRoot: relative.startsWith('..') }
}

/** Write a short plain-text response with the headers every response carries. */
function sendText(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

/**
 * A static-file server for one directory: `node:http` only, loopback only, no state. `/` redirects to
 * the panel, and a request that tries to leave the directory is refused rather than resolved.
 * @param {{dir: string}} options - the directory to serve.
 * @returns {import('node:http').Server} a server that is not listening yet.
 */
export function createPanelServer({ dir } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('createPanelServer needs dir')
  const root = path.resolve(dir)
  return http.createServer((request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') { sendText(response, 405, 'method not allowed: this server is read-only\n'); return }
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${PANEL_HOST}`).pathname)
    } catch {
      sendText(response, 400, 'bad request target\n')
      return
    }
    if (pathname === '/') {
      response.writeHead(302, { Location: `/${PANEL_FILE}`, 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    if (pathname.includes('\0')) { sendText(response, 400, 'bad path\n'); return }
    // Decode first, then normalize: an encoded "..%2f" must be collapsed before it is joined.
    const target = path.resolve(root, `.${path.posix.normalize(pathname)}`)
    if (target !== root && !target.startsWith(root + path.sep)) { sendText(response, 403, 'refused: outside the served directory\n'); return }
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      sendText(response, 404, `not in this directory: ${pathname}\n`)
      return
    }
    if (stat.isDirectory()) { sendText(response, 404, 'a directory, not a file\n'); return }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    if (method === 'HEAD') { response.end(); return }
    const stream = fs.createReadStream(target)
    stream.on('error', () => response.destroy())
    stream.pipe(response)
  })
}

/** Listen on the loopback interface and report the port the kernel chose (`port: 0` = ephemeral). */
export async function listenPanel(server, { host = PANEL_HOST, port = 0 } = {}) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port }, resolve)
  })
  return server.address().port
}

/** The panel's own help text. */
export function usage() {
  return [
    'usage: node bench/cli.mjs panel --out <dir> <run.json>',
    '       node bench/cli.mjs panel --serve <dir> [--port <n>]',
    '',
    '生成并查看一个读 run.json 的单文件面板(panel.html)。HTML 不内联任何数据:它 fetch 同目录的',
    'JSON;file:// 双击时用页面里的文件选择/拖拽。',
    '  --out <dir> <run.json>  写 panel.html,并按相对路径记录数据源',
    '  --serve <dir>           起零依赖 node:http 服务(只绑 127.0.0.1,默认自动选端口)',
    '  --port <n>              固定端口;默认 0(系统分配)    -h, --help  这段文字',
    '',
    '只读:服务只发静态文件,不写 ~/.dsh、不常驻、不注册 DSH 插件。',
  ].join('\n')
}

/**
 * Parse the panel's command line. Never throws: a malformed line comes back as `error`.
 * @param {string[]} [argv] - the arguments after `panel`.
 * @returns {{mode: string|null, dir: string|null, runJsonPath: string|null, port: number, help: boolean, error: string|null}} the parse.
 */
export function parsePanelArgs(argv = []) {
  const options = { mode: null, dir: null, runJsonPath: null, port: 0, help: false, error: null }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') { options.help = true; continue }
    if (flag === '--serve' || flag === '--out' || flag === '--port') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('-')) return { ...options, error: `this flag needs a value: ${flag}` }
      if (flag === '--port') {
        if (!/^\d+$/.test(value)) return { ...options, error: `--port needs an integer, got ${value}` }
        options.port = Number(value)
      } else if (options.mode !== null) return { ...options, error: 'use either --serve or --out, not both' }
      else { options.mode = flag === '--serve' ? 'serve' : 'render'; options.dir = value }
      index += 1
      continue
    }
    if (flag.startsWith('-')) return { ...options, error: `unknown option "${flag}"` }
    positional.push(flag)
  }
  if (options.help) return options
  if (positional.length > 1) return { ...options, error: `only one run.json is expected, got ${positional.length}` }
  if (options.mode === null) return { ...options, error: positional.length === 1 ? 'name the output directory: --out <dir> <run.json>' : 'nothing to do: pass --out <dir> <run.json> or --serve <dir>' }
  if (options.mode === 'render') {
    if (positional.length !== 1) return { ...options, error: '--out needs the run.json to read: --out <dir> <run.json>' }
    options.runJsonPath = positional[0]
  } else if (positional.length > 0) return { ...options, error: `--serve takes a directory only, got "${positional[0]}"` }
  return options
}

/** Render the panel and narrate what the next command should be. */
function renderMain(options, io) {
  let result
  try {
    result = renderPanel({ runJsonPath: options.runJsonPath, outDir: options.dir })
  } catch (error) {
    io.err(`bench panel: ${error.message}`)
    return EXIT.failure
  }
  io.out(`panel: wrote ${result.htmlPath} (${result.bytes} bytes, no run data inlined)`)
  io.out(`panel: data source ${result.dataFile} (the page fetches it from its own directory; schemaVersion ${result.schemaVersion ?? 'n/a'})`)
  if (result.outsideRoot) io.err(`bench panel: ${result.dataFile} is outside ${options.dir} — --serve only serves that directory; use --out <the run.json directory>`)
  io.out(`panel: open it with  node bench/cli.mjs panel --serve ${options.dir}   (or double-click ${PANEL_FILE} and pick the JSON)`)
  return EXIT.ok
}

/** Serve one directory in the foreground until Ctrl-C. */
async function serveMain(options, io) {
  const root = path.resolve(options.dir)
  if (!fs.existsSync(path.join(root, PANEL_FILE))) {
    io.err(`bench panel: ${PANEL_FILE} is not in ${root}`)
    io.err(`bench panel: render it first: node bench/cli.mjs panel --out ${options.dir} <run.json>`)
    return EXIT.failure
  }
  const server = createPanelServer({ dir: root })
  let port
  try {
    port = await listenPanel(server, { host: PANEL_HOST, port: options.port })
  } catch (error) {
    io.err(`bench panel: cannot listen on ${PANEL_HOST}:${options.port} — ${error.message}`)
    return EXIT.failure
  }
  io.out(`panel: http://${PANEL_HOST}:${port}/${PANEL_FILE}  (read-only, bound to ${PANEL_HOST}:${port})`)
  io.out('panel: the page fetches the data from this directory; the server only sends static files — no ~/.dsh state, no daemon, no DSH plugin; Ctrl-C stops it')
  const shutdown = () => {
    io.out('panel: closing')
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref?.()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return EXIT.ok
}

/**
 * The panel's CLI entry, called by `bench/cli.mjs` once `bench/report/panel.mjs` exists.
 * @param {string[]} argv - the arguments after `panel`.
 * @param {{out?: (line: string) => void, err?: (line: string) => void}} [io] - where to print.
 * @returns {Promise<number>} the exit code.
 */export async function main(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  const options = parsePanelArgs(argv)
  if (options.help) { out(usage()); return EXIT.ok }
  if (options.error) {
    err(`bench panel: ${options.error}`)
    err('run "node bench/cli.mjs panel --help" for usage')
    return EXIT.usage
  }
  return options.mode === 'render' ? renderMain(options, { out, err }) : serveMain(options, { out, err })
}

// Only when executed, not when imported by the suite.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
