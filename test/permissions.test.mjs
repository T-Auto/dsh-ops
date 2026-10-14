import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareWorkspace, mountWorkspacePreparation } from '../lib/workspace-preparation.js'
import { invoke as fileCall } from '../lib/file/worker.js'
import { invoke as ptcCall } from '../lib/ptc/worker.js'
import { resolveWorker } from '../lib/ptc/runtime.js'
import { mountSessionBash } from '../lib/session-shells.js'
import { resolveShells } from '../lib/shells.js'
import { createScope } from '@deepseek-ai/dsh-scope'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import FileSystem from '@deepseek-ai/dsh-fs-local'
const worker = resolveWorker()
function ps(code) {
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')], { encoding:'utf8' })
  assert.equal(result.status,0,result.stderr)
  return result.stdout.trim()
}
await test('preparation never runs in read-only or full-access', async () => {
  let calls = 0
  for (const mode of ['read-only','danger-full-access']) await prepareWorkspace({mode,workspaceRoot:'invalid'}, {platform:'win32',run(){ calls++ }})
  assert.equal(calls,0)
})
await test('preparation coalesces one trusted workspace and retries only failed preparation', async () => {
  await withTempDir('prepare-coalesce',async root => {
    let calls=0
    const policy={mode:'workspace-write',workspaceRoot:root}
    const options={platform:'win32',run(){calls++;return Promise.resolve()}}
    await Promise.all([prepareWorkspace(policy,options),prepareWorkspace(policy,options)])
    assert.equal(calls,1)
  })
})
await test('owned Modify-only workspace starts real DSH sandbox; three modes and explicit denials', async () => {
  await withTempDir('permission-matrix',async root => {
    const outside=path.join(path.dirname(root),'permission-outside-'+path.basename(root))
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside,'keep.txt'),'outside')
    fs.writeFileSync(path.join(root,'data.txt'),'before')
    // Strip broad inherited grants only on this test-owned directory. Recreate
    // the actual reported prerequisite: owner + Modify, no WRITE_OWNER.
    if(process.platform==='win32') ps(`$p='${root.replaceAll("'","''")}'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.AccessControl.DirectorySecurity]::new(); $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $p -AclObject $a`)
    const {ctx}=await bootHost()
    const agent={id:'matrix',session:{id:'matrix',mode:'workspace-write',header:{cwd:root},append(){return Promise.resolve()},read(){return []}}}
    agent.ctx=createScope(ctx,agent).ctx
    try {
      await ctx.plugin(Subprocess); await ctx.plugin(Sandbox,{})
      await ctx.plugin(FileSystem,{})
      await ctx.plugin(inner=>inner.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:({session})=>({mode:session?.mode ?? agent.session.mode,workspaceRoot:root,sessionId:session?.id ?? agent.session.id})}))
      await ctx.plugin(inner=>mountWorkspacePreparation(inner))
      // This is the outer transport gate: it must run before run_code launches,
      // not after the first nested ops call.
      await ctx.waterfall('tools/execute',{name:'run_code',agent,signal:new AbortController().signal},()=>Promise.resolve({kind:'allow'}))
      if(process.platform==='win32') {
        const rights=ps(`$a=Get-Acl -LiteralPath '${root.replaceAll("'","''")}'; $a.Access | ForEach-Object { $_.FileSystemRights.ToString() }`)
        assert.match(rights,/TakeOwnership/)
        assert.doesNotMatch(rights,/FullControl/)
      }
      const exec={agent,signal:new AbortController().signal}
      // Verify a real Node code worker can start after the outer transport hook.
      const confinedNode=await ctx.get('sandbox').confine([process.execPath,'-e','process.stdout.write("NODE_PTC_READY")'],ctx.get('sandboxPolicy').resolve({session:agent.session}),exec.signal)
      const nodeHandle=ctx.get('subprocess').spawn({argv:confinedNode.argv,cwd:root,graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:1024},stderr:{maxBytes:1024}},signal:exec.signal})
      const nodeOutcome=await nodeHandle.done
      assert.equal(nodeOutcome.exitCode,0,nodeHandle.collected.stderr.readFrom(0).text)
      assert.equal(nodeHandle.collected.stdout.readFrom(0).text,'NODE_PTC_READY')
      const read=await fileCall(ctx,worker,'inspect_local_file',{path:path.join(outside,'keep.txt')},exec,exec.signal)
      assert.equal(read.status,'completed',JSON.stringify(read))
      const replaced=await fileCall(ctx,worker,'replace',{path:'data.txt',pattern:'before',replacement:'after'},exec,exec.signal)
      assert.equal(replaced.changed,1,JSON.stringify(replaced))
      const batch=await ptcCall(ctx,worker,'batch',{root,action:'run',operations:[{op:'copy',path:'data.txt',to:'copy.txt'}]},exec,exec.signal)
      assert.equal(batch.status,'completed',JSON.stringify(batch))
      const move=await ptcCall(ctx,worker,'batch',{root,action:'run',operations:[{op:'move',path:'copy.txt',to:'moved.txt'}]},exec,exec.signal)
      assert.equal(move.status,'completed',JSON.stringify(move))
      const remove=await ptcCall(ctx,worker,'batch',{root,action:'run',operations:[{op:'remove',path:'moved.txt'}]},exec,exec.signal)
      assert.equal(remove.status,'completed',JSON.stringify(remove))
      const afterGrant=await fileCall(ctx,worker,'replace',{path:'data.txt',pattern:'after',replacement:'after-grant'},exec,exec.signal)
      assert.equal(afterGrant.changed,1,JSON.stringify(afterGrant))
      // Use a non-temp external root for the host preflight fence; no file is accessed.
      const denied=await ptcCall(ctx,worker,'batch',{root:path.parse(root).root,action:'plan',operations:[{op:'remove',path:'never-accessed'}]},exec,exec.signal)
      assert.equal(denied.error.code,'POLICY_DENIED')
      assert.match(denied.error.message,/User authorization/)
      assert.match(denied.error.nextAction,/Ask the user/)
      agent.session.mode='read-only'
      const noWrite=await fileCall(ctx,worker,'replace',{path:'data.txt',pattern:'after',replacement:'bad'},exec,exec.signal)
      assert.equal(noWrite.error.code,'POLICY_DENIED')
      const noAudit=await ptcCall(ctx,worker,'result',{root,action:'put',items:[{a:1}]},exec,exec.signal)
      assert.equal(noAudit.error.code,'POLICY_DENIED')
      const page=await ptcCall(ctx,worker,'result',{root,action:'page',id:batch.detailsRef},exec,exec.signal)
      assert.equal(page.items.length,1)
      const shells=resolveShells({allowSystemShellFallback:true})
      assert.ok(shells.bash.available,'Real bash required for permission matrix')
      await ctx.plugin({inject:['tools'],apply(inner){mountSessionBash(inner,{publishBashTool:true},shells)}})
      await ctx.serial('agent/created',{agent})
      let bash
      for(let n=0;n<50;n++) { bash=ctx.get('tools').get('ops_bash',agent);if(bash)break;await new Promise(r=>setTimeout(r,10)) }
      assert.ok(bash)
      let result=await bash.execute({command:"printf 'READ_OK'",workdir:root,timeoutMs:10000},exec)
      if (process.platform==='win32' && result.error?.startsWith('EXECUTOR_UNAVAILABLE')) {
        assert.match(result.error,/not a user authorization denial/)
        throw new Error('Windows confined Bash regression: initialization failed; do not bypass the DSH sandbox.')
      } else {
        assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(result.stdout.text,'READ_OK')
        result=await bash.execute({command:"printf bad > denied.txt",workdir:root,timeoutMs:10000},exec)
        assert.notEqual(result.exitCode,0); assert.ok(!fs.existsSync(path.join(root,'denied.txt')))
        assert.equal(result.permission?.code,'POLICY_DENIED',JSON.stringify(result))
        agent.session.mode='workspace-write'
        result=await bash.execute({command:"printf forbidden > outside.txt",workdir:outside,timeoutMs:10000},exec)
        assert.notEqual(result.exitCode,0,JSON.stringify(result))
        assert.equal(result.permission?.code,'POLICY_DENIED',JSON.stringify(result))
        assert.ok(!fs.existsSync(path.join(outside,'outside.txt')))
        result=await bash.execute({command:"printf allowed > allowed.txt",workdir:root,timeoutMs:10000},exec)
        assert.equal(result.exitCode,0,JSON.stringify(result));assert.equal(fs.readFileSync(path.join(root,'allowed.txt'),'utf8'),'allowed')
      }
      await ctx.plugin(NodePtc,{})
      await agent.ctx.plugin({inject:['tools'],apply(inner){inner.tools.presentAs('ptc')}})
      agent.session.mode='workspace-write'
      fs.writeFileSync(path.join(root,'probe.sh'),"printf 'SCRIPT_OK'\n")
      const request = {name:'run_code',callId:'ptc-bash-acceptance',agent,signal:exec.signal,arguments:{description:'Test confined Bash via pure PTC SDK',code:`
        const command = await tools.ops_bash({command:"printf 'PTC_OK'",workdir:${JSON.stringify(root)},timeoutMs:10000});
        const script = await tools.ops_bash({script_path:${JSON.stringify(path.join(root,'probe.sh'))},workdir:${JSON.stringify(root)},timeoutMs:10000});
        const pipeline = await tools.ops_bash({command:"printf 'PIPE_OK' | cat",workdir:${JSON.stringify(root)},timeoutMs:10000});
        const denied = await tools.ops_bash({command:"printf blocked > ptc-outside.txt",workdir:${JSON.stringify(outside)},timeoutMs:10000});
        return {command,script,pipeline,denied};
      `}}
      const ptc=await ctx.get('tools').execute(request)
      assert.notEqual(ptc.isError,true,JSON.stringify(ptc))
      const ptcText=ptc.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')
      const completion=ptc.value.result
      for(const [name,marker] of [['command','PTC_OK'],['script','SCRIPT_OK'],['pipeline','PIPE_OK']]) {
        assert.equal(completion[name].exitCode,0,JSON.stringify(completion[name]))
        assert.equal(completion[name].stdout.text,marker)
        assert.equal(completion[name].sandbox.mode,'workspace-write')
      }
      assert.match(ptcText,/PTC_OK/);assert.match(ptcText,/SCRIPT_OK/);assert.match(ptcText,/PIPE_OK/)
      assert.equal(completion.denied.permission.code,'POLICY_DENIED')
      assert.ok(!fs.existsSync(path.join(outside,'ptc-outside.txt')))
      assert.doesNotMatch(ptcText,/3221225794|EXECUTOR_UNAVAILABLE|fatal error/)
      agent.session.mode='read-only'
      const downgrade=await ctx.get('tools').execute({...request,callId:'ptc-bash-downgrade',arguments:{description:'Verify PTC permission downgrade',code:`return await tools.ops_bash({command:"printf blocked > ptc-readonly.txt",workdir:${JSON.stringify(root)},timeoutMs:10000});`}})
      assert.notEqual(downgrade.isError,true,JSON.stringify(downgrade))
      assert.equal(downgrade.value.result.permission.code,'POLICY_DENIED')
      assert.ok(!fs.existsSync(path.join(root,'ptc-readonly.txt')))
      agent.session.mode='danger-full-access'
      result=await bash.execute({command:"printf 'FULL_OK'",workdir:outside,timeoutMs:10000},exec)
      assert.equal(result.exitCode,0); assert.equal(result.sandbox.mode,'danger-full-access')
      const full=await ptcCall(ctx,worker,'batch',{root:outside,action:'run',operations:[{op:'copy',path:'keep.txt',to:'full-copy.txt'}]},exec,exec.signal)
      assert.equal(full.status,'completed',JSON.stringify(full))
      assert.equal(fs.readFileSync(path.join(root,'data.txt'),'utf8'),'after-grant')
    } finally { await shutdown(ctx); fs.rmSync(outside,{recursive:true,force:true}) }
  })
})
report('permissions')
