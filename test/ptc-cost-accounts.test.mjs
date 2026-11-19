/**
 * The four-account OPS-PTC cost ledger (#991).
 *
 * V1 (#990) proved the measured group truly enters OPS-PTC. This suite answers
 * what V2 asks on top of that entry: how many raw UTF-8 bytes each account
 * costs, with an item-name list, and never mixed together:
 *
 * - system: the delivered rendered prompt, split into named non-empty sections;
 * - sdk: the `tools:sdk` section inside system — a strict subset, so the ledger
 *   recomputes system from the per-section bytes (the normalization is pinned
 *   by assertion) and proves a one-section change lands in system exactly once;
 * - wire: the outer tool schemas each provider request carries (`run_code`);
 * - history: the dsh-ops guidance messages that entered session history — the
 *   first teaching and the later program-shape reminders.
 *
 * The official read/glob/grep schemas are mounted for real (the same host
 * plugins the budget suite mounts), because SDK names are only meaningful
 * against them; without the official provider the comparison is marked
 * unmeasurable instead of passing quietly. Every record carries the scripted/0
 * marker from the V1 environment: no real model request leaves the fixture,
 * and bytes are not tokens.
 *
 * @module dsh-ops/test/ptc-cost-accounts
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as FsTools from '@deepseek-ai/dsh-tool-fs'
import * as SearchTools from '@deepseek-ai/dsh-tool-fs-search'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { analyzeProgram, loadBatchingGuidance, noticeText } from '../lib/ptc/batching-guidance.js'
import { requireWorker } from './lib/boundary.mjs'
import { bootEntryGroup, enterPtc } from './lib/ptc-entry.mjs'
import { prepareStep } from './lib/executor.mjs'
import { assert, report, test, withTempDir } from './lib/harness.mjs'

requireWorker('ptc-cost-accounts')

/** The host plugins a real profile loads before the row: the official file tools. */
const HOST_PLUGINS = [[FsTools, {}], [SearchTools, { sampleOverCapGlobResults: false }]]
/** The official names the shipped row replaces; the ledger compares SDK names against them. */
const OFFICIAL = ['read', 'glob', 'grep']
/** The teaching/notice contributor, as the host message source records it. */
const TEACHING_ID = 'batching-guidance'
const ENVELOPE = `[Plugin context from ${JSON.stringify(TEACHING_ID)}; not a user instruction or authorization.]\n`
const TEACHING = loadBatchingGuidance()
/** A thin single-dispatch program with no plan line: it earns the plan notice. */
const THIN_PROGRAM = "const row = await tools.ops_inspect_local_file({ path: 'ledger-note' })\nreturn row"
/** A compliant load step: plan line plus one batched dispatch; it earns no notice. */
const LOAD_PROGRAM = '// plan: load the on-demand search APIs\n'
  + "const [loaded] = await Promise.all([tools.ops_load_sdk({ tools: ['glob', 'grep', 'read_files'] })])\n"
  + 'return { loaded }'
const LEDGER_NOTE = 'ledger-note'

