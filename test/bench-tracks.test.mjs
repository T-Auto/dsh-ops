/**
 * The V4 behavior-track gate (#993): four Flash behavior samples — paged cursor
 * continuation, catalog-error recovery, load-before-use, and wait/multi-dispatch —
 * each with a business-goal prompt, a scripted pass trajectory and scripted fail
 * trajectories, plus the verifier that must tell them apart.
 *
 * The red step of this suite came first: every module it imports was absent, so the
 * first run failed at the import. The green step is the corpus + verifier landing.
 * The suite never spawns a worker and never sends a model request: it judges
 * scripted trajectories only, which is exactly what the card asks (V5 owns real runs).
 *
 * @module dsh-ops/test/bench-tracks
 */

import fs from 'node:fs'
import path from 'node:path'

import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { TASKS_DIR, loadTasks } from '../bench/lib/tasks.mjs'
import { GENERATORS, generate } from '../bench/lib/fixtures/index.mjs'
import { derivePagedLog } from '../bench/lib/fixtures/paged.mjs'
import { verifyWorkspace } from '../bench/lib/verify.mjs'
import { judgeTrack, recoverySummary } from '../bench/lib/tracks.mjs'
import { loadTrackTasks, scriptedTracks, TRACK_TASK_IDS } from '../bench/lib/track-corpus.mjs'
import { main as cliMain, usage } from '../bench/cli.mjs'

const LABEL = 'bench-tracks'

/** Write one generated fixture file into a workspace, creating its parents. */
const write = (dir, file) => {
  const target = path.join(dir, ...file.path.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, file.content, 'utf8')
}

// ------------------------------------------------------------ the corpus

await test('the four V4 task files validate against the real registries', async () => {
  const corpus = loadTasks(TASKS_DIR, { generators: GENERATORS })
  const ids = corpus.map((task) => task.id)
  for (const id of TRACK_TASK_IDS) {
    const task = corpus.find((entry) => entry.id === id)
    assert.ok(task, 'task ' + id + ' must exist in bench/tasks')
    assert.ok(!task.prompt.toLowerCase().includes('verifier'), 'the ' + id + ' prompt must not name the verifier')
    assert.ok(!/nextoffset|cursor|load_sdk/i.test(task.prompt), 'the ' + id + ' prompt must not teach the tool steps')
  }
  assert.equal(ids.length, new Set(ids).size, 'task ids must be unique')
})

await test('pagedLog puts the target on the second page and its answer derives from the bytes', () => {
  const { files, exports } = generate('pagedLog', { seed: 41, lines: 600, markerAt: 350, pageSize: 200 })
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'logs/stream.log')
  assert.deepEqual(derivePagedLog(files), exports, 'the exported answer must be recomputable from the bytes')
  assert.ok(exports.markerLine > 200, 'the marker must sit beyond page 1 at the default page size')
  assert.ok(exports.markerLine <= 400, 'the marker must sit on page 2 at the default page size')
  const lines = files[0].content.split('\n')
  assert.ok(lines[exports.markerLine - 1].includes(exports.markerText), 'the marker line must carry the marker payload')
  assert.ok(exports.markerText.includes('TARGET-'), 'the marker payload must carry the TARGET token')
  assert.equal(exports.answer, exports.markerLine + ' ' + exports.markerText)
})

