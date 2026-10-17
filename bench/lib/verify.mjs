/**
 * Machine verification of a finished benchmark workspace (PLAN.md §4.3).
 *
 * Eight check types, no shell anywhere: file checks go through `node:fs` and the
 * one command check goes through `node:child_process.spawn` with an argument
 * array. That is what keeps the verdict identical on a machine whose login shell
 * is bash and on one where it is PowerShell — a benchmark whose pass/fail depends
 * on the host shell would be measuring the shell, not the plugin.
 *
 * Every `expect` value names a key in the fixture's export dictionary, so the
 * expected answer is always derived from the bytes that were really generated;
 * `text` / `lines` / `count` literals are the alternative for fixed expectations.
 * A failing check never aborts the sweep: the report wants the full picture of
 * what the model did, not just the first thing that went wrong.
 *
 * @module dsh-ops/bench/verify
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

/** The check types a task may use, as a stable list for `tasks.mjs` validation. */
export const CHECK_TYPES = ['fileExists', 'fileMissing', 'fileEquals', 'fileContains', 'fileLines', 'countFiles', 'contentHashes', 'command']

/**
 * The persistent update-lock sidecar `ops_replace` writes beside every file it edits:
 * `.dsh-ops-update-<sha256 of the target's name>.lock`, created on first use and never
 * unlinked (`native/src/file.rs` — a cooperative path lock, not debris, because
 * publication is an atomic rename and the lock must outlive the target's inode).
 *
 * It is tooling state, not workspace content, so `contentHashes` ignores it: the task
 * still fails on every file the model changed, added or removed, but a candidate that
 * used `ops_replace` is not failed for the plugin's own bookkeeping. One directory per
 * run and the fixture's own names never match, so no expected entry can be skipped.
 */
const REPLACE_LOCK_SIDECAR = /^\.dsh-ops-update-[0-9a-f]{64}\.lock$/

/**
 * Verify a workspace against a task's check list.
 * @param {string} workspace - absolute directory the task ran in.
 * @param {object[]} checks - the task's `verify` array.
 * @param {Record<string, unknown>} [fixtureExports] - the generator's expected values.
 * @param {{execPath?: string, commandTimeoutMs?: number}} [options] - overrides for the runner.
 * @returns {Promise<{passed: boolean, checks: {type: string, path?: string, passed: boolean, detail: string}[]}>} the verdict.
 */
export async function verifyWorkspace(workspace, checks, fixtureExports = {}, options = {}) {
  const results = []
  for (const check of checks ?? []) {
    let result
    try {
      result = await runCheck(workspace, check, fixtureExports, options)
    } catch (error) {
      result = { type: check?.type ?? 'unknown', passed: false, detail: `check threw: ${String(error?.message ?? error)}` }
    }
    // One clamp for every check, however it built the string: details land in a
    // report a human reads, and a failing command check could otherwise paste a
    // whole stack trace into it.
    results.push({ ...result, detail: short(result.detail ?? '') })
  }
  return { passed: results.every((result) => result.passed), checks: results }
}

/**
 * Run one check.
 * @param {string} workspace - absolute directory to inspect.
 * @param {object} check - the check descriptor.
 * @param {Record<string, unknown>} fixtureExports - the generator's expected values.
 * @param {{execPath?: string, commandTimeoutMs?: number}} options - runner overrides.
 * @returns {Promise<{type: string, path?: string, passed: boolean, detail: string}>} the outcome.
 */
