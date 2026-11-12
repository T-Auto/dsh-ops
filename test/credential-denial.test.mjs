import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, ownWindowsFixture, withTempDir } from './lib/harness.mjs'
import { requireWorker } from './lib/boundary.mjs'
import { bootLoop } from './lib/agent-loop.mjs'
import { credentialRefusal, credentialPath, DENY_ENV } from '../lib/credential-policy.js'
import { publicToolName } from '../lib/policy.js'
requireWorker('credential-denial')
function privateRefusal(value, forbidden) {
  assert.equal(value.status, 'rejected', JSON.stringify(value))
  assert.equal(value.error.code, 'CREDENTIAL_DENIED')
  assert.equal(value.error.effectState, 'none')
  assert.match(value.error.nextAction, /Do not retry or bypass/)
  for (const item of forbidden) assert.equal(JSON.stringify(value).includes(JSON.stringify(item).slice(1, -1)), false, 'denial must not disclose paths, rules or contents')
}
await test('credential refusal omits both a resolved path and a configured absolute matching rule', () => {
  const root = path.resolve('private-parent', 'configured-secret-root'), target = path.join(root, 'token.json')
  const refusal = credentialRefusal(target, root)
  assert.match(refusal.message, /neither read nor write/)
  assert.equal(JSON.stringify(refusal).includes(JSON.stringify(root).slice(1, -1)), false)
  assert.equal(JSON.stringify(refusal).includes('token.json'), false)
})
for (const ptcMode of [false, true]) await test(`real ${ptcMode ? 'PTC' : 'Native'} denials preserve authority without disclosing external credential paths`, () => withTempDir('credential-private', async temporary => {
  const root = path.join(temporary, 'workspace'), outside = path.join(temporary, 'private-store'), target = path.join(outside, 'config')
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.writeFileSync(target, 'PRIVATE_FIXTURE_SECRET')
  // An elevated hosted runner creates subdirectories with Administrators as owner even though the
  // process user is the runner account. The Windows workspace preparation only accepts a
  // user-owned root, so give this fixture root the process user's ownership like the temp root.
  ownWindowsFixture(root)
  const previous = process.env[DENY_ENV]
  process.env[DENY_ENV] = [previous, outside].filter(Boolean).join(path.delimiter)
  let host
  try {
    assert.equal(credentialPath(target).denied, true)
    host = await bootLoop(root, { ptcMode, discoveryConfig: { alwaysLoaded: ['write_file', ptcMode ? 'result' : 'read_files'] } })
    const forbidden = [temporary, path.dirname(temporary), outside, target, 'PRIVATE_FIXTURE_SECRET']
    const scripts = ptcMode ? [[{ name: 'run_code', args: { description: 'Verify private credential denials', code:
      `return { read: await tools.${publicToolName('inspect_local_file')}({path:${JSON.stringify(target)}}), store: await tools.${publicToolName('result')}({action:'put',root:${JSON.stringify(outside)},items:[{text:'MUST_NOT_WRITE'}]}) };` } }], []]
      : [[{ name: publicToolName('read_files'), args: { files: [{ path: target }] } },
        { name: publicToolName('write_file'), args: { path: target, content: 'MUST_NOT_WRITE', expectedRevision: 'absent' } }], []]
    const run = await host.run(await host.agent(), scripts)
    if (ptcMode) {
      const result = run.results.find(item => item.exec.name === 'run_code').result
      assert.equal(result.isError, false, JSON.stringify(result))
      privateRefusal(result.value.result.read, forbidden); privateRefusal(result.value.result.store, forbidden)
    } else {
      assert.equal(run.results.length, 2)
      for (const { result } of run.results) {
        assert.equal(result.isError, false); privateRefusal(result.value, forbidden)
        const text = result.content.map(block => block.text ?? '').join('\n')
        for (const item of forbidden) assert.equal(text.includes(item), false)
      }
    }
    assert.equal(fs.readFileSync(target, 'utf8'), 'PRIVATE_FIXTURE_SECRET')
    assert.deepEqual(fs.readdirSync(outside), ['config'], 'denials create no store or business files')
  } finally {
    await host?.close()
    if (previous === undefined) delete process.env[DENY_ENV]
    else process.env[DENY_ENV] = previous
  }
}))
report('credential-denial')
