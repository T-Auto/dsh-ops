/**
 * Issue #490 probe — the live-session curve, measured end to end.
 *
 * The issue reports "new session takes 2-4s and gets slower with every open
 * session". Its metric is identity.createdAt -> the session file's birthtime,
 * and the root cause chain is documented in the issue: an unattributed
 * `tools/change` makes every live session pay one full prompt assembly.
 *
 * This probe measures the one number the fix is about: **how many full prompt
 * assemblies does one unattributed change cost, as a function of live sessions**,
 * and the wall-clock time that change takes. It runs the real composition —
 * real Cordis context, the published dsh-tools registry and dsh-system-prompt
 * assembly, the real native worker, the shipped lib/ — so the curve is what a
 * host would see, not a model of it.
 *
 * Run: node bench/probe-490-curve.mjs
 *   environmental knobs: PROBE_LIVE (default "0,8,32,64,128,198")
 *                        PROBE_TOOLS (default 150)
 *                        PROBE_REPEAT (default 2)
 *                        PROBE_SCENARIO (default "change,create-native,create-ptc")
 *
 * Scenarios:
 *   change         — one unattributed tools/change over the live set
 *   create-native  — the issue's own flow: register a tool, create a Native
 *                    session, one unattributed change (what the host does when
 *                    the user clicks "new session")
 *   create-ptc     — the same, but the new session presents ptc
 *   create-only    — create the session and announce nothing else. This is the
 *                    control: it shows how much of the issue's 2-4s belongs to
 *                    the creation itself rather than to the change after it.
 */
import { createScope } from '@deepseek-ai/dsh-scope'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import * as discoveryModule from '../../lib/discovery/index.js'
import * as ptcModule from '../../lib/ptc/index.js'
import { isPresentationProbe } from '../../lib/presentation.js'
import { bootHost, shutdown } from '../../test/lib/host.mjs'
import { legacyComponent } from '../../test/lib/legacy-component.mjs'
import { WORKER } from '../../test/lib/boundary.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const discovery = legacyComponent(discoveryModule)
const ptc = legacyComponent(ptcModule)

const LIVE = (process.env.PROBE_LIVE ?? '0,8,32,64,128,198').split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value >= 0)
const TOOLS = Number(process.env.PROBE_TOOLS ?? 150)
const REPEAT = Number(process.env.PROBE_REPEAT ?? 2)
const SCENARIOS = (process.env.PROBE_SCENARIO ?? 'change,create-native,create-ptc').split(',').map(value => value.trim()).filter(Boolean)

if (!fs.existsSync(WORKER)) {
  console.error(`probe-490: no native worker at ${WORKER}; run "npm run build:ptc" first`)
  process.exit(1)
}

/**
 * A fixture tool whose schema has the shape the issue's profile shows: nested
 * objects, enums and arrays, so the SDK segment costs what a real toolset costs.
 */
const bulkTool = index => ({
  name: `probe_bulk_${index}`,
  description: `Bulk fixture tool ${index} with realistic nested parameters`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the target resource' },
      pattern: { type: 'string', description: 'Pattern to match' },
      options: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum results' },
          encoding: { type: 'string', enum: ['utf-8', 'utf-16'], description: 'Text encoding' },
          range: { type: 'array', items: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } } },
          filter: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              value: { type: 'string' },
              operator: { type: 'string', enum: ['eq', 'ne', 'gt', 'lt'] },
            },
          },
        },
      },
    },
    required: ['path'],
  },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
  execute: async () => ({ content: 'ok' }),
})

const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]

/**
 * Build one mount with `live` sessions and return the cost of one unattributed
 * change over them.
 */