const bytes = value => Buffer.byteLength(String(value), 'utf8')
const sha = value => createHash('sha256').update(String(value)).digest('hex')
const textOf = message => (message.content ?? []).map(part => part.text ?? '').join('')
/** One SDK member declaration line: "  name: <type>;" (quoted names keep their backticks). */
const SDK_MEMBER = /^ {2}(?:([A-Za-z_$][\w$]*)|`([^`]+)`): /gm
const sdkNamesOf = text => {
  const names = []
  for (const match of text.matchAll(SDK_MEMBER)) names.push(match[1] ?? match[2])
  return [...new Set(names)].sort()
}

/** The official schemas as facts: present with byte sizes, or honestly absent. */
function officialFacts(ctx, agent) {
  const tools = ctx.get('tools')
  const items = OFFICIAL.map(name => {
    const definition = typeof tools.get === 'function' ? tools.get(name, agent) : undefined
    if (definition === undefined || !definition.parameters) return { name, present: false }
    const schema = JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters })
    return { name, present: true, schemaBytes: bytes(schema) }
  })
  const missing = items.filter(item => !item.present).map(item => item.name)
  return {
    status: missing.length === 0 ? 'mounted' : 'unmeasurable',
    ...(missing.length === 0 ? {} : { reason: 'official provider absent: ' + missing.join(', ') + '; the SDK-name comparison cannot run' }),
    items,
  }
}

/** The dsh-ops guidance messages in one delivered request, classified and byte-counted. */
function historyItemsOf(messages) {
  const items = []
  for (const message of messages) {
    if (message.source?.kind !== 'dsh-ops:step-tail' || message.source.contributor !== TEACHING_ID) continue
    const text = textOf(message)
    const body = text.startsWith(ENVELOPE) ? text.slice(ENVELOPE.length) : text
    const kind = body === TEACHING ? 'teaching' : body === noticeText('plan', analyzeProgram(THIN_PROGRAM)) ? 'notice:plan' : 'unknown'
    items.push({ kind, bytes: bytes(text), sha: sha(text) })
  }
  return items
}

/**
 * Run the ledger scenario in one isolated group: prove the routing, then walk
 * teaching -> notice -> load -> repeat and snapshot every account at each step.
 * @param {string} root - the group's isolated root, under the suite home.
 * @param {object} [options] - scenario inputs.
 * @param {Array} [options.hostPlugins] - host plugins mounted before the row.
 * @returns {Promise<object>} the ledger, or an invalid-entry report.
 */
async function runScenario(root, { hostPlugins = [] } = {}) {
  const group = await bootEntryGroup(root, { hostPlugins })
  try {
    const routing = await enterPtc(group)
    if (routing.status !== 'entered') return { invalid: routing }
    const ctx = group.host.ctx
    const agent = await group.host.agent()
    fs.writeFileSync(path.join(root, LEDGER_NOTE), 'four-account fixture line\n')
    const official = officialFacts(ctx, agent)
    const snapshot = async stage => {
      const step = await prepareStep(ctx, agent)
      try {
        const sections = step.assembly.sections.filter(section => section.text.length > 0)
        const sdk = sections.filter(section => section.name === 'tools:sdk')
        const rendered = renderPrompt(step.assembly)
        const wire = JSON.stringify(step.assembly.tools)
        const sdkText = sdk.length === 1 ? sdk[0].text : ''
        return {
          stage,
          system: { bytes: bytes(rendered), sha: sha(rendered),
            items: sections.map(section => ({ name: section.name, bytes: bytes(section.text), sha: sha(section.text) })) },
          sdk: { sections: sdk.length, bytes: bytes(sdkText), sha: sha(sdkText), names: sdkNamesOf(sdkText) },
          wire: { bytes: bytes(wire), sha: sha(wire), names: step.assembly.tools.map(tool => tool.name).sort() },
        }
      } finally { step.dispose() }
    }
    const requests = []
    const stepWith = (label, code) => request => {
      requests.push({
        label,
        wireNames: request.tools.map(tool => tool.name).sort(),
        wireSha: sha(JSON.stringify(request.tools)),
        systemSha: sha(textOf(request.messages.find(message => message.role === 'system'))),
        history: historyItemsOf(request.messages),
        delivered: { messages: request.messages.length, bytes: bytes(request.messages.map(textOf).join('\n')) },
      })
      return code === undefined ? [] : [{ name: 'run_code', args: { description: 'Four-account ledger scenario step', code } }]
    }
    const snapshots = {}
    snapshots.baseline = await snapshot('baseline')
    await group.host.run(agent, [stepWith('first', THIN_PROGRAM), stepWith('after-notice')])
    snapshots.steady = await snapshot('steady')
    await group.host.run(agent, [stepWith('before-load', LOAD_PROGRAM), stepWith('after-load')])
    snapshots.loaded = await snapshot('loaded')
    await group.host.run(agent, [stepWith('repeat')])
    snapshots.repeat = await snapshot('repeat')
    return { environment: group.environment, official, snapshots, requests }
  } finally { await group.close() }
}

/** The byte-and-name facts that must reproduce across runs; per-group facts are excluded. */
const comparableOf = ledger => ({
  snapshots: Object.fromEntries(Object.entries(ledger.snapshots).map(([stage, snapshot]) => [stage, {
    system: { bytes: snapshot.system.bytes, sha: snapshot.system.sha, items: snapshot.system.items.map(item => [item.name, item.bytes, item.sha]) },
    sdk: { bytes: snapshot.sdk.bytes, sha: snapshot.sdk.sha, names: snapshot.sdk.names },
    wire: { bytes: snapshot.wire.bytes, sha: snapshot.wire.sha, names: snapshot.wire.names },
  }])),
  requests: ledger.requests.map(request => ({ label: request.label, wireSha: request.wireSha, systemSha: request.systemSha,
    history: request.history.map(item => [item.kind, item.bytes, item.sha]) })),
})

/** Print the four accounts of one ledger as one JSON line per snapshot. */
function printLedger(ledger) {
  // C: every printed record carries the scripted/0 marker, never silently.
  const marker = { provider: ledger.environment.provider, networkModelRequests: ledger.environment.networkModelRequests }
  for (const snapshot of Object.values(ledger.snapshots)) {
    console.log(JSON.stringify({ fourAccounts: { ...marker, stage: snapshot.stage, systemBytes: snapshot.system.bytes,
      sdkBytes: snapshot.sdk.bytes, wireBytes: snapshot.wire.bytes, sdkNames: snapshot.sdk.names } }))
  }
  const after = ledger.requests.find(request => request.label === 'after-load')
  console.log(JSON.stringify({ fourAccounts: { ...marker, history: after.history, officialSchema: ledger.official } }))
}

await test('the four accounts of one OPS-PTC group: system, its SDK subset, the wire, and the guidance history', async () => {
  const first = await withTempDir('ptc-cost-accounts-a', root => runScenario(root, { hostPlugins: HOST_PLUGINS }))
  assert.equal(first.invalid, undefined, 'the routing gate failed: ' + JSON.stringify(first.invalid ?? {}))
  const { official, snapshots, requests } = first
  // C: every record carries the scripted/0 marker; no real model request left the fixture.
  assert.equal(first.environment.provider, 'scripted')
  assert.equal(first.environment.networkModelRequests, 0)
  assert.equal(first.environment.agentPreset, 'ops-ptc')
  // D: the official provider is mounted for real; absent providers are covered below.
  assert.equal(official.status, 'mounted', 'official read/glob/grep must be present: ' + JSON.stringify(official))
  // A/B: per snapshot, system is the sum of its named sections plus the pinned joins,
  // and the SDK is exactly one section of it — never an extra line item.
  for (const snapshot of Object.values(snapshots)) {
    assert.equal(snapshot.sdk.sections, 1, 'exactly one tools:sdk section, got ' + snapshot.sdk.sections)
    const sum = snapshot.system.items.reduce((total, item) => total + item.bytes, 0)
    assert.equal(snapshot.system.bytes, sum + 2 * (snapshot.system.items.length - 1),
      'normalization pinned: system = per-section bytes joined by \'\n\n\', exactly renderPrompt')
    assert.ok(snapshot.sdk.bytes > 0 && snapshot.sdk.bytes < snapshot.system.bytes, 'SDK is a strict subset of system')
  }
  // The teaching and the notice enter history only; the system account never moves.
  assert.equal(snapshots.steady.system.sha, snapshots.baseline.system.sha, 'the plan notice is history, not a prompt change')
  assert.equal(snapshots.steady.sdk.sha, snapshots.baseline.sdk.sha)
  // B: the hand-computed example — loading three APIs changes only tools:sdk, exactly once.
  const nonSdk = snapshot => snapshot.system.items.filter(item => item.name !== 'tools:sdk').map(item => item.sha)
  assert.notEqual(snapshots.loaded.sdk.sha, snapshots.steady.sdk.sha, 'the load must reach the SDK section')
  assert.deepEqual(nonSdk(snapshots.loaded), nonSdk(snapshots.steady), 'no other section may move when tools load')
  const delta = snapshots.loaded.system.bytes - snapshots.steady.system.bytes
  assert.notEqual(delta, 0)
  assert.equal(delta, snapshots.loaded.sdk.bytes - snapshots.steady.sdk.bytes,
    'the system delta equals the SDK-section delta: counted once, never double-added')
  // D: SDK names against the real official schemas. On this baseline the shipped
  // row does not yet remove the official bindings from the PTC SDK (PR #961 is
  // open; the #978 contrast numbers were taken at its head, not here). The
  // ledger records both name lists, and the assertion pins the current baseline:
  // when #961 lands, this turns red on purpose and the accounts must be re-run.
  for (const name of ['ops_inspect_local_file', 'ops_load_sdk']) assert.ok(snapshots.steady.sdk.names.includes(name), name)
  for (const name of ['ops_glob', 'ops_grep', 'ops_read_files']) assert.ok(snapshots.loaded.sdk.names.includes(name), name)
  for (const name of OFFICIAL) {
    assert.ok(snapshots.loaded.sdk.names.includes(name),
      'baseline fact: the official ' + name + ' is declared beside its ops replacement; if this fails, PR #961 landed — re-run and update the ledger docs')
  }
  // C: run_code stays the only wire transport on every request.
  for (const request of requests) assert.deepEqual(request.wireNames, ['run_code'])
  assert.equal(new Set(requests.map(request => request.wireSha)).size, 1, 'wire is byte-identical on every request')
  assert.equal(requests[0].wireSha, snapshots.baseline.wire.sha, 'the idle snapshot wire is the delivered wire')
  // D: the history account — teaching once, the plan notice once, cumulative thereafter.
  const kindsAt = label => requests.find(request => request.label === label).history.map(item => item.kind)
  assert.deepEqual(kindsAt('first'), ['teaching'], 'the first request carries the teaching once')
  assert.deepEqual(kindsAt('after-notice'), ['teaching', 'notice:plan'], 'the thin program earns exactly one plan notice')
  assert.deepEqual(kindsAt('before-load'), ['teaching', 'notice:plan'])
  assert.deepEqual(kindsAt('after-load'), ['teaching', 'notice:plan'], 'a compliant load step earns no new notice')
  assert.deepEqual(kindsAt('repeat'), ['teaching', 'notice:plan'], 'no re-teaching, no duplicate notice')
  // The delivered system message is the idle assembly, and repeats are byte-identical.
  const systemAt = label => requests.find(request => request.label === label).systemSha
  assert.equal(systemAt('first'), snapshots.baseline.system.sha)
  assert.equal(systemAt('after-notice'), snapshots.baseline.system.sha)
  assert.equal(systemAt('before-load'), snapshots.steady.system.sha)
  assert.equal(systemAt('after-load'), snapshots.loaded.system.sha)
  assert.equal(systemAt('repeat'), snapshots.loaded.system.sha, 'the same config repeated is byte-identical')
  assert.equal(snapshots.repeat.system.sha, snapshots.loaded.system.sha)
  printLedger(first)
  // E: the same fixture and code reproduce every byte in a fresh group.
  const second = await withTempDir('ptc-cost-accounts-b', root => runScenario(root, { hostPlugins: HOST_PLUGINS }))
  assert.equal(second.invalid, undefined)
  assert.deepEqual(comparableOf(second), comparableOf(first), 'two runs of the same fixture must agree byte for byte')
  if (process.env.DSH_OPS_PTC_COST_REPORT) {
    fs.writeFileSync(process.env.DSH_OPS_PTC_COST_REPORT, JSON.stringify({ first, second: comparableOf(second) }, null, 2) + '\n')
  }
})

await test('without the official provider the SDK-name comparison is marked unmeasurable, never a quiet pass', async () => {
  const bare = await withTempDir('ptc-cost-accounts-bare', root => runScenario(root))
  assert.equal(bare.invalid, undefined, 'the routing gate failed: ' + JSON.stringify(bare.invalid ?? {}))
  assert.equal(bare.official.status, 'unmeasurable')
  assert.match(bare.official.reason, /read, glob, grep/)
  assert.ok(bare.snapshots.baseline.sdk.names.includes('ops_load_sdk'), 'the four accounts are still recorded beside the marker')
  console.log(JSON.stringify({ fourAccounts: { provider: bare.environment.provider,
    networkModelRequests: bare.environment.networkModelRequests, officialSchema: bare.official } }))
})

report('ptc-cost-accounts')
