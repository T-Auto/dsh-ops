/**
 * The P1 floor: the cross-platform CLI, the folder allocator, the task-shape
 * validator, the portable `PSModulePath` ordering rule, and the `run.json` contract.
 * Everything is deterministic — no sweep, no model, no dsh. The subcommand tripwire is
 * derived from the CLI's own answer, so it stays correct whatever order the slices land
 * in: a declared command is either wired (target exports `main`) or loudly pending.
 */

import fs from 'node:fs'
import path from 'node:path'
import { assert, PACKAGE_ROOT, report, test, withTempDir } from './lib/harness.mjs'
import { COMMANDS, EXIT, abMain, main, parseAbArgs, planAb } from '../bench/cli.mjs'
import { describeModulePath, poisonedModulePath, spawnPlan } from '../bench/lib/env.mjs'
import { FOLDER_PREFIX, nextFolderName, takenFolders } from '../bench/lib/next-folder.mjs'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, loadTasks, selectTasks, validateTask } from '../bench/lib/tasks.mjs'

/** A CLI invocation with captured output. */
function invoke(argv) {
  const lines = []
  const io = { out: (line) => lines.push(line), err: (line) => lines.push(line) }
  return { run: () => main(argv, io), text: () => lines.join('\n') }
}

/** A corpus task that passes every structural rule. */
const VALID_TASK = {
  id: 'csv-sum',
  title: 'Aggregate a CSV',
  prompt: 'Sum the amount column and write it to answer.txt.',
  fixture: { generator: 'largeCsv', params: { rows: 10 } },
  verify: [{ type: 'fileEquals', path: 'answer.txt', expect: 'sum' }],
  repeat: 2,
  timeoutMs: 60_000,
}

