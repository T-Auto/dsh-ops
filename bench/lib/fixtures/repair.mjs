/**
 * The `repair` fixture family: a workspace that ships a defect *and* the fix for
 * it. The bugs are injected as whole-line swaps, and the pristine sources travel
 * in `exports.fixes`, so a suite can prove the other half of the invariant — a
 * correct repair really does turn the workspace green.
 * @module dsh-ops/bench/fixtures/repair
 */

import { hexRun, mulberry32, pad, pick, randInt, WORDS } from './internal.mjs'

/**
 * `brokenProject` — a tiny Node project whose tests fail because of exactly three
 * injected single-line bugs (PLAN.md §7.4). The generator returns both the broken
 * sources (written to the workspace) and the fixed ones (`exports.fixes`), which
 * is what lets `test/bench.test.mjs` prove the other half of the invariant: a
 * correct repair really does turn the suite green.
 * @param {{seed?: number}} params - the project seed.
 * @returns {{files: {path: string, content: string}[], exports: {testSource: string, fixes: {path: string, content: string}[]}}} the fixture.
 */
export function brokenProject(params = {}) {
  const seed = params.seed ?? 11
  const next = mulberry32(seed)
  // Seed only decides which harmless filler the project carries, so two different
  // corpora cannot share a bug layout by accident.
  const label = pick(next, ['inventory', 'shipping', 'ledger'])

  const manifest = {
    name: `fixture-${label}`,
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { test: 'node test.js' },
  }

  const testSource = `import assert from 'node:assert/strict'
import { countItems, sumValues } from './src/counter.js'
import { discountPercent, lineTotal } from './src/pricing.js'
import { normalizeNames } from './src/normalize.js'

const items = [{ value: 2 }, { value: 3 }, { value: 4 }]

assert.equal(countItems(items), 3, 'countItems counts the entries it was given')
assert.equal(countItems([]), 0, 'countItems of nothing is nothing')
assert.equal(sumValues(items), 9, 'sumValues adds the values')
assert.equal(discountPercent(9), 0, 'below the threshold there is no discount')
assert.equal(discountPercent(10), 10, 'the threshold itself earns the discount')
assert.equal(lineTotal(100, 10), 900, 'a discounted line total keeps its rounding')
assert.deepEqual(normalizeNames([' Ada ', 'BOB', '']), ['ada', 'bob'], 'names are trimmed, lowered and emptied away')
assert.deepEqual(normalizeNames([]), [], 'nothing normalizes to nothing')

console.log('ok')
`

  const fixedCounter = `export function countItems(list) {
  let total = 0
  for (let i = 0; i < list.length; i += 1) {
    total += 1
  }
  return total
}

export function sumValues(list) {
  let sum = 0
  for (const item of list) {
    sum += item.value
  }
  return sum
}
`

  const fixedPricing = `export function discountPercent(quantity) {
  if (quantity >= 10) {
    return 10
  }
  return 0
}

export function lineTotal(price, quantity) {
  return price * quantity - (price * quantity * discountPercent(quantity)) / 100
}
`

  const fixedNormalize = `export function normalizeNames(raw) {
  return raw
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map((name) => name.toLowerCase())
}
`

  // Three single-line defects, each a whole-line swap so the model sees one
  // obvious bug per file rather than a refactoring exercise. `pristine` is the
  // line as it appears in the fixed source above; the generator refuses to build
  // a project where that anchor line has gone missing.
  const bugs = [
    {
      path: 'src/counter.js',
      fixed: fixedCounter,
      pristine: '  for (let i = 0; i < list.length; i += 1) {',
      brokenLine: '  for (let i = 0; i <= list.length; i += 1) {',
    },
    {
      path: 'src/pricing.js',
      fixed: fixedPricing,
      pristine: '  if (quantity >= 10) {',
      brokenLine: '  if (quantity > 10) {',
    },
    {
      path: 'src/normalize.js',
      fixed: fixedNormalize,
      pristine: '    .map((name) => name.trim())',
      brokenLine: '    .map((name) => name)',
    },
  ]

  const files = [
    { path: 'package.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'test.js', content: testSource },
  ]
  for (const bug of bugs) files.push({ path: bug.path, content: breakLine(bug) })
  return {
    files,
    exports: {
      testSource,
      fixes: bugs.map((bug) => ({ path: bug.path, content: bug.fixed })),
    },
  }
}

/**
 * Render one source file with its single defect injected.
 * @param {{path: string, fixed: string, pristine: string, brokenLine: string}} bug - the bug declaration.
 * @returns {string} the broken source.
 */
function breakLine(bug) {
  const lines = bug.fixed.split('\n')
  const at = lines.indexOf(bug.pristine)
  if (at === -1 || lines.indexOf(bug.pristine, at + 1) !== -1) {
    throw new Error(`bug anchor is not unique in ${bug.path}: ${bug.pristine}`)
  }
  lines[at] = bug.brokenLine
  return lines.join('\n')
}


/**
 * The arithmetic templates a pipeline stage may use (PLAN §7.12).
 *
 * `contract`, `bindings`, `expression` and `reference` all describe the same
 * transform, so one stage can be rendered twice from one spec: once as the true
 * implementation and once with exactly one bound constant changed. Keeping the two
 * renders in one place is what makes "exactly one defect, well-posed repair" a
 * property of the generator instead of a promise in a comment.
 */
const GATE_TEMPLATES = {
  addScaleMod: {
    fields: ['a', 'b', 'span'],
    contract: (spec) => `add ${spec.a} to the accumulator, multiply the sum by ${spec.b}, then reduce modulo ${spec.span}`,
    bindings: (spec) => [['offset', spec.a], ['scale', spec.b], ['span', spec.span]],
    expression: '((value + offset) * scale) % span',
    reference: (spec) => (value) => ((value + spec.a) * spec.b) % spec.span,
  },
  scaleAddMod: {
    fields: ['a', 'b', 'span'],
    contract: (spec) => `multiply the accumulator by ${spec.a}, add ${spec.b}, then reduce modulo ${spec.span}`,
    bindings: (spec) => [['factor', spec.a], ['offset', spec.b], ['span', spec.span]],
    expression: '((value * factor) + offset) % span',
    reference: (spec) => (value) => ((value * spec.a) + spec.b) % spec.span,
  },
  twistMod: {
    fields: ['a', 'b', 'c', 'span'],
    contract: (spec) => `add ${spec.a} to the accumulator, multiply the sum by ${spec.b}, add ${spec.c}, then reduce modulo ${spec.span}`,
    bindings: (spec) => [['offset', spec.a], ['scale', spec.b], ['twist', spec.c], ['span', spec.span]],
    expression: '(((value + offset) * scale) + twist) % span',
    reference: (spec) => (value) => (((value + spec.a) * spec.b) + spec.c) % spec.span,
  },
}

/**
 * One inert scaffolding line for a stage module. Every identifier carries the gate
 * and line index, so two filler lines can never collide into a duplicate
 * declaration, and no filler line can be mistaken for the stage's real work.
 * @param {() => number} next - the PRNG stream.
 * @param {number} gateIndex - the stage index.
 * @param {number} lineIndex - the line index within the stage.
 * @returns {string} one line of valid module-scope JavaScript.
 */
function gateFillerLine(next, gateIndex, lineIndex) {
  const ident = `${pick(next, WORDS)}_${hexRun(next, 4).toLowerCase()}_${gateIndex}_${lineIndex}`
  const kind = randInt(next, 0, 3)
  if (kind === 0) return `// ${ident} ${pick(next, WORDS)} ${pick(next, WORDS)} - inert scaffolding`
  if (kind === 1) return `const ${ident} = ${randInt(next, 1, 9999)}`
  if (kind === 2) return `function ${ident}(input) { return input ${pick(next, ['+', '-', '*'])} ${randInt(next, 1, 99)} }`
  return `const ${ident} = (input) => input ${pick(next, ['>=', '<=', '==='])} ${randInt(next, 0, 9)}`
}

/**
 * Render one stage module. The contract line always describes the *true* spec; only
 * the bound constants come from `codeSpec`. That is how a stage carries exactly one
 * defect while still documenting the behavior it is supposed to have — the repair is
 * "make the code agree with the contract", never "guess what the author meant".
 * @param {{name: string, index: number, template: object, spec: object, codeSpec: object, filler: string[]}} stage - the render inputs.
 * @returns {string} the module source.
 */
function renderGateModule({ name, index, template, spec, codeSpec, filler }) {
  return [
    `// ${name} - stage ${index} of the release pipeline.`,
    '//',
    `// Contract: ${template.contract(spec)}.`,
    '// The stage is pure: it returns the new accumulator and touches no other state.',
    '',
    ...filler,
    '',
    'export function run(value) {',
    ...template.bindings(codeSpec).map(([binding, value]) => `  const ${binding} = ${value}`),
    `  return ${template.expression}`,
    '}',
    '',
  ].join('\n')
}

/**
 * Draw a one-constant variant of a stage spec that really disagrees with the true
 * spec on at least one probe. Fields are tried in a fixed order, so the defect a
 * given seed produces is stable, and a spec that cannot be broken throws instead of
 * shipping a stage that already passes.
 * @param {() => number} next - the PRNG stream.
 * @param {object} spec - the true spec.
 * @param {object} template - its template.
 * @param {number[]} probes - the probe inputs.
 * @returns {object} the broken spec.
 */
function breakGateConstant(next, spec, template, probes) {
  const reference = template.reference(spec)
  for (const field of template.fields) {
    const delta = field === 'span' ? randInt(next, 11, 97) : randInt(next, 1, 9)
    const candidate = { ...spec, [field]: spec[field] + delta }
    if (probes.some((probe) => template.reference(candidate)(probe) !== reference(probe))) return candidate
  }
  throw new Error(`gatePipeline: could not break a ${spec.kind} stage`)
}

/**
 * `gatePipeline` — a fail-fast release gate over many stage modules, each carrying
 * exactly one defect (PLAN §7.12).
 *
 * This is the corpus's **long-run** shape, and it is a different question from the
 * 256K tier: there the workspace is enormous and the transcript has to stay small,
 * here the workspace is small and the *number of turns* is large. `check.js` loads
 * the stages in order, validates each against golden values, and stops at the first
 * disagreement — so one repaired stage buys exactly one stage of progress, and
 * twenty-four stages cost at least twenty-four runs. Each run prints a fresh block
 * of passing lines, so what compounds across the run is the per-request cost of
 * every step: the same tool surface, re-sent on each of dozens of turns, plus
 * whatever the previous runs' output left in the history.
 *
 * Two details keep the repair well-posed rather than a guessing game. Every stage's
 * contract is written in the stage module itself (what it adds, multiplies and
 * reduces by) while the *code* binds a different constant, so the fix is to make the
 * two agree. And the chain seed is never one of the probes, so a stage that hardcodes
 * the golden values instead of implementing the contract still produces the wrong
 * final value — which is exactly what `answer.txt` is checked against.
 * @param {{seed?: number, gates?: number, probes?: number, linesPerGate?: number, seedValue?: number}} params - the shape of the pipeline.
 * @returns {{files: {path: string, content: string}[], exports: Record<string, unknown>}} the fixture.
 */
export function gatePipeline(params = {}) {
  const seed = params.seed ?? 53
  const gateCount = Math.max(2, params.gates ?? 24)
  const probeCount = Math.max(2, params.probes ?? 12)
  const fillerLines = Math.max(0, params.linesPerGate ?? 70)
  const seedValue = params.seedValue ?? 7
  const next = mulberry32(seed)
  const width = String(gateCount - 1).length

  // The chain input is never a probe: a stage that memorises golden outputs fails
  // the final value instead of sneaking through the per-stage checks.
  const probes = []
  const probeTaken = new Set([seedValue])
  while (probes.length < probeCount) {
    const value = randInt(next, 2, 97)
    if (probeTaken.has(value)) continue
    probeTaken.add(value)
    probes.push(value)
  }

  const kinds = ['addScaleMod', 'scaleAddMod', 'twistMod']
  const gates = []
  for (let index = 0; index < gateCount; index += 1) {
    const kind = kinds[index % kinds.length]
    const template = GATE_TEMPLATES[kind]
    const spec = { kind, a: randInt(next, 3, 41), b: randInt(next, 2, 9), c: randInt(next, 2, 61), span: randInt(next, 900, 9000) }
    const filler = []
    for (let line = 0; line < fillerLines; line += 1) filler.push(gateFillerLine(next, index, line))
    const codeSpec = breakGateConstant(next, spec, template, probes)
    const name = `gate_${pad(index, width)}`
    const fixed = renderGateModule({ name, index, template, spec, codeSpec: spec, filler })
    const broken = renderGateModule({ name, index, template, spec, codeSpec, filler })
    // The one-defect promise, checked instead of asserted in prose: the two renders
    // differ on exactly one line, and that line is a bound constant.
    const fixedLines = fixed.split('\n')
    const brokenLines = broken.split('\n')
    const changed = fixedLines.filter((line, at) => line !== brokenLines[at])
    if (changed.length !== 1) throw new Error(`${name}: expected exactly one changed line, got ${changed.length}`)
    if (!/^  const \w+ = \d+$/.test(changed[0])) throw new Error(`${name}: the defect must be a bound constant, got "${changed[0]}"`)
    gates.push({ name, spec, broken, fixed })
  }

  const golden = gates.map((gate) => probes.map((probe) => GATE_TEMPLATES[gate.spec.kind].reference(gate.spec)(probe)))
  let value = seedValue
  for (const gate of gates) value = GATE_TEMPLATES[gate.spec.kind].reference(gate.spec)(value)
  if (probes.includes(seedValue)) throw new Error('gatePipeline: the chain seed must not be a probe')
  if (gates.length === 0) throw new Error('gatePipeline: a pipeline needs at least one stage')

  const imports = gates.map((gate) => `import { run as ${gate.name} } from './gates/${gate.name}.js'`)
  const checkSource = [
    '// release gate - generated file, do not edit',
    ...imports,
    '',
    `const PROBES = ${JSON.stringify(probes)}`,
    `const GOLDEN = ${JSON.stringify(golden)}`,
    `const SEED = ${seedValue}`,
    `const NAMES = ${JSON.stringify(gates.map((gate) => gate.name))}`,
    `const GATES = [${gates.map((gate) => gate.name).join(', ')}]`,
    '',
    "console.log('# release gate')",
    `console.log('# ${gates.length} stage(s), ${probes.length} probe(s) each, chain seed ' + SEED)`,
    "console.log('# every stage must match its golden values before the next stage runs')",
    '',
    'let value = SEED',
    'let stoppedAt = null',
    'outer: for (let index = 0; index < GATES.length; index += 1) {',
    '  const name = NAMES[index]',
    '  for (let probeIndex = 0; probeIndex < PROBES.length; probeIndex += 1) {',
    '    const probe = PROBES[probeIndex]',
    '    const actual = GATES[index](probe)',
    '    const expected = GOLDEN[index][probeIndex]',
    '    if (actual !== expected) {',
    '      console.log(`not ok ${index + 1} - ${name} probe ${probe}`)',
    "      console.log('  ---')",
    '      console.log(`  message: "AssertionError: ${name}(${probe}) returned ${actual}, expected ${expected}"`)',
    '      console.log(`  file: gates/${name}.js`)',
    '      console.log(`    actual: ${actual}`)',
    '      console.log(`    expected: ${expected}`)',
    "      console.log('  ...')",
    '      stoppedAt = name',
    '      break outer',
    '    }',
    '    console.log(`ok ${index + 1} - ${name} probe ${probe}`)',
    '  }',
    '  value = GATES[index](value)',
    '}',
    'if (stoppedAt !== null) {',
    '  console.log(`# stopped at ${stoppedAt}`)',
    '  process.exitCode = 1',
    '} else {',
    '  console.log(`# ${GATES.length} stage(s) passed`)',
    '  console.log(`# final value ${value}`)',
    '}',
    '',
  ].join('\n')

  const manifest = {
    name: 'fixture-gate-pipeline',
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { gate: 'node check.js' },
  }

  return {
    files: [
      ...gates.map((gate) => ({ path: `gates/${gate.name}.js`, content: gate.broken })),
      { path: 'check.js', content: checkSource },
      { path: 'package.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    ],
    exports: {
      answer: String(value),
      final: value,
      checkSource,
      gates: gateCount,
      probes,
      fixes: gates.map((gate) => ({ path: `gates/${gate.name}.js`, content: gate.fixed })),
    },
  }
}
