/**
 * The V4 behavior-track verifier (#993): it judges one scripted trajectory —
 * an ordered list of programs, each holding the tool calls it dispatched and the
 * envelopes that came back — against the fixed facts of its task, and it says
 * which fact failed when the verdict is fail. It never talks to a model and never
 * spawns a worker: V5 will feed real captured trajectories through the same
 * functions, so the judging rules must not depend on anything but the data.
 *
 * Two rules are shared by every task and live here once:
 *
 * - A verbatim re-issue (same API, same arguments) is a no-progress retry when the
 *   earlier envelope had already delivered a result (completed, or a partial page
 *   whose data is final for that request) or refused it with an input-side fix
 *   (retry never / after-input-change) and nothing changed in between. It is a
 *   real wait when the envelope asked for a state-side pause
 *   (after-state-change / bounded-transient), and it is a deliberate follow-through
 *   when a completed ops_load_sdk landed between the two calls.
 * - A correction opportunity is a response the model had to act on: a
 *   rejection, an error, a conflict, or a partial page carrying a nextOffset.
 *   Recovery counts only tracks that had at least one; a selection with none
 *   reports an explicit no-denominator line instead of 100%.
 *
 * The scripted envelopes follow the shipped outcome vocabulary (status /
 * error.code / error.retry). Two codes are corpus markers, not shipped codes:
 * UNKNOWN_API and NOT_IN_SDK stand for the honest feedback the real SDK gives
 * when a name is absent — until V5 replaces them with real captured envelopes.
 *
 * @module dsh-ops/bench/tracks
 */

/** Responses that delivered their data: a verbatim re-issue after one is waste. */
const DELIVERED = ['completed', 'partial']
/** Retry advice that asks the environment (not the input) to change first. */
const TRANSIENT_RETRY = ['after-state-change', 'bounded-transient']
/** Responses a model must act on; each one is a correction opportunity. */
const SIGNAL_STATUSES = ['rejected', 'error', 'conflict']

/** Clamp a fact message so a verdict stays readable in a report. */
const short = (text) => {
  const value = String(text)
  return value.length > 80 ? value.slice(0, 77) + '...' : value
}

/**
 * Flatten one trajectory into ordered steps.
 * @param {object} track - the scripted trajectory.
 * @returns {{index: number, program: number, api: string, args: object, response: object}[]} every call in order.
 */
function stepsOf(track) {
  const steps = []
  track.programs.forEach((program, programIndex) => {
    for (const call of program.calls ?? []) {
      steps.push({ index: steps.length, program: programIndex + 1, api: String(call.api), args: call.args ?? {}, response: call.response ?? {} })
    }
  })
  return steps
}

/** The dedupe key of one step: same API, same arguments. */
const stepKey = (step) => step.api + ' ' + JSON.stringify(step.args)

/**
 * Detect verbatim re-issues: no-progress retries become facts, real waits are counted.
 * @param {{index: number, program: number, api: string, args: object, response: object}[]} steps - every call in order.
 * @param {(fact: string) => void} add - record one failed fact.
 * @returns {number} how many legitimate waits the trajectory spent.
 */
export function scanReissues(steps, add) {
  let waits = 0
  const previous = new Map()
  for (const step of steps) {
    const key = stepKey(step)
    const earlier = previous.get(key)
    previous.set(key, step)
    if (earlier === undefined) continue
    const response = earlier.response ?? {}
    const between = steps.slice(earlier.index + 1, step.index)
    const loadedInBetween = between.some((other) => other.api === 'ops_load_sdk' && other.response?.status === 'completed')
    if (loadedInBetween) continue // deliberate follow-through after fixing the SDK state
    if (DELIVERED.includes(response.status)) {
      add('no-progress retry: ' + step.api + ' ' + short(stepKey(step).slice(step.api.length + 1)) + ' was re-issued verbatim after its result had already been delivered')
    } else if (TRANSIENT_RETRY.includes(response.error?.retry)) {
      waits += 1 // the envelope asked for a pause, and the model waited instead of re-routing
    } else {
      add('no-progress retry: ' + step.api + ' was re-issued verbatim although the envelope said retry: ' + String(response.error?.retry) + ' — change the input or load the tool first')
    }
  }
  return waits
}

/**
 * Count the correction opportunities in one trajectory.
 * @param {{index: number, program: number, api: string, args: object, response: object}[]} steps - every call in order.
 * @returns {number} how many responses the model had to act on.
 */