async function runCheck(workspace, check, fixtureExports, options) {
  const base = { type: String(check?.type ?? 'unknown'), passed: false, detail: '' }
  const expected = resolveExpected(check, fixtureExports)
  switch (check?.type) {
    case 'fileExists': {
      const target = inWorkspace(workspace, check.path)
      base.path = check.path
      base.passed = fs.existsSync(target) && fs.statSync(target).isFile()
      base.detail = base.passed ? 'present' : 'file not found'
      return base
    }
    case 'fileMissing': {
      const target = inWorkspace(workspace, check.path)
      base.path = check.path
      base.passed = !fs.existsSync(target)
      base.detail = base.passed ? 'absent as required' : `unexpectedly present: ${check.path}`
      return base
    }
    case 'fileEquals': {
      const target = inWorkspace(workspace, check.path)
      base.path = check.path
      if (!fs.existsSync(target)) {
        base.detail = 'file not found'
        return base
      }
      const actual = read(workspace, check.path).trim()
      const want = expectedText(expected).trim()
      base.passed = actual === want
      base.detail = base.passed ? 'matches expected content' : `expected ${short(want)} / got ${short(actual)}`
      return base
    }
    case 'fileContains': {
      const target = inWorkspace(workspace, check.path)
      base.path = check.path
      if (!fs.existsSync(target)) {
        base.detail = 'file not found'
        return base
      }
      const actual = read(workspace, check.path)
      const needle = expectedText(expected)
      base.passed = actual !== '' && actual.includes(needle)
      base.detail = base.passed ? `contains ${short(needle)}` : `does not contain ${short(needle)} (file is ${Buffer.byteLength(actual, 'utf8')} bytes)`
      return base
    }
    case 'fileLines': {
      const target = inWorkspace(workspace, check.path)
      base.path = check.path
      if (!fs.existsSync(target)) {
        base.detail = 'file not found'
        return base
      }
      const actual = contentLines(read(workspace, check.path))
      const want = Array.isArray(expected) ? expected.map((line) => String(line).trim()) : [expectedText(expected)]
      base.passed = actual.length === want.length && actual.every((line, index) => line === want[index])
      base.detail = base.passed
        ? `${actual.length} line(s) match`
        : `expected ${want.length} line(s) [${short(want.join('\n'))}] / got ${actual.length} line(s) [${short(actual.join('\n'))}]`
      return base
    }
    case 'countFiles': {
      const dir = inWorkspace(workspace, check.dir ?? '.')
      base.path = check.dir ?? '.'
      if (!fs.existsSync(dir)) {
        base.detail = `directory not found: ${check.dir ?? '.'}`
        return base
      }
      const count = countFiles(dir, { prefix: check.prefix ?? '', suffix: check.suffix ?? '', extension: check.extension ?? '' })
      const want = Number(Array.isArray(expected) ? expected.length : expected)
      base.passed = count === want
      base.detail = base.passed ? `${count} file(s) as expected` : `expected ${want} file(s) / got ${count}`
      return base
    }
    case 'contentHashes': {
      // "Renamed, never rewritten": every expected file name must exist in `dir`
      // with byte-identical content, and nothing unexpected may be there. A
      // delete-and-recreate (or truncate) rename passes `countFiles` but fails
      // here, because the hash is of the original bytes the generator wrote.
      const dir = inWorkspace(workspace, check.dir ?? '.')
      base.path = check.dir ?? '.'
      if (!fs.existsSync(dir)) {
        base.detail = `directory not found: ${check.dir ?? '.'}`
        return base
      }
      const wanted = (Array.isArray(expected) ? expected : []).map((entry) => ({ name: String(entry?.name ?? ''), sha256: String(entry?.sha256 ?? '') }))
      if (wanted.length === 0) {
        base.detail = 'contentHashes expects a non-empty fixture export of [{name, sha256}]'
        return base
      }
      const actual = new Map()
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        // The candidate's update-lock sidecars are excluded: they are the plugin's
        // bookkeeping, not a change the model made to the tree (see REPLACE_LOCK_SIDECAR).
        if (REPLACE_LOCK_SIDECAR.test(entry.name)) continue
        const digest = createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex')
        actual.set(entry.name, digest)
      }
      const problems = []
      for (const entry of wanted) {
        if (!actual.has(entry.name)) problems.push(`missing: ${entry.name}`)
        else if (actual.get(entry.name) !== entry.sha256) problems.push(`content changed: ${entry.name}`)
      }
      for (const name of actual.keys()) {
        if (!wanted.some((entry) => entry.name === name)) problems.push(`unexpected: ${name}`)
      }
      base.passed = problems.length === 0
      base.detail = base.passed
        ? `${wanted.length} file(s) byte-identical`
        : problems.length > 3
          ? `${problems.slice(0, 3).join(', ')} (+${problems.length - 3} more)`
          : problems.join(', ')
      return base
    }
    case 'command': {
      const command = check.command === 'node' ? (options.execPath ?? process.execPath) : check.command
      if (typeof command !== 'string' || command === '') {
        base.detail = 'command check without a command'
        return base
      }
      const args = Array.isArray(check.args) ? check.args.map((arg) => String(arg)) : []
      const cwd = inWorkspace(workspace, check.cwd ?? '.')
      const wantedExit = Number.isInteger(check.exitCode) ? check.exitCode : 0
      const outcome = await spawnCommand(command, args, cwd, options.commandTimeoutMs ?? 120000)
      base.passed = outcome.exitCode === wantedExit
      base.detail = base.passed
        ? `exit ${outcome.exitCode}`
        : `expected exit ${wantedExit} / got ${outcome.exitCode ?? `no exit code (${outcome.stderr || outcome.signal})`}`
      return base
    }
    default:
      base.detail = `unknown check type "${check?.type}"`
      return base
  }
}