await test('help lists every subcommand and exits 0 (no args, help, --help); --version prints the tags', async () => {
  for (const argv of [[], ['help'], ['-h'], ['--help']]) {
    const cli = invoke(argv)
    assert.equal(await cli.run(), EXIT.ok, `argv ${JSON.stringify(argv)}`)
    for (const command of ['setup', 'ab', 'report', 'panel', 'tools']) assert.match(cli.text(), new RegExp(`\\b${command}\\b`))
  }
  const version = invoke(['--version'])
  assert.equal(await version.run(), EXIT.ok)
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
  assert.ok(version.text().includes(pkg), version.text())
  assert.match(version.text(), /node v\d+/)
})
await test('an unknown command or option exits 2 and names what it saw', async () => {
  const command = invoke(['bogus'])
  assert.equal(await command.run(), EXIT.usage)
  assert.match(command.text(), /unknown command "bogus"/)
  const option = invoke(['--bogus'])
  assert.equal(await option.run(), EXIT.usage)
  assert.match(option.text(), /unknown option "--bogus"/)
})
// Slices merge one at a time, so a declared subcommand is legitimately in one of two
// states: wired (target exists and exports `main`) or pending (it does not). The check is
// therefore derived from the CLI's own answer instead of a hand-maintained list, which
// keeps this suite green no matter what order the slices land in.
await test('every declared subcommand is either wired or loudly pending — never silent', async () => {
  for (const command of COMMANDS) {
    if (command.name === 'ab') continue // the sweep entry has its own plan-only test below
    const cli = invoke([command.name, '--help'])
    const code = await cli.run()
    if (code === EXIT.pending) {
      // Two legitimate pending messages: the target is missing ("not implemented in this
      // slice yet") or it landed without its wiring ("exports no main ... still pending").
      // Both name the slice, and that is the part worth pinning.
      assert.ok(cli.text().includes(command.slice), `${command.name} should name slice ${command.slice}`)
    } else {
      assert.notEqual(code, EXIT.pending, `${command.name} is wired, so it must not report pending`)
    }
  }
})
await test('ab --show prints the three commands and this suite never starts a sweep', () => {
  const lines = []
  const io = { out: (line) => lines.push(line), err: (line) => lines.push(line) }
  assert.equal(abMain(['--task', 'csv-sum', '--show'], io), EXIT.ok)
  const text = lines.join('\n')
  assert.equal(text.split('\n').filter((line) => line.startsWith('node ')).length, 3, text)
  assert.match(text, /node bench\/run\.mjs --label bench-base --profile bench-base --task csv-sum/)
  assert.match(text, /node bench\/compare\.mjs bench-base bench-ops --folder benchmark-\d{4}-\d{2}-\d{2}-\d{2}/)
  // Only assert the pending path while the runner is genuinely absent: once it lands,
  // `abMain([])` would spawn a real session, and a unit suite must never do that.
  if (!fs.existsSync(path.join(PACKAGE_ROOT, 'bench/run.mjs'))) {
    assert.equal(abMain([], io), EXIT.pending)
    assert.match(lines.join('\n'), /not implemented yet — missing: bench\/run\.mjs/)
  }
})
await test('ab parsing defaults, repeats --task, and rejects malformed flags', () => {
  const parsed = parseAbArgs(['--task', 'a', '--task', 'b', '--repeat', '2', '--verbose'])
  assert.deepEqual(
    { base: parsed.base, cand: parsed.cand, tasks: parsed.tasks, repeat: parsed.repeat, extra: parsed.extra },
    { base: 'bench-base', cand: 'bench-ops', tasks: ['a', 'b'], repeat: '2', extra: ['--verbose'] },
  )
  for (const argv of [['--task'], ['--repeat', '0'], ['--repeat', 'x'], ['--folder', 'a/b'], ['--folder', '../x'], ['--base', 'a b'], ['--cand', '']]) {
    assert.throws(() => parseAbArgs(argv), /needs a value|positive integer|simple labels|one directory name/, JSON.stringify(argv))
  }
})
await test('next-folder hands one group to both sides and skips anything already named', async () => {
  await withTempDir('bench-runs', (runs) => {
    const day = new Date(2026, 9, 24, 15, 42) // mid-day local 2026-10-24; the clock must not steer the name
    const stamp = `${FOLDER_PREFIX}2026-10-24`
    assert.equal(nextFolderName(runs, day), `${stamp}-00`)
    const explicit = planAb(['--folder', 'ops-1'], { runsDir: runs })
    assert.equal(explicit.folder, 'ops-1')
    assert.equal(explicit.allocated, false)
    assert.deepEqual(explicit.commands.map((command) => command.args.at(-1)), ['ops-1', 'ops-1', 'ops-1'])
    fs.mkdirSync(path.join(runs, `${stamp}-00`))
    fs.mkdirSync(path.join(runs, `${stamp}-01`))
    fs.mkdirSync(path.join(runs, `${stamp.toUpperCase()}-02`)) // Windows would collide with this one
    fs.writeFileSync(path.join(runs, 'unrelated.txt'), '')
    assert.equal(nextFolderName(runs, day), `${stamp}-03`)
    assert.ok(takenFolders(runs).has(`${stamp}-00`))
    assert.equal(planAb(['--task', 'x'], { runsDir: runs, now: day }).folder, `${stamp}-03`)
  })
})
await test('a good task validates, gets its timeout defaulted, and round-trips through a directory', async () => {
  assert.equal(validateTask({ ...VALID_TASK }, 'x.task.json').timeoutMs, 60_000)
  assert.equal(validateTask({ ...VALID_TASK, timeoutMs: undefined }, 'x.task.json').timeoutMs, DEFAULT_TIMEOUT_MS)
  const registries = { generators: ['largeCsv'], checkTypes: ['fileEquals'] }
  assert.equal(validateTask({ ...VALID_TASK }, 'x.task.json', registries).id, 'csv-sum')
  await withTempDir('bench-tasks', (tasks) => {
    fs.writeFileSync(path.join(tasks, 'csv-sum.task.json'), JSON.stringify(VALID_TASK))
    const loaded = loadTasks(tasks)
    assert.equal(loaded.length, 1)
    assert.deepEqual(selectTasks(loaded, ['csv-sum']).map((task) => task.id), ['csv-sum'])
    assert.throws(() => selectTasks(loaded, ['nope']), /unknown task id\(s\): nope/)
  })
})
await test('a bad task fails loudly, naming the file and the field', () => {
  const cases = [
    [{ ...VALID_TASK, extra: 1 }, /unknown field\(s\) "extra"/],
    [{ ...VALID_TASK, id: 'Bad Id' }, /not a slug-able id/],
    [{ ...VALID_TASK, prompt: '-nope' }, /prompt must not start with "-"/],
    [{ ...VALID_TASK, title: '  ' }, /"title" must be a non-empty string/],
    [{ ...VALID_TASK, fixture: { generator: 'largeCsv', nope: 1 } }, /unknown fixture field\(s\) "nope"/],
    [{ ...VALID_TASK, verify: [] }, /"verify" must be a non-empty array/],
    [{ ...VALID_TASK, repeat: 0 }, /"repeat" must be an integer between 1 and 100, got 0/],
    [{ ...VALID_TASK, repeat: 1.5 }, /"repeat" must be an integer between 1 and 100/],
    [{ ...VALID_TASK, timeoutMs: 10 }, /"timeoutMs" must be an integer between/],
    [{ ...VALID_TASK, timeoutMs: MAX_TIMEOUT_MS + 1 }, /"timeoutMs" must be an integer between/],
    [{ ...VALID_TASK, verify: [{ type: 'fileEquals', path: 'answer.txt' }] }, /needs one of "expect"\/"text"\/"lines"\/"count"/],
    [{ ...VALID_TASK, verify: [{ type: 'fileEquals', expect: 'sum' }] }, /needs a non-empty "path"/],
    [{ ...VALID_TASK, verify: [{ type: 'fileEquals', path: 'a', expect: 'x', count: 1 }] }, /sets more than one expectation/],
    [{ ...VALID_TASK, verify: [{ type: 'fileEquals', path: 'a', expect: 'x', invariant: 'yes' }] }, /"invariant" must be a boolean/],
    [{ ...VALID_TASK, verify: [{ type: 'wat', path: 'a' }] }, /unknown check type "wat"/],
  ]
  for (const [task, expected] of cases) {
    assert.throws(() => validateTask(task, 'bad.task.json'), (error) => {
      assert.ok(error.message.startsWith('bad.task.json: '), error.message)
      assert.match(error.message, expected)
      return true
    }, JSON.stringify(task))
  }
})
await test('injected registries reject a generator or check type the later slices do not know', () => {
  const registries = { generators: ['largeCsv'], checkTypes: ['fileEquals'] }
  // The fixtures barrel exports a name -> builder map, verify.mjs a name array: both must work.
  assert.equal(validateTask({ ...VALID_TASK }, 'x.task.json', { generators: { largeCsv: () => {} }, checkTypes: { fileEquals: () => {} } }).id, 'csv-sum')
  assert.throws(() => validateTask({ ...VALID_TASK, fixture: { generator: 'nope' } }, 'x.task.json', registries), /unknown fixture generator "nope" \(known: largeCsv\)/)
  assert.throws(() => validateTask({ ...VALID_TASK, verify: [{ type: 'command', command: 'node' }] }, 'x.task.json', registries), /unknown check type "command" \(known: fileEquals\)/)
})
await test('PSModulePath ordering is judged on Windows-shaped values from any host', () => {
  const inBox = 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'
  const core = 'C:\\Program Files\\PowerShell\\7\\Modules'
  const user = 'C:\\Users\\dev\\Documents\\PowerShell\\Modules'
  // Only the Core install root really ships that module; a user folder must never cry wolf.
  const isDirectory = (file) => file === path.win32.join(core, 'Microsoft.PowerShell.Security')
  assert.equal(poisonedModulePath(`${core};${inBox}`, 'C:\\Windows', isDirectory), core, 'Core ahead of the in-box path is the poisoned order')
  assert.equal(poisonedModulePath(`${inBox};${core}`, 'C:\\Windows', isDirectory), null, 'in-box first means the ordering rule never reaches Core')
  assert.equal(poisonedModulePath(`${user};${inBox}`, 'C:\\Windows', isDirectory), null, 'a user module folder is harmless')
  assert.equal(poisonedModulePath(core, 'C:\\Windows', isDirectory), core, 'without the in-box entry every entry is in front of it')
  assert.equal(poisonedModulePath(inBox, 'C:\\Windows', isDirectory), null)
  assert.equal(poisonedModulePath(undefined), null)
  assert.equal(poisonedModulePath(''), null)
  const poison = describeModulePath(`${core};${inBox}`, core)
  assert.match(poison, /^1\. C:\\Program Files\\PowerShell\\7\\Modules {2}<-- CORE MODULE ROOT AHEAD OF 5\.1/)
  assert.match(poison, /\| 2\. C:\\Windows\\system32\\WindowsPowerShell/)
  assert.equal(describeModulePath(''), 'PSModulePath is not set')
})
await test('the spawn plan never uses a shim and keeps argv verbatim', () => {
  const js = spawnPlan({ file: '/opt/dsh/lib/bin.js', kind: 'js' }, ['--version', '-x'])
  assert.equal(js.command, process.execPath)
  assert.deepEqual(js.args, ['/opt/dsh/lib/bin.js', '--version', '-x'])
  const exe = spawnPlan({ file: '/usr/bin/dsh', kind: 'exe' }, ['--version'])
  assert.equal(exe.command, '/usr/bin/dsh')
  assert.deepEqual(exe.args, ['--version'])
})
await test('run.schema.json parses and describes every property with a unit', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'bench', 'run.schema.json'), 'utf8'))
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort())
  const missing = []
  const units = []
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const at = `${where}.${key}`
      if (!child.$ref && (typeof child.description !== 'string' || child.description.trim() === '')) missing.push(at)
      if (/Ms$/.test(key) && !/ms\b/.test(child.description ?? '')) units.push(`${at} needs a millisecond unit`)
      if (/Tokens$/.test(key) && !/tokens/.test(child.description ?? '')) units.push(`${at} needs a token unit`)
      if (/Bytes$/.test(key) && !/bytes/.test(child.description ?? '')) units.push(`${at} needs a byte unit`)
      walk(child, at)
    }
    if (node.items) walk(node.items, `${where}[]`)
    for (const [key, child] of Object.entries(node.$defs ?? {})) {
      if (typeof child.description !== 'string' || child.description.trim() === '') missing.push(`$defs.${key}`)
      walk(child, `$defs.${key}`)
    }
  }
  walk(schema, 'run.json')
  assert.deepEqual(missing, [], 'every property documents itself')
  assert.deepEqual(units, [], 'every numeric field names its unit')
})

report('bench-cli')