export function countOpportunities(steps) {
  return steps.filter((step) => {
    const response = step.response ?? {}
    if (SIGNAL_STATUSES.includes(response.status)) return true
    if (response.status === 'partial' && Number.isInteger(Number(response.data?.nextOffset)) && Number(response.data?.nextOffset) > 0) return true
    return false
  }).length
}

/**
 * Judge one scripted trajectory against its task's fixed facts.
 * @param {object} track - the trajectory: {id, taskId, declared, programs, answer}.
 * @param {object} task - the task descriptor from the corpus loader: {id, sdk, budget, answer, verify}.
 * @returns {{id: string, taskId: string, declared: string, verdict: string, matched: boolean, mismatches: string[], opportunities: number, waits: number, recovered: boolean|null}} the verdict.
 * @throws {Error} when the track and the task do not match, or no verifier is registered.
 */
export function judgeTrack(track, task) {
  if (!task || task.id !== track.taskId) {
    throw new Error('judgeTrack: track "' + String(track?.id) + '" names task "' + String(track?.taskId) + '" but was handed task "' + String(task?.id) + '"')
  }
  const verifier = TASK_VERIFIERS[task.id]
  if (verifier === undefined) throw new Error('judgeTrack: no verifier is registered for task "' + task.id + '"')
  const steps = stepsOf(track)
  const mismatches = []
  const add = (fact) => mismatches.push(fact)
  verifier(track, task, steps, add)
  const waits = scanReissues(steps, add)
  if (String(track.answer ?? '').trim() !== String(task.answer.content).trim()) {
    add('answer.txt: expected "' + short(task.answer.content) + '" but the track wrote "' + short(track.answer) + '"')
  }
  if (track.programs.length > task.budget.maxPrograms) {
    add('the track spent ' + track.programs.length + ' programs, over the fixed budget of ' + task.budget.maxPrograms)
  }
  const opportunities = countOpportunities(steps)
  const verdict = mismatches.length === 0 ? 'pass' : 'fail'
  return {
    id: track.id,
    taskId: track.taskId,
    declared: track.declared,
    verdict,
    matched: verdict === track.declared,
    mismatches,
    opportunities,
    waits,
    recovered: opportunities === 0 ? null : verdict === 'pass',
  }
}

/**
 * Summarise recovery over a selection of verdicts.
 * @param {object[]} verdicts - judgeTrack results.
 * @returns {{tracks: number, withOpportunity: number, recovered: number, rate: number|null, hasDenominator: boolean, note: string}} the accounting.
 */
export function recoverySummary(verdicts) {
  const withOpportunity = verdicts.filter((verdict) => verdict.opportunities > 0)
  const recovered = withOpportunity.filter((verdict) => verdict.recovered === true).length
  const hasDenominator = withOpportunity.length > 0
  return {
    tracks: verdicts.length,
    withOpportunity: withOpportunity.length,
    recovered,
    rate: hasDenominator ? recovered / withOpportunity.length : null,
    hasDenominator,
    note: hasDenominator
      ? 'recovered ' + recovered + ' of ' + withOpportunity.length + ' tracks that had a correction opportunity'
      : 'no denominator: no track in this selection had a correction opportunity, so no recovery rate is reported (never 100%)',
  }
}

// ---------------------------------------------------------------- the four fact verifiers

/**
 * `ptc-paged-lookup`: a partial page must be continued at its nextOffset in the next
 * program on the same path, and a complete page ends the read chain.
 */
function verifyPaged(track, task, steps, add) {
  const spec = task.verify
  const reads = steps.filter((step) => step.api === 'ops_inspect_local_file' && step.args.path === spec.path)
  if (reads.length === 0) {
    add('no read of ' + spec.path + ' ever happened')
    return
  }
  let cursor = null
  let cursorProgram = 0
  let completeAt = null
  for (const read of reads) {
    const offset = Number(read.args.offset ?? 1)
    if (completeAt !== null) {
      add('read of ' + spec.path + ' at offset ' + offset + ' after the complete page — a complete page ends the read chain')
      continue
    }
    if (cursor !== null && offset !== cursor) {
      add('read at offset ' + offset + ' ignored the pending cursor (the envelope said nextOffset ' + cursor + ')')
    }
    if (cursor !== null && offset === cursor && read.program <= cursorProgram) {
      add('the continuation at offset ' + offset + ' ran in program ' + read.program + ', not in a program after the one that set the cursor')
    }
    if (read.response.status === 'partial') {
      const next = Number(read.response.data?.nextOffset)
      if (!Number.isInteger(next) || next <= offset) {
        add('partial page at offset ' + offset + ' carried no advancing nextOffset')
      } else {
        cursor = next
        cursorProgram = read.program
      }
    } else if (read.response.status === 'completed') {
      completeAt = read.program
      cursor = null
    } else {
      add('unexpected status "' + String(read.response.status) + '" while reading ' + spec.path)
    }
  }
  if (cursor !== null) {
    add('the read chain stopped with a pending cursor at offset ' + cursor + ' — the next program must continue at that offset')
  }
  if (completeAt === null) {
    add('no complete page ever ended the read chain of ' + spec.path)
  }
}

