/**
 * The scripted V4 behavior corpus (#993): the fixed task descriptors and the
 * should-pass / should-fail trajectories that prove the verifier can tell them
 * apart before any real model ever runs (V5 owns real trajectories).
 *
 * Every track derives its expected values from the real fixture bytes — the
 * correct answer, the match lists, the winner path — so a scripted pass can never
 * drift from the workspace the sweep would generate. The prompts in the task files
 * stay business-only; nothing here leaks the judged facts into them.
 *
 * Envelope vocabulary follows the shipped outcome shapes (status / error.code /
 * error.retry). UNKNOWN_API and NOT_IN_SDK are corpus markers for the feedback the
 * real SDK signals by absence; V5 replaces them with captured envelopes.
 *
 * @module dsh-ops/bench/track-corpus
 */

import { GENERATORS, generate } from './fixtures/index.mjs'
import { loadTasks, TASKS_DIR } from './tasks.mjs'

/** The four V4 behavior tasks, in corpus order. */
export const TRACK_TASK_IDS = ['ptc-paged-lookup', 'ptc-catalog-recover', 'ptc-sdk-load-order', 'ptc-wait-dispatch']

/**
 * Load the four task descriptors with their fixtures generated and their facts fixed.
 * @param {{tasksDir?: string}} [options] - override the corpus directory (suites pass a temp copy).
 * @returns {object[]} one descriptor per task: {id, task, files, exports, sdk, budget, answer, verify}.
 * @throws {Error} when a task file is missing, fails validation, or its fixture cannot generate.
 */
export function loadTrackTasks(options = {}) {
  const dir = options.tasksDir ?? TASKS_DIR
  const corpus = loadTasks(dir, { generators: GENERATORS })
  return TRACK_TASK_IDS.map((id) => {
    const task = corpus.find((entry) => entry.id === id)
    if (task === undefined) throw new Error('track task "' + id + '" is missing from ' + dir)
    return buildTaskEntry(task)
  })
}

/** Build one task descriptor: the fixture bytes, the fixed permissions, budget, answer and verifier facts. */
function buildTaskEntry(task) {
  const { files, exports } = generate(task.fixture.generator, task.fixture.params ?? {})
  const base = { id: task.id, task, files, exports, answer: { path: 'answer.txt', content: '' }, budget: { maxPrograms: 8 }, sdk: [], verify: {} }
  if (task.id === 'ptc-paged-lookup') {
    return { ...base,
      sdk: ['ops_inspect_local_file', 'ops_load_sdk', 'ops_write_file'],
      answer: { path: 'answer.txt', content: String(exports.answer) },
      verify: { path: 'logs/stream.log', pageSize: 200 },
    }
  }
  if (task.id === 'ptc-catalog-recover') {
    return { ...base,
      sdk: ['ops_inspect_local_file', 'ops_grep', 'ops_glob', 'ops_write_file'],
      answer: { path: 'answer.txt', content: exports.matches.join('\n') },
      verify: { needle: task.fixture.params.needle, count: task.fixture.params.needleFiles },
    }
  }
  if (task.id === 'ptc-sdk-load-order') {
    return { ...base,
      sdk: ['ops_inspect_local_file'],
      answer: { path: 'answer.txt', content: exports.matches.join('\n') },
      verify: { api: 'ops_grep', loader: 'ops_load_sdk', needed: ['grep', 'write_file'] },
    }
  }
  return { ...base,
    sdk: ['ops_inspect_local_file', 'ops_read_files', 'ops_glob', 'ops_edit_file', 'ops_write_file'],
    answer: { path: 'answer.txt', content: String(exports.source) },
    verify: { winner: String(exports.source), editApi: 'ops_edit_file' },
  }
}

// ---------------------------------------------------------------- envelope helpers

