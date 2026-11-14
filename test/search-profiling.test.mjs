/** Diagnostic clocks never change the canonical operation or disclose source data. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker, request } from './lib/boundary.mjs'
requireWorker('search-profiling')
await test('opt-in search stage timing preserves canonical results and contains no paths or source text', async () => {
  await withTempDir('search-profile',async root=>{
    for(let i=0;i<8;i++) fs.writeFileSync(path.join(root,`file${i}.ts`),'export const privateFixtureText = 1;\n')
    const execute=(tool,args,enabled)=>{
      const output=spawnSync(WORKER,[],{input:JSON.stringify(request(tool,{path:root,...args},{root,readOnly:true})),
        encoding:'utf8',timeout:10000,env:{...process.env,DSH_OPS_PROFILE_SEARCH:enabled?'1':''}})
      assert.equal(output.status,0,output.stderr); assert.ifError(output.error)
      return {value:JSON.parse(output.stdout),stderr:output.stderr}
    }
    for(const [tool,args] of [['grep',{pattern:'^export',glob:['**/*.ts','!**/*.test.ts']}],
      ['grep',{pattern:'^export',glob:['**/*.ts'],limit:2,exactTotal:false}],['glob',{pattern:['**/*.ts']}]] ) {
      const plain=execute(tool,args,false),profiled=execute(tool,args,true)
      assert.equal(plain.stderr,''); assert.deepEqual(profiled.value,plain.value)
      const profile=JSON.parse(profiled.stderr.trim().slice('dsh-ops-search-profile '.length))
      assert.equal(profile.version,1); assert.equal(profile.stages.walkTotal.calls,1)
      assert.equal(profile.stages.globCompile?.calls,1, 'patterns compile once per scan, not once per file')
      assert.ok(profile.stages.globFilter.calls>0)
      assert.equal(profile.stages.relativeMetadata.calls, profile.stages.globFilter.calls,
        'one relative metadata query per visited regular file in this flat fixture')
      assert.equal(profile.stages.absoluteMetadata, undefined,
        'the relative no-follow snapshot must not trigger a second absolute metadata query')
      assert.equal(profiled.stderr.includes(root),false); assert.equal(profiled.stderr.includes('privateFixtureText'),false)
      for(const stage of Object.values(profile.stages)) {
        assert.ok(Number.isSafeInteger(stage.calls)&&stage.calls>0)
        assert.ok(Number.isSafeInteger(stage.nanos)&&stage.nanos>=0)
      }
    }
  })
})
await test('relative metadata still excludes directory links and Windows junctions', async () => {
  await withTempDir('search-relative-links', async root => {
    const workspace = path.join(root, 'workspace'), outside = path.join(root, 'outside')
    fs.mkdirSync(workspace); fs.mkdirSync(outside)
    fs.writeFileSync(path.join(workspace, 'visible.txt'), 'hit visible\n')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'hit outside-must-not-be-read\n')
    fs.symlinkSync(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const output = spawnSync(WORKER, [], {
      input: JSON.stringify(request('grep', { path: workspace, pattern: 'hit', limit: 20 }, { root: workspace, readOnly: true })),
      encoding: 'utf8', timeout: 10000, env: { ...process.env, DSH_OPS_PROFILE_SEARCH: '1' },
    })
    assert.ifError(output.error); assert.equal(output.status, 0, output.stderr)
    const value = JSON.parse(output.stdout)
    assert.equal(value.scanComplete, true, JSON.stringify(value))
    assert.equal(value.matchedTotal, 1)
    assert.equal(value.skipReasons.symlink, 1)
    assert.equal(value.items.length, 1)
    assert.equal(path.basename(value.items[0].path), 'visible.txt')
    assert.equal(output.stdout.includes('outside-must-not-be-read'), false)
  })
})
report('search-profiling')