/**
 * Resolve the expected value of a check: `expect` names a fixture export, the
 * other keys are literals.
 * @param {object} check - the check descriptor.
 * @param {Record<string, unknown>} fixtureExports - the generator's expected values.
 * @returns {unknown} the expected value.
 */
function resolveExpected(check, fixtureExports) {
  if (check.expect !== undefined) {
    if (!Object.hasOwn(fixtureExports, check.expect)) {
      throw new Error(`fixture exports have no key "${check.expect}" (known: ${Object.keys(fixtureExports).sort().join(', ')})`)
    }
    return fixtureExports[check.expect]
  }
  if (check.text !== undefined) return check.text
  if (check.lines !== undefined) return check.lines
  if (check.count !== undefined) return check.count
  return undefined
}

/**
 * The text a single-value check compares against.
 * @param {unknown} expected - the resolved expected value.
 * @returns {string} its text form.
 */
function expectedText(expected) {
  if (Array.isArray(expected)) return expected.join('\n')
  return expected === undefined ? '' : String(expected)
}

/**
 * Resolve a task-relative path inside the workspace.
 * @param {string} workspace - the workspace root.
 * @param {string} [relative] - the task-supplied path.
 * @returns {string} the absolute path.
 */
function inWorkspace(workspace, relative) {
  if (typeof relative !== 'string' || relative === '') return workspace
  if (path.isAbsolute(relative)) return relative
  return path.join(workspace, ...relative.split('/'))
}

/**
 * Read a workspace file as UTF-8 text with CRLF normalized away.
 * @param {string} workspace - the workspace root.
 * @param {string} relative - the task-relative path.
 * @returns {string} the file text.
 */
function read(workspace, relative) {
  return fs.readFileSync(inWorkspace(workspace, relative), 'utf8').replace(/\r\n/g, '\n')
}

/**
 * The comparison view of a text file: trimmed, blank lines dropped, CRLF folded.
 * @param {string} text - the file text.
 * @returns {string[]} the non-empty lines.
 */
export function contentLines(text) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/**
 * Count files under a directory (recursively) matching the name filters.
 * @param {string} dir - the directory to walk.
 * @param {{prefix?: string, suffix?: string, extension?: string}} filters - the name filters.
 * @returns {number} how many files matched.
 */
export function countFiles(dir, filters = {}) {
  const { prefix = '', suffix = '', extension = '' } = filters
  let count = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(target)
        continue
      }
      if (!entry.isFile()) continue
      if (prefix !== '' && !entry.name.startsWith(prefix)) continue
      if (suffix !== '' && !entry.name.endsWith(suffix)) continue
      if (extension !== '' && path.extname(entry.name).toLowerCase() !== extension.toLowerCase()) continue
      count += 1
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return count
}

/**
 * Spawn a command without a shell and collect its exit status.
 *
 * The child's output is deliberately **not** captured: a `command` check compares
 * exit codes and nothing else, and a confined parent (a DSH sandbox, a service
 * without a console) cannot always open the pipes a capturing spawn needs — an
 * `EPERM` there would turn a passing test into a harness failure. Letting the
 * child's stdio go to `/dev/null` keeps the verdict the same and the requirement
 * lower. A future check that wants stdout must ask for it explicitly, not by
 * making every check capture output it never reads.
 * @param {string} command - the executable.
 * @param {string[]} args - the argument array.
 * @param {string} cwd - the working directory.
 * @param {number} timeoutMs - the deadline after which the child is killed.
 * @returns {Promise<{exitCode: number|null, signal: string|null, stdout: string, stderr: string}>} the outcome.
 */
export function spawnCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, stdio: 'ignore', windowsHide: true, env: process.env })
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {}
      resolve({ exitCode: null, signal: 'timeout', stdout: '', stderr: `command timed out after ${timeoutMs} ms` })
    }, timeoutMs)
    timer.unref?.()
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: null, signal: null, stdout: '', stderr: String(error?.code ?? error?.message ?? error) })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code, signal, stdout: '', stderr: '' })
    })
  })
}

/**
 * A detail string is read by a human in a report: keep it short.
 * @param {string} text - the raw summary.
 * @returns {string} the first 200 characters.
 */
function short(text) {
  const flat = String(text).replace(/\n/g, '\\n')
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}…`
}
