/**
 * The `tracks` subcommand (#993): judge the scripted V4 behavior trajectories —
 * paged cursor, catalog recovery, load order, wait/multi-dispatch — against their
 * fixed task facts, and report the recovery accounting with its denominator rule.
 *
 * This is verifier self-proof before V5: every scripted track declares what the
 * verifier should say, the command exits non-zero the moment a verdict disagrees,
 * and the recovery line says "no denominator" instead of 100% when a selection
 * contains no track that ever had a correction opportunity.
 *
 * @module dsh-ops/bench/tracks-cli
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadTrackTasks, scriptedTracks, TRACK_TASK_IDS } from './lib/track-corpus.mjs'
import { judgeTrack, recoverySummary } from './lib/tracks.mjs'

/** The flags that take one value. */
const FLAGS_WITH_VALUE = ['--task', '--track']

/** The command's own help, printed for `tracks --help`. */
export function tracksUsage() {
  return [
    'usage: node bench/cli.mjs tracks [--task <id>] [--track <id>]',
    '',
    'Judges the scripted V4 behavior trajectories (#993) against their task facts.',
    'No model request and no worker spawn: this is the verifier self-proof step.',
    '',
    '--task <id>    only the tracks of one task (' + TRACK_TASK_IDS.join(', ') + ')',
    '--track <id>   one scripted trajectory by id',
    '',
    'Exit codes: 0 every verdict matched its declared expectation · 1 a verdict disagreed · 2 usage error',
  ].join('\n')
}

/**
 * Run the command.
 * @param {string[]} argv - the arguments after `tracks`.
 * @param {{out?: (line: string) => void, err?: (line: string) => void}} [io] - the output sinks.
 * @returns {Promise<number>} the exit code: 0 agreed, 1 disagreed, 2 usage error.
 */
export async function main(argv = [], io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  let taskId
  let trackId
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '-h' || flag === '--help') {
      out(tracksUsage())
      return 0
    }
    if (FLAGS_WITH_VALUE.includes(flag)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        err('bench tracks: ' + flag + ' needs a value')
        err('run "node bench/cli.mjs tracks --help" for usage')
        return 2
      }
      if (flag === '--task') taskId = value
      else trackId = value
      index += 1
      continue
    }
    err('bench tracks: unknown option "' + flag + '"')
    err('run "node bench/cli.mjs tracks --help" for usage')
    return 2
  }
  const tasks = loadTrackTasks()
  if (taskId !== undefined && !TRACK_TASK_IDS.includes(taskId)) {
    err('bench tracks: unknown task "' + taskId + '" (known: ' + TRACK_TASK_IDS.join(', ') + ')')
    return 2
  }
  let tracks = scriptedTracks(tasks)
  if (taskId !== undefined) tracks = tracks.filter((track) => track.taskId === taskId)
  if (trackId !== undefined) {
    if (!tracks.some((track) => track.id === trackId)) {
      err('bench tracks: unknown track "' + trackId + '" (known: ' + tracks.map((track) => track.id).join(', ') + ')')
      return 2
    }
    tracks = tracks.filter((track) => track.id === trackId)
  }
  const verdicts = tracks.map((track) => judgeTrack(track, tasks.find((task) => task.id === track.taskId)))
  for (const verdict of verdicts) {
    out(verdict.id + ' (' + verdict.taskId + '): declared ' + verdict.declared + ', judged ' + verdict.verdict
      + ', opportunities ' + verdict.opportunities + ', waits ' + verdict.waits)
    for (const fact of verdict.mismatches) out('  - ' + fact)
  }
  const summary = recoverySummary(verdicts)
  if (summary.hasDenominator) {
    out('recovery: ' + summary.recovered + '/' + summary.withOpportunity + ' tracks with a correction opportunity recovered (' + Math.round(summary.rate * 100) + '%)')
  } else {
    out('recovery: no denominator (0 tracks had a correction opportunity, so no rate is reported)')
  }
  out(summary.note)
  const disagreed = verdicts.filter((verdict) => !verdict.matched).length
  out('tracks: ' + verdicts.length + ' judged, ' + (verdicts.length - disagreed) + ' matched the declared expectation')
  return disagreed === 0 ? 0 : 1
}

// Only when executed, not when imported by the suite or the dispatcher.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
