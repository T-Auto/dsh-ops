/** Separate condition groups; there is deliberately no cross-condition aggregate. */
import fs from 'node:fs'
import path from 'node:path'
import { describeCondition, assertSameCondition } from './condition.mjs'

export const MATRIX_FORMAT = 'dsh-ops-bench-matrix-v1'
export const MATRIX_FILE = 'matrix.json'

export async function runMatrix({ conditions, root, argv, options, io, run }) {
  const out = io.out ?? console.log
  const manifest = { format: MATRIX_FORMAT, groups: [] }
  if (!options.show) {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, MATRIX_FILE), JSON.stringify(manifest, null, 2), { flag: 'wx' })
  }
  let exit = 0
  for (const [index, condition] of conditions.entries()) {
    const directory = `condition-${String(index + 1).padStart(3, '0')}`
    const group = { directory, condition, base: null, cand: null, exitCode: null }
    manifest.groups.push(group)
    out(`[matrix] ${index + 1}/${conditions.length}: ${describeCondition(condition)}`)
    const code = await run(argv, { ...io, conditionOverride: condition, groupOverride: path.join(root, directory),
      onResult(result) {
        for (const side of ['base', 'cand']) if (result.summaryFiles?.[side]) group[side] = path.relative(root, result.summaryFiles[side]).split(path.sep).join('/')
        io.onResult?.(result)
      },
    })
    group.exitCode = code
    if (!options.show) fs.writeFileSync(path.join(root, MATRIX_FILE), JSON.stringify(manifest, null, 2) + '\n')
    if (code !== 0) exit = code === 2 ? 2 : exit || 1
    if (code === 2 || io.interrupt?.stopped) break
  }
  out('[matrix] Cross-condition results are not comparable; no combined delta is computed.')
  return exit
}

export function matrixComparisons(root, options, { resolveSide, compare }) {
  const dir = path.resolve(root), manifest = JSON.parse(fs.readFileSync(path.join(dir, MATRIX_FILE), 'utf8'))
  if (manifest.format !== MATRIX_FORMAT || !Array.isArray(manifest.groups) || !manifest.groups.length) throw new Error('Not a populated benchmark matrix')
  const side = file => {
    if (typeof file !== 'string') throw new Error('Matrix group has no completed side summaries')
    const target = path.resolve(dir, file), relative = path.relative(dir, target)
    if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === '..') throw new Error('Matrix summary escapes its group root')
    return resolveSide(target, options).doc
  }
  return manifest.groups.map(group => {
    const base = side(group.base), cand = side(group.cand)
    assertSameCondition(base, { condition: group.condition })
    assertSameCondition(cand, { condition: group.condition })
    return compare(base, cand, options)
  })
}

export function renderMatrix(comparisons, render) {
  return ['# Benchmark condition matrix', '', 'Cross-condition results are not comparable. Each section is independent; deltas are never combined.', '',
    ...comparisons.flatMap((comparison, index) => [`## Condition ${index + 1}: ${describeCondition(comparison.condition)}`, '',
      render(comparison).replace(/^# [^\n]*\n\n/, '').replace(/^Condition: [^\n]*\n\n/, '').replace(/^## /gm, '### '), '']),
  ].join('\n')
}