/** One program: a note plus the calls it dispatched, in order. */
const program = (note, ...calls) => ({ note, calls })
/** One dispatched call and the envelope that came back. */
const call = (api, args, response) => ({ api, args, response })
/** A completed envelope. */
const ok = (data) => ({ status: 'completed', data: data ?? {} })
/** A partial page whose continuation cue is its nextOffset. */
const partialPage = (nextOffset, total) => ({ status: 'partial', data: { lineCount: 200, nextOffset, total } })
/** The final page: nothing follows it. */
const completePage = (total) => ({ status: 'completed', data: { lineCount: 200, total } })
/** A final refusal. */
const refused = (code, message) => ({ status: 'rejected', error: { code, message, effectState: 'none', retry: 'never' } })
/** The lock is busy; the same call may land once the state changes. */
const lockBusy = () => ({ status: 'error', error: { code: 'JOB_BUSY', effectState: 'none', retry: 'bounded-transient', message: 'the update lock is held by a concurrent writer; re-issue the same edit when it releases' } })
/** The input is wrong; re-issuing it unchanged gains nothing. */
const invalid = (message) => ({ status: 'error', error: { code: 'INVALID_ARGUMENT', effectState: 'none', retry: 'after-input-change', message } })

// ---------------------------------------------------------------- the scripted tracks

/** `ptc-paged-lookup`: cursor continuation, verbatim re-read, early stop. */
function pagingTracks(entry) {
  const path = entry.verify.path
  const total = entry.exports.totalLines
  const answer = entry.answer.content
  const read = (offset, response) => call('ops_inspect_local_file', { path, offset, limit: 200 }, response)
  const loadWriter = program('load the writer for the answer', call('ops_load_sdk', { tools: ['write_file'] }, ok({ loaded: ['write_file'] })))
  const write = (content) => program('write the answer', call('ops_write_file', { path: 'answer.txt', content }, ok()))
  return [
    { id: 'ptc-paged-cursor-pass', taskId: entry.id, declared: 'pass', answer, programs: [
      program('read page 1; the envelope carries a nextOffset', read(1, partialPage(201, total))),
      program('the next program continues at the cursor on the same path', read(201, partialPage(401, total))),
      program('the last page is complete, so the read chain stops', read(401, completePage(total))),
      loadWriter,
      write(answer),
    ] },
    { id: 'ptc-paged-cursor-retry', taskId: entry.id, declared: 'fail', answer: '1 nothing found', programs: [
      program('read page 1; the envelope carries a nextOffset', read(1, partialPage(201, total))),
      program('re-read page 1 instead of continuing at the cursor', read(1, partialPage(201, total))),
      loadWriter,
      write('1 nothing found'),
    ] },
    { id: 'ptc-paged-cursor-early', taskId: entry.id, declared: 'fail', answer: 'no match in the log', programs: [
      program('read page 1; the envelope carries a nextOffset', read(1, partialPage(201, total))),
      loadWriter,
      write('no match in the log'),
    ] },
  ]
}

/** `ptc-catalog-recover`: an invented name is refused; the recovery either uses an advertised API or invents another one. */
function catalogTracks(entry) {
  const needle = entry.verify.needle
  const unknown = (name) => refused('UNKNOWN_API', name + ' is not in this SDK. Available APIs: ' + entry.sdk.join(', ') + '.')
  const search = (api) => call(api, { pattern: needle, path: 'src' }, null)
  return [
    { id: 'ptc-catalog-recover-pass', taskId: entry.id, declared: 'pass', answer: entry.answer.content, programs: [
      program('the remembered name is refused, so the same program uses an advertised one',
        { ...search('ops_find'), response: unknown('ops_find') },
        call('ops_grep', { pattern: needle, path: 'src' }, ok({ matches: entry.exports.matches }))),
      program('write the answer', call('ops_write_file', { path: 'answer.txt', content: entry.answer.content }, ok())),
    ] },
    { id: 'ptc-catalog-nonexistent-recover', taskId: entry.id, declared: 'fail', answer: 'src/guess.js', programs: [
      program('the remembered name is refused', { ...search('ops_find'), response: unknown('ops_find') }),
      program('chase a second invented name instead of an advertised one', { ...search('ops_searchall'), response: unknown('ops_searchall') }),
      program('write a guess', call('ops_write_file', { path: 'answer.txt', content: 'src/guess.js' }, ok())),
    ] },
  ]
}