await test('each task workspace verify accepts the correct answer and rejects a wrong one', async () => {
  const tasks = await loadTrackTasks()
  assert.equal(tasks.length, 4)
  for (const entry of tasks) {
    await withTempDir('bench-tracks-verify', async (dir) => {
      for (const file of entry.files) write(dir, file)
      // The wait task also requires the business edit the prompt asks for.
      if (entry.id === 'ptc-wait-dispatch') {
        const target = path.join(dir, entry.answer.content)
        const before = fs.readFileSync(target, 'utf8')
        const edited = before.replace('"MAX_UPLOAD_MB": ' + entry.exports.value, '"MAX_UPLOAD_MB": ' + 900)
        assert.notEqual(edited, before, 'the edit pattern must match the winner file')
        fs.writeFileSync(target, edited)
      }
      fs.writeFileSync(path.join(dir, 'answer.txt'), entry.answer.content)
      const good = await verifyWorkspace(dir, entry.task.verify, entry.exports)
      assert.ok(good.passed, entry.id + ': the correct answer must pass every workspace check (got: ' + good.checks.map((c) => c.detail).join(' | ') + ')')
      fs.writeFileSync(path.join(dir, 'answer.txt'), 'definitely not the answer')
      const bad = await verifyWorkspace(dir, entry.task.verify, entry.exports)
      assert.ok(!bad.passed, entry.id + ': a wrong answer must fail the workspace check')
    })
  }
})

// ------------------------------------------------------------ the verdicts

const judge = async () => {
  const tasks = await loadTrackTasks()
  return scriptedTracks(tasks).map((track) => judgeTrack(track, tasks.find((task) => task.id === track.taskId)))
}

await test('every task has a should-pass and a should-fail trajectory, and the verifier agrees with both', async () => {
  const verdicts = await judge()
  assert.equal(verdicts.length, 10, 'the scripted corpus holds ten tracks')
  for (const id of TRACK_TASK_IDS) {
    const own = verdicts.filter((verdict) => verdict.taskId === id)
    assert.ok(own.some((v) => v.declared === 'pass'), id + ' needs a should-pass trajectory')
    assert.ok(own.some((v) => v.declared === 'fail'), id + ' needs a should-fail trajectory')
  }
  for (const verdict of verdicts) {
    assert.equal(verdict.matched, true,
      verdict.id + ': declared ' + verdict.declared + ' but judged ' + verdict.verdict + ' (' + verdict.mismatches.join(' | ') + ')')
  }
})

await test('the paging verifier names the ignored cursor, the unreached complete page and the wrong answer', async () => {
  const verdicts = await judge()
  const pass = verdicts.find((v) => v.id === 'ptc-paged-cursor-pass')
  assert.equal(pass.verdict, 'pass')
  assert.deepEqual(pass.mismatches, [])
  assert.ok(pass.opportunities >= 2, 'every partial page is a continuation cue the model must act on')
  assert.equal(pass.recovered, true)
  const retry = verdicts.find((v) => v.id === 'ptc-paged-cursor-retry')
  assert.equal(retry.verdict, 'fail')
  assert.match(retry.mismatches.join(' | '), /cursor|offset/i)
  assert.match(retry.mismatches.join(' | '), /complete/i)
  assert.match(retry.mismatches.join(' | '), /answer/)
  const early = verdicts.find((v) => v.id === 'ptc-paged-cursor-early')
  assert.equal(early.verdict, 'fail')
  assert.match(early.mismatches.join(' | '), /answer/)
})

await test('the catalog verifier accepts only advertised alternatives and names the invented one', async () => {
  const verdicts = await judge()
  const pass = verdicts.find((v) => v.id === 'ptc-catalog-recover-pass')
  assert.equal(pass.verdict, 'pass')
  assert.equal(pass.opportunities, 1)
  assert.equal(pass.recovered, true)
  const fail = verdicts.find((v) => v.id === 'ptc-catalog-nonexistent-recover')
  assert.equal(fail.verdict, 'fail')
  assert.match(fail.mismatches.join(' | '), /ops_searchall/)
  assert.match(fail.mismatches.join(' | '), /advertised/)
  assert.match(fail.mismatches.join(' | '), /answer/)
})

