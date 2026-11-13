/** Match the public subprocess base without forwarding ambient host secrets. */
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { confinedWorkerLaunch, validateWorkerLaunch } from '../lib/execution/resident/worker-launch.js'
import { assert, test, report } from './lib/harness.mjs'

await test('confined worker launch preserves exact argv/cwd and the current public scrubbed environment', async () => {
  const names = ['AWS_SECRET_ACCESS_KEY', 'DSH_SUBPROCESS_CONTROL'], before = names.map(name => process.env[name])
  try {
    for (const name of names) process.env[name] = 'fixture-not-forwarded'
    const argv = [process.execPath, 'trusted-runner', '--', '/fixed-worker'], cwd = process.cwd()
    const expected = scrubbedParentEnv(), launch = await confinedWorkerLaunch(argv, cwd)
    assert.deepEqual(launch.argv, argv); assert.notEqual(launch.argv, argv); assert.equal(launch.cwd, cwd)
    assert.deepEqual(launch.env, expected)
    for (const name of names) assert.equal(launch.env[name], undefined)
  } finally {
    names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index] })
  }
})

await test('only the actual Electron executable receives its required Node-runner environment', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron')
  Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
  try {
    const launch = await confinedWorkerLaunch([process.execPath, 'trusted-runner', '--', '/fixed-worker'], process.cwd())
    const expected = Object.fromEntries(Object.entries(scrubbedParentEnv()).filter(([key]) =>
      (process.platform === 'win32' ? key.toUpperCase() : key) !== 'ELECTRON_RUN_AS_NODE'))
    assert.deepEqual(launch.env, { ...expected, ELECTRON_RUN_AS_NODE: '1' })
    const external = await confinedWorkerLaunch(['/other-executable'], process.cwd())
    assert.deepEqual(external.env, scrubbedParentEnv())
  } finally {
    if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor)
    else delete process.versions.electron
  }
})

await test('launch validation refuses oversized or malformed facts before a transport can admit them', async () => {
  await assert.rejects(confinedWorkerLaunch([process.execPath, 'x'.repeat(65536)], process.cwd()), /oversized/)
  const launch = { argv: [process.execPath], cwd: process.cwd(), env: {} }
  for (const value of [{ ...launch, env: { PATH: '\0' } }, { ...launch, env: { 'bad=key': 'value' } },
    { ...launch, argv: ['relative'] }, { ...launch, cwd: 'relative' }]) assert.throws(() => validateWorkerLaunch(value), /Invalid/)
})
report('resident-worker-launch')