/** `ptc-sdk-load-order`: load the missing tool, or retry the call unchanged. */
function sdkLoadTracks(entry) {
  const needle = entry.task.fixture.params.needle
  const notInSdk = () => refused('NOT_IN_SDK', 'ops_grep is not in the current SDK; load it with tools.ops_load_sdk({tools:["grep"]}) — it becomes callable in the next program.')
  const grep = (response) => call('ops_grep', { pattern: needle, path: 'src' }, response)
  return [
    { id: 'ptc-sdk-load-then-use-pass', taskId: entry.id, declared: 'pass', answer: entry.answer.content, programs: [
      program('grep is refused, so load it in the same program',
        grep(notInSdk()),
        call('ops_load_sdk', { tools: ['grep', 'write_file'] }, ok({ loaded: ['grep', 'write_file'] }))),
      program('the next program may use grep and write the answer',
        grep(ok({ matches: entry.exports.matches })),
        call('ops_write_file', { path: 'answer.txt', content: entry.answer.content }, ok())),
    ] },
    { id: 'ptc-sdk-retry-without-load', taskId: entry.id, declared: 'fail', answer: 'src/nothing.js', programs: [
      program('grep is refused', grep(notInSdk())),
      program('retry grep unchanged', grep(notInSdk())),
      program('load only the writer', call('ops_load_sdk', { tools: ['write_file'] }, ok({ loaded: ['write_file'] }))),
      program('write a guess', call('ops_write_file', { path: 'answer.txt', content: 'src/nothing.js' }, ok())),
    ] },
  ]
}

/** `ptc-wait-dispatch`: batched reads, a lock pause that must be waited out, an immediate counter-example, a no-progress retry. */
function waitTracks(entry) {
  const winner = entry.verify.winner
  const find = '"MAX_UPLOAD_MB": ' + entry.exports.value
  const replace = '"MAX_UPLOAD_MB": ' + 900
  const revision = 'rev-' + entry.exports.value
  const layers = ['README.md', 'config/defaults.json', 'config/production.json', winner]
  const readLayers = program('read every layer together', ...layers.map((file) => call('ops_inspect_local_file', { path: file }, ok({ file, revision: file === winner ? revision : 'rev-' + file.length }))))
  const edit = (expectedRevision, response) => call('ops_edit_file', { path: winner, find, replace, ...(expectedRevision === undefined ? {} : { expectedRevision }) }, response)
  const write = program('write the answer', call('ops_write_file', { path: 'answer.txt', content: winner }, ok()))
  return [
    { id: 'ptc-wait-lock-pass', taskId: entry.id, declared: 'pass', answer: winner, programs: [
      readLayers,
      program('edit the winner; the lock is held by another writer', edit(revision, lockBusy())),
      program('the lock released; the same edit lands', edit(revision, ok({ changed: 1, revision: 'rev-b2' }))),
      write,
    ] },
    { id: 'ptc-wait-immediate-pass', taskId: entry.id, declared: 'pass', answer: winner, programs: [
      readLayers,
      program('edit the winner; it lands at once', edit(revision, ok({ changed: 1, revision: 'rev-b2' }))),
      write,
    ] },
    { id: 'ptc-wait-no-progress', taskId: entry.id, declared: 'fail', answer: 'config/defaults.json', programs: [
      readLayers,
      program('edit without the revision the read returned', edit(undefined, invalid('expectedRevision is required: read the current file state first'))),
      program('retry the same broken edit unchanged', edit(undefined, invalid('expectedRevision is required: read the current file state first'))),
      program('write a guess', call('ops_write_file', { path: 'answer.txt', content: 'config/defaults.json' }, ok())),
    ] },
  ]
}

/**
 * Build the scripted trajectories for the loaded task descriptors.
 * @param {object[]} tasks - the descriptors from {@link loadTrackTasks}.
 * @returns {object[]} ten tracks: three paging, two catalog, two load, three wait.
 */
export function scriptedTracks(tasks) {
  return tasks.flatMap((entry) => {
    if (entry.id === 'ptc-paged-lookup') return pagingTracks(entry)
    if (entry.id === 'ptc-catalog-recover') return catalogTracks(entry)
    if (entry.id === 'ptc-sdk-load-order') return sdkLoadTracks(entry)
    return waitTracks(entry)
  })
}