/**
 * `ptc-catalog-recover`: after the wrong call was rejected, every following call
 * must use an advertised API, and one advertised alternative must have worked.
 */
function verifyCatalog(track, task, steps, add) {
  const rejectedAt = steps.findIndex((step) => step.response.status === 'rejected' && step.response.error?.code === 'UNKNOWN_API')
  if (rejectedAt < 0) {
    add('the catalog-error track never made the wrong call (no UNKNOWN_API rejection happened)')
    return
  }
  const after = steps.slice(rejectedAt + 1)
  for (const step of after) {
    if (!task.sdk.includes(step.api)) {
      add('call "' + step.api + '" after the wrong input is not in the advertised SDK set (known: ' + task.sdk.join(', ') + ')')
    }
  }
  if (!after.some((step) => task.sdk.includes(step.api) && step.response.status === 'completed')) {
    add('no advertised alternative was used after the wrong input')
  }
}

/**
 * `ptc-sdk-load-order`: the needed tool must be loaded before it is used, and a
 * completed use may only run in a program after the one that loaded it.
 */
function verifySdkLoad(track, task, steps, add) {
  const spec = task.verify
  const uses = steps.filter((step) => step.api === spec.api)
  if (!uses.some((step) => step.response.status === 'rejected' && step.response.error?.code === 'NOT_IN_SDK')) {
    add('the track never hit the not-loaded rejection of ' + spec.api)
  }
  const load = steps.find((step) => step.api === spec.loader && step.response.status === 'completed')
  const loadsTools = load === undefined ? [] : (Array.isArray(load.args?.tools) ? load.args.tools : [])
  if (load === undefined || !spec.needed.every((name) => loadsTools.includes(name))) {
    add(spec.loader + ' was never called with the needed names (' + spec.needed.join(', ') + ')')
  }
  const firstUse = uses.find((step) => step.response.status === 'completed')
  if (firstUse === undefined) {
    add(spec.api + ' was never used successfully, so the answer cannot come from it')
    return
  }
  if (load === undefined || firstUse.index < load.index) {
    add('a completed ' + spec.api + ' call ran before ' + spec.loader + ' loaded it')
  } else if (firstUse.program <= load.program) {
    add('a completed ' + spec.api + ' call ran in program ' + firstUse.program + ', not in a program after the load (program ' + load.program + ')')
  }
}

/**
 * `ptc-wait-dispatch`: the independent layer reads are batched in one program, the
 * edit must await the read result through expectedRevision, and a bounded-transient
 * pause is a real wait, never a flagged retry.
 */
function verifyWaitDispatch(track, task, steps, add) {
  const spec = task.verify
  const edits = steps.filter((step) => step.api === spec.editApi && step.args.path === spec.winner)
  if (edits.length === 0) {
    add('the winning layer ' + spec.winner + ' was never edited')
    return
  }
  const revision = edits[0].args?.expectedRevision
  const read = steps.find((step) => step.api === 'ops_inspect_local_file' && step.args.path === spec.winner
    && step.response.status === 'completed' && step.response.data?.revision === revision)
  if (typeof revision !== 'string' || read === undefined || read.index >= edits[0].index) {
    add('the edit did not await the read result: expectedRevision ' + JSON.stringify(revision ?? null) + ' does not come from an earlier completed read of ' + spec.winner)
  }
  const perProgram = new Map()
  for (const step of steps) {
    if (step.api === 'ops_inspect_local_file' && step.response.status === 'completed') {
      perProgram.set(step.program, (perProgram.get(step.program) ?? 0) + 1)
    }
  }
  if (![...perProgram.values()].some((count) => count >= 2)) {
    add('the independent layer reads were not dispatched together in one program')
  }
}

/** The verifier registry: one entry per V4 behavior task (#993). */
export const TASK_VERIFIERS = {
  'ptc-paged-lookup': verifyPaged,
  'ptc-catalog-recover': verifyCatalog,
  'ptc-sdk-load-order': verifySdkLoad,
  'ptc-wait-dispatch': verifyWaitDispatch,
}
