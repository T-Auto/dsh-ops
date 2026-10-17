/**
 * The P12 floor: the panel writes a viewer that carries no run data, escapes by construction, and
 * serves itself and its document over a loopback http server.
 *
 * The sentinel is planted in every string field of the fixture, because "the HTML does not inline
 * data" is only as strong as the encodings it is checked against: raw, HTML-escaped, percent-encoded
 * and base64 are all probed. Nothing here runs a browser: the page's inline runtime is compile-checked
 * and its structure is asserted by id/tab, while `panel.mjs`'s own server is exercised over real HTTP.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { assert, PACKAGE_ROOT, report, test, waitFor, withTempDir } from './lib/harness.mjs'
import { PANEL_FILE, createPanelServer, escapeHtml, listenPanel, main, parsePanelArgs, renderPanel } from '../bench/report/panel.mjs'
import { main as cliMain } from '../bench/cli.mjs'

const SENTINEL = 'SENTINEL-p12 <must-not-be-inlined> & [quoted]'
const XSS = '<script>alert(1)</script>'

/** A contract-shaped document whose every string field carries the sentinel. */
function runDocument() {
  const usage = (input) => ({ inputTokens: input, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
  const row = (arm, input, pass) => ({
    taskId: `csv-sum-${SENTINEL}`,
    repeatIndex: 1,
    arm,
    metrics: { durationMs: 10, exit: 0, timedOut: false, steps: 1, toolCalls: 1, usage: usage(input), usageReported: true, toolCallsByName: { ['read-' + SENTINEL]: 1 } },
    verify: [{ type: 'fileEquals', target: 'answer.txt', pass, detail: pass ? '' : SENTINEL, evidence: 'evidence/' + SENTINEL }],
    events: { format: 'inline', count: 2, inline: [
      { type: 'status', phase: 'step_end', step: 1, usage: { inputTokens: input, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'text', text: XSS + SENTINEL },
    ] },
  })
  return {
    schemaVersion: 1,
    meta: { benchVersion: '0.0.0', mode: 'ab', platform: 'linux-x64', node: 'v0', dsh: null, model: 'm', gitSha: null, gitBranch: null, argv: [SENTINEL], startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, arms: { base: { label: 'bench-base', profile: 'p', profileHash: 'a' }, cand: { label: 'bench-ops', profile: 'p', profileHash: 'b' } } },
    arms: { base: { label: 'bench-base', profile: 'p', profileHash: 'a' }, cand: { label: 'bench-ops', profile: 'p', profileHash: 'b' } },
    results: [row('bench-base', 1000, true), row('bench-ops', 900, true)],
    verify: { checks: 2, passed: 2, failed: 0, degraded: false, notes: [SENTINEL] },
    events: { layout: 'ndjson-per-run', merged: true, mergedAt: null, files: [] },
    archive: [{ path: 'run.json', bytes: 1, sha256: null, role: 'run' }],
  }
}

/** Write the fixture and render the panel next to it; returns the HTML. */
function render(dir, run = runDocument()) {
  const runJsonPath = path.join(dir, 'run.json')
  fs.writeFileSync(runJsonPath, JSON.stringify(run, null, 2))
  const result = renderPanel({ runJsonPath, outDir: dir })
  return { result, html: fs.readFileSync(result.htmlPath, 'utf8'), runJsonPath }
}

await test('panel.html carries no run data in any encoding, while run.json does', async () => {
  await withTempDir('panel-inline', (dir) => {
    const { result, html, runJsonPath } = render(dir)
    const probes = [SENTINEL, escapeHtml(SENTINEL), encodeURIComponent(SENTINEL), Buffer.from(SENTINEL).toString('base64'), JSON.stringify(SENTINEL).slice(1, -1)]
    for (const probe of probes) assert.ok(!html.includes(probe), `the sentinel must not appear as ${JSON.stringify(probe)}`)
    assert.ok(fs.readFileSync(runJsonPath, 'utf8').includes(SENTINEL), 'the data itself lives in run.json')
    assert.equal(result.dataFile, 'run.json')
    assert.equal(result.schemaVersion, 1)
    assert.equal(result.bytes, Buffer.byteLength(html))
  })
})

await test('the five tabs, the conclusion bar and the file:// fallback are in the page', async () => {
  await withTempDir('panel-structure', (dir) => {
    const { html } = render(dir)
    for (const [name, label] of [['overview', '概览'], ['conversation', '对话'], ['trace', '轨迹'], ['scoring', '判卷'], ['raw', '原始 JSON']]) {
      assert.ok(html.includes(`data-tab="${name}"`), `tab button ${name}`)
      assert.ok(html.includes(`id="panel-${name}"`), `tab panel ${name}`)
      assert.ok(html.includes(label), `tab label ${label}`)
    }
    for (const id of ['conclusion', 'verdict', 'noise', 'tabs', 'plain', 'reload', 'pick', 'fallback', 'fallback-error']) assert.ok(html.includes(`id="${id}"`), id)
    assert.match(html, /type="file"/, 'the fallback needs a file picker')
  })
})

await test('untrusted text is text: escaped where static, textContent where dynamic', async () => {
  await withTempDir('panel-escape', (dir) => {
    const { html } = render(dir)
    assert.ok(!html.includes(XSS), 'the raw payload must never reach the page')
    assert.ok(html.includes(escapeHtml(XSS)), 'the page documents the canonical payload in its escaped form')
    for (const api of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment']) assert.ok(!html.includes(api), `no markup entry point: ${api}`)
    assert.equal(escapeHtml(`<b>&"'</b>`), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;')
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'))
    assert.ok(script.includes('textContent'), 'the runtime writes values with textContent')
    new Function(script) // throws on a syntax error in the inline runtime
  })
})

await test('--serve answers over 127.0.0.1 with the page and the document', async () => {
  await withTempDir('panel-serve', async (dir) => {
    const { runJsonPath } = render(dir)
    assert.ok(runJsonPath)
    const child = spawn(process.execPath, ['bench/cli.mjs', 'panel', '--serve', dir], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let printed = ''
    child.stdout.on('data', (chunk) => { printed += chunk })
    let base = ''
    try {
      await waitFor(() => {
        const match = printed.match(/http:\/\/127\.0\.0\.1:\d+\//)
        if (match) base = match[0].slice(0, -1)
        return base !== ''
      }, { what: 'the printed panel URL', timeoutMs: 20_000 })
      const page = await fetch(`${base}/${PANEL_FILE}`)
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-type'), /^text\/html/)
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
      assert.ok((await page.text()).includes('data-tab="raw"'))
      const document = await fetch(`${base}/run.json`)
      assert.equal(document.status, 200)
      assert.match(document.headers.get('content-type'), /^application\/json/)
      assert.ok(JSON.stringify(await document.json()).includes(SENTINEL))
      const redirect = await fetch(`${base}/`, { redirect: 'manual' })
      assert.equal(redirect.status, 302)
      assert.equal(redirect.headers.get('location'), `/${PANEL_FILE}`)
      assert.notEqual((await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status, 200)
      assert.equal((await fetch(`${base}/nope.json`)).status, 404)
    } finally {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
})

await test('the exported server binds an ephemeral loopback port and the CLI renders', async () => {
  await withTempDir('panel-api', async (dir) => {
    const { runJsonPath } = render(dir)
    const server = createPanelServer({ dir })
    const port = await listenPanel(server, { port: 0 })
    try {
      assert.ok(port > 0)
      const head = await fetch(`http://127.0.0.1:${port}/${PANEL_FILE}`, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('cache-control'), 'no-store')
      assert.equal((await fetch(`http://127.0.0.1:${port}/${PANEL_FILE}`, { method: 'POST' })).status, 405)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    const lines = []
    assert.equal(await cliMain(['panel', '--out', dir, runJsonPath], { out: (line) => lines.push(line), err: (line) => lines.push(line) }), 0, lines.join('\n'))
    assert.ok(lines.join('\n').includes(PANEL_FILE))
  })
})

await test('the panel CLI rejects a malformed line and refuses an unknown contract', async () => {
  for (const argv of [['--out', 'd'], ['--serve'], ['--port', 'x', '--serve', 'd'], ['--out', 'a', '--serve', 'b'], ['--bogus'], []]) {
    assert.equal(await main(argv, { out: () => {}, err: () => {} }), 2, JSON.stringify(argv))
  }
  const help = []
  assert.equal(await main(['--help'], { out: (line) => help.push(line), err: () => {} }), 0)
  assert.match(help.join('\n'), /--out <dir> <run\.json>[\s\S]*--serve <dir>/)
  assert.deepEqual(parsePanelArgs(['--out', 'd', 'run.json']), { mode: 'render', dir: 'd', runJsonPath: 'run.json', port: 0, help: false, error: null })
  await withTempDir('panel-bad', (dir) => {
    const bad = path.join(dir, 'run.json')
    fs.writeFileSync(bad, '{"schemaVersion":2}')
    assert.throws(() => renderPanel({ runJsonPath: bad, outDir: dir }), /schemaVersion 2/)
    fs.writeFileSync(bad, 'not json')
    assert.throws(() => renderPanel({ runJsonPath: bad, outDir: dir }), /not JSON/)
    assert.throws(() => renderPanel({}), /needs runJsonPath/)
  })
})

report('bench-panel')