async function measure(live, scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-490-'))
  const disposers = []
  try {
    // The issue's host is native by default: most sessions are Native and a few
    // present ptc. Booting with toolsMode:'ptc' would make every session ptc,
    // which leaves the ptc side's !entry.ptc set empty and hides the very path
    // this probe exists to measure.
    const { ctx } = await bootHost({ toolsMode: 'native', withWorkingDirectory: true })
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox, {})
    await ctx.plugin(inner => inner.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode, workspaceRoot: session.header.cwd, sessionId: session.id }),
    }))
    await ctx.plugin(inner => inner.provide('ptcRuntime', { language: 'typescript', programFormat: 'inline' }))
    await ctx.plugin(discovery, { binaryPath: WORKER, required: true })
    await ctx.plugin(ptc, { binaryPath: WORKER, required: true })

    // Count every full assembly, and separately the presentation probes, so the
    // report distinguishes "assembly avoided" from "assembly merely attributed".
    const prompt = ctx.get('systemPrompt')
    const assemble = prompt.assemble.bind(prompt)
    let assemblies = 0
    let probes = 0
    prompt.assemble = context => {
      assemblies += 1
      if (isPresentationProbe(context)) probes += 1
      return assemble(context)
    }

    for (let index = 0; index < TOOLS; index++) await ctx.get('tools').register(bulkTool(index))

    const create = async id => {
      const agent = { id, session: { id, mode: 'danger-full-access', header: { cwd: dir } } }
      await ctx.plugin({ inject: ['tools'], apply(inner) { agent.ctx = createScope(inner, agent).ctx } })
      await ctx.serial('agent/created', { agent, source: 'startup' })
      return agent
    }

    const agents = []
    for (let index = 0; index < live; index++) agents.push(await create(`live-${index}`))
    // Let the startup burst settle so the measurement window is the change alone.
    await new Promise(resolve => setTimeout(resolve, 400))
    assemblies = 0
    probes = 0

    const samples = []
    const rounds = []
    const createSamples = []
    const changeSamples = []
    for (let round = 0; round < REPEAT; round++) {
      // Each round is one "the user did something" event, exactly as the host
      // delivers it: a registry mutation followed by an unattributed change.
      // Creating the session and announcing the change are timed separately,
      // because they answer different questions — one is the issue's symptom,
      // the other is what this fix changed.
      const extra = []
      const before = assemblies
      if (scenario === 'change') {
        const started = process.hrtime.bigint()
        await ctx.serial('tools/change', {})
        await new Promise(resolve => setTimeout(resolve, 50))
        changeSamples.push(Number(process.hrtime.bigint() - started) / 1e6)
        samples.push(changeSamples.at(-1))
      } else {
        // The host registers the new session's tools, creates the session, and
        // only then announces the change. Creating a Native session is the flow
        // the issue measured; creating a ptc one flips a presentation.
        // `create-only` is the issue's plainest form: click "new session" without
        // any registry mutation, which is what the reproduce steps describe.
        if (scenario !== 'create-only') await ctx.get('tools').register(bulkTool(TOOLS + round))
        const id = `${scenario}-${live}-${round}`
        const fresh = { id, session: { id, mode: 'danger-full-access', header: { cwd: dir } } }
        const createStarted = process.hrtime.bigint()
        await ctx.plugin({ inject: ['tools'], apply(inner) { fresh.ctx = createScope(inner, fresh).ctx } })
        if (scenario === 'create-ptc') {
          await fresh.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
        }
        await ctx.serial('agent/created', { agent: fresh, source: 'startup' })
        createSamples.push(Number(process.hrtime.bigint() - createStarted) / 1e6)
        extra.push(fresh)

        if (scenario === 'create-only') {
          // No registry change is announced in this scenario; the session's own
          // arrival is the only event, exactly as the reproduce steps describe.
          samples.push(createSamples.at(-1))
        } else {
          const changeStarted = process.hrtime.bigint()
          await ctx.serial('tools/change', {})
          await new Promise(resolve => setTimeout(resolve, 50))
          changeSamples.push(Number(process.hrtime.bigint() - changeStarted) / 1e6)
          // The issue's own metric is "click -> visible", so it spans both phases.
          samples.push(createSamples.at(-1) + changeSamples.at(-1))
        }
      }
      rounds.push(assemblies - before)
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    const result = {
      scenario,
      live,
      assembliesPerChange: Number((rounds.reduce((a, b) => a + b, 0) / REPEAT).toFixed(2)),
      probesPerChange: Number((probes / REPEAT).toFixed(2)),
      msPerChange: Number(median(samples).toFixed(1)),
      ...(createSamples.length ? { createMs: Number(median(createSamples).toFixed(1)) } : {}),
      ...(changeSamples.length ? { changeMs: Number(median(changeSamples).toFixed(1)) } : {}),
    }

    await disposeAll(disposers)
    await shutdown(ctx)
    return result
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const disposeAll = async list => {
  while (list.length) await list.pop()()
}

const rows = []
for (const scenario of SCENARIOS) {
  for (const live of LIVE) {
    const row = await measure(live, scenario)
    rows.push(row)
    console.log(JSON.stringify(row))
  }
}

console.log('')
console.log('scenario       live  assemblies  probes  ms')
for (const row of rows) {
  console.log(`${row.scenario.padEnd(13)}  ${String(row.live).padStart(4)}  ${String(row.assembliesPerChange).padStart(10)}  ${String(row.probesPerChange).padStart(6)}  ${String(row.msPerChange).padStart(7)}`)
}