await test('the load verifier demands load_sdk before the next program can use the tool', async () => {
  const verdicts = await judge()
  const pass = verdicts.find((v) => v.id === 'ptc-sdk-load-then-use-pass')
  assert.equal(pass.verdict, 'pass')
  assert.equal(pass.opportunities, 1)
  assert.equal(pass.recovered, true)
  const fail = verdicts.find((v) => v.id === 'ptc-sdk-retry-without-load')
  assert.equal(fail.verdict, 'fail')
  assert.match(fail.mismatches.join(' | '), /load/)
  assert.match(fail.mismatches.join(' | '), /answer/)
})

await test('waits are not misjudged: the lock wait passes, the immediate counter-example needs no retry at all', async () => {
  const verdicts = await judge()
  const wait = verdicts.find((v) => v.id === 'ptc-wait-lock-pass')
  assert.equal(wait.verdict, 'pass', 'the lock wait must not be flagged (' + wait.mismatches.join(' | ') + ')')
  assert.ok(wait.waits >= 1, 'the bounded-transient re-issue must count as a real wait')
  assert.equal(wait.recovered, true)
  const immediate = verdicts.find((v) => v.id === 'ptc-wait-immediate-pass')
  assert.equal(immediate.verdict, 'pass')
  assert.deepEqual(immediate.mismatches, [])
  assert.equal(immediate.opportunities, 0)
  assert.equal(immediate.recovered, null, 'a track without a correction opportunity has no recovery value')
  assert.equal(immediate.waits, 0)
  const fail = verdicts.find((v) => v.id === 'ptc-wait-no-progress')
  assert.equal(fail.verdict, 'fail')
  assert.match(fail.mismatches.join(' | '), /no-progress|verbatim/i)
  assert.match(fail.mismatches.join(' | '), /revision/i)
})

// ------------------------------------------------------------ recovery accounting

await test('the recovery rate counts only tracks with a correction opportunity and never invents a denominator', async () => {
  const verdicts = await judge()
  const summary = recoverySummary(verdicts)
  assert.equal(summary.tracks, 10)
  assert.equal(summary.withOpportunity, 9, 'only the immediate counter-example has no correction opportunity')
  assert.equal(summary.recovered, 4)
  assert.equal(summary.rate, 4 / 9)
  const onlyImmediate = recoverySummary(verdicts.filter((v) => v.id === 'ptc-wait-immediate-pass'))
  assert.equal(onlyImmediate.withOpportunity, 0)
  assert.equal(onlyImmediate.rate, null)
  assert.equal(onlyImmediate.hasDenominator, false)
  assert.ok(onlyImmediate.note.includes('no denominator'), 'a missing denominator must be said, not reported as 100%')
})

// ------------------------------------------------------------ the CLI

await test('bench/cli.mjs lists tracks and the command judges the corpus end to end', async () => {
  assert.match(usage(), /\n  tracks\s/)
  const lines = []
  const io = { out: (line) => lines.push(line), err: (line) => lines.push('ERR ' + line) }
  const code = await cliMain(['tracks'], io)
  assert.equal(code, 0, lines.join('\n'))
  const text = lines.join('\n')
  assert.ok(text.includes('ptc-paged-cursor-pass'), 'every scripted track must be reported')
  assert.match(text, /recovery: 4\/9|recovery: 44%/)
  const scoped = []
  await cliMain(['tracks', '--task', 'ptc-wait-dispatch'], { out: (line) => scoped.push(line), err: (line) => scoped.push('ERR ' + line) })
  assert.ok(scoped.join('\n').includes('ptc-wait-immediate-pass'), '--task must scope the corpus')
  const single = []
  await cliMain(['tracks', '--track', 'ptc-wait-immediate-pass'], { out: (line) => single.push(line), err: (line) => single.push('ERR ' + line) })
  assert.ok(single.join('\n').includes('no denominator'), 'the no-retry counter-example must report no denominator')
  const bogus = []
  assert.equal(await cliMain(['tracks', '--track', 'nope'], { out: (line) => bogus.push(line), err: (line) => bogus.push('ERR ' + line) }), 2)
  assert.match(bogus.join('\n'), /unknown track/)
})

report(LABEL)
