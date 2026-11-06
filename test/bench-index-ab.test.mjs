/** Cold calls must be valid results, not merely identical bytes in both arms. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { main } from '../bench/index-ab/index.mjs'
import { QUERIES } from '../bench/index-ab/plan.mjs'

for (const { coldResult, exitCode } of [
  { coldResult: { status: 'failed', complete: false, truncated: false }, exitCode: 0 },
  { coldResult: { status: 'completed', complete: false, truncated: true }, exitCode: 0 },
  { coldResult: { status: 'completed', complete: true, truncated: false }, exitCode: 7 },
]) {
  await test(`identical cold ${coldResult.status}/${coldResult.complete}/exit${exitCode} results fail despite successful warm calls`, async () => {
    await withTempDir('index-ab-cold', async (dir) => {
      const root = path.join(dir, 'corpus')
      fs.mkdirSync(root)
      fs.writeFileSync(path.join(root, 'file.txt'), 'fixture')
      const counter = path.join(dir, 'counter')
      const preload = path.join(dir, 'worker.cjs')
      // Use a real subprocess on all platforms without a shell shim or a Rust
      // dependency. The preload owns stdin and exits before Node evaluates it.
      fs.writeFileSync(preload, `
const fs = require('node:fs')
process.stdin.resume()
process.stdin.on('end', () => {
  const counter = ${JSON.stringify(counter)}
  const call = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0
  fs.writeFileSync(counter, String(call + 1))
  const cold = call < ${QUERIES.length * 2}
  console.log(JSON.stringify(cold ? ${JSON.stringify(coldResult)} : { status: 'completed', complete: true, truncated: false }))
  process.exit(cold ? ${exitCode} : 0)
})
`)
      const previous = process.env.NODE_OPTIONS
      const output = path.join(dir, 'report.json')
      const errors = []
      let code
      try {
        process.env.NODE_OPTIONS = '--require ' + JSON.stringify(preload.split(path.sep).join('/'))
        code = await main(['--root', root, '--worker', process.execPath, '--repeat', '1', '--warmup', '0', '--out', output], {
          out: () => {}, err: (line) => errors.push(line),
        })
      } finally {
        if (previous === undefined) delete process.env.NODE_OPTIONS
        else process.env.NODE_OPTIONS = previous
      }
      const evidence = JSON.parse(fs.readFileSync(output, 'utf8'))
      assert.equal(Number(fs.readFileSync(counter, 'utf8')), QUERIES.length * 4)
      assert.equal(evidence.verdict.outputsIdentical, true, 'identity is separate from validity')
      assert.ok(evidence.cases.every((item) => item.walk.statuses.every((status) => status === 0) && item.index.statuses.every((status) => status === 0)))
      assert.equal(code, 1, 'cold failures must fail the command')
      assert.equal(evidence.verdict.failures.length, QUERIES.length * 2)
      const expected = exitCode === 0 ? /^cold .* returned a failed\/incomplete result$/ : /^cold .* exit 7$/
      assert.ok(evidence.verdict.failures.every((failure) => expected.test(failure)))
      assert.ok(evidence.cold.every((item) => Object.values(item.runs).every((run) => run.status === exitCode && run.timedOut === false && run.failed === (exitCode === 0))))
      assert.ok(errors.some((line) => line.includes('cold ')))
    })
  })
}

report('bench-index-ab')
