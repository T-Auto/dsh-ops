import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'
import { prepareWorkspace, mountWorkspacePreparation, runPreparation, preparationEnvironment, preparationSpawnSpec } from '../lib/workspace-preparation.js'
import { invoke as fileCall } from '../lib/file/worker.js'
import { invoke as ptcCall } from '../lib/ptc/worker.js'
import { resolveWorker } from '../lib/ptc/runtime.js'
import { mountSessionBash } from '../lib/session-shells.js'
import { resolveShells } from '../lib/shells.js'
import { createScope } from '@deepseek-ai/dsh-scope'
import NodePtc from '@deepseek-ai/dsh-ptc-runtime-node'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import * as ObservationPolicy from '@deepseek-ai/dsh-fs-observation-policy'
const worker = resolveWorker()
function ps(code) {
  // The interpreter here is the inbox 5.1 one, and a pwsh 7 host publishes its own module directories
  // into the **process-level** `PSModulePath`; 5.1 then resolves `Microsoft.PowerShell.Security` to
  // the pwsh 7 copy, fails to load it, and loses `Get-Acl`/`Set-Acl`. Hand this helper the same
  // scrubbed environment the preparation script gets, so it drives 5.1 the way production does.
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')], { encoding:'utf8', env: preparationEnvironment() })
  assert.equal(result.status,0,result.stderr)
  return result.stdout.trim()
}
await test('the real worker behaves as the file-tool descriptions say (#44)', async () => {
  await withTempDir('file-contract',async root => {
    fs.mkdirSync(path.join(root,'sub'),{recursive:true}); fs.mkdirSync(path.join(root,'vendor'),{recursive:true})
    fs.writeFileSync(path.join(root,'top.md'),'needle\n'); fs.writeFileSync(path.join(root,'sub','nested.md'),'needle\n')
    fs.writeFileSync(path.join(root,'vendor','v.md'),'needle\n'); fs.writeFileSync(path.join(root,'a.txt'),'a.b axb\n')
    const {ctx}=await bootHost()
    const agent={id:'contract',session:{id:'contract',header:{cwd:root}}}
    const exec={agent,signal:new AbortController().signal}
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(inner=>inner.provide('sandboxPolicy',{defaultMode:'danger-full-access',resolve:()=>({mode:'danger-full-access',workspaceRoot:root})}))
      const call=(tool,args)=>fileCall(ctx,worker,tool,args,exec,exec.signal)
      const names=value=>value.items.map(item=>path.relative(root,typeof item==='string'?item:item.path).replaceAll('\\','/')).sort()
      // Wrong shapes resolve as structured errors; nothing is thrown.
      const bare=await call('glob',{pattern:'*.md'})
      assert.equal(bare.status,'error',JSON.stringify(bare)); assert.equal(typeof bare.error.code,'string')
      const include=await call('grep',{pattern:'needle',include:'*.md'})
      assert.equal(include.status,'error',JSON.stringify(include)); assert.match(include.error.message,/include/)
      // "*.md" is top level only; "**/*.md" with "!" exclusions reaches nested files.
      assert.deepEqual(names(await call('glob',{pattern:['*.md']})),['top.md'])
      assert.deepEqual(names(await call('glob',{pattern:['**/*.md','!vendor/**']})),['sub/nested.md','top.md'])
      const negativeOnly=await call('glob',{pattern:['!vendor/**']})
      assert.equal(negativeOnly.status,'error',JSON.stringify(negativeOnly))
      // The grep/replace glob filter accepts exclude-only lists: everything except.
      const grep=await call('grep',{pattern:'needle',glob:['!vendor/**'],outputMode:'files_with_matches'})
      assert.deepEqual(names(grep),['sub/nested.md','top.md'])
      // replace matches literal text: "a.b" does not match "axb".
      const replaced=await call('replace',{path:'a.txt',pattern:'a.b',replacement:'Z'})
      assert.equal(replaced.changed,1,JSON.stringify(replaced))
      assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'Z axb\n')
    } finally { await shutdown(ctx) }
  })
})
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
await test('preparation failures always say why, including a timeout (#43)', async () => {
  const node=code=>({executable:process.execPath,args:['-e',code]})
  const failure=async options=>{ try { await runPreparation('C:\\ws',options); return '' } catch(error) { return error.message } }
  const timeout=await failure({...node('setTimeout(()=>{},60000)'),timeoutMs:200})
  assert.match(timeout,/timed out after 200 ms preparing C:\\ws; the workspace ACL state is unknown/)
  assert.match(timeout,/acl-backups/)
  assert.notEqual(timeout.split('): ')[1]?.trim() ?? '','')
  assert.match(await failure(node('process.exit(3)')),/exited with code 3 after \d+ ms preparing C:\\ws: \(no output\)$/)
  assert.match(await failure(node('process.stderr.write("Get-Acl failed\\n");process.exit(1)')),/exited with code 1 .*: Get-Acl failed$/)
  assert.match(await failure(node('process.stdout.write("half done");process.exit(1)')),/: half done$/)
  assert.match(await failure({executable:path.join(process.cwd(),'missing-powershell.exe'),args:[]}),/could not start .*missing-powershell\.exe/)
  await runPreparation('C:\\ws',node('process.stdout.write("prepared")'))
})
await test('real preparation writes only the root DACL, never descendants (#43)', async () => {
  if(process.platform!=='win32')return
  await withTempDir('prepare-root-only',async root => {
    for(let d=0;d<10;d++) { const dir=path.join(root,`d${d}`,'deep'); fs.mkdirSync(dir,{recursive:true}); for(let f=0;f<30;f++) fs.writeFileSync(path.join(dir,`f${f}.txt`),'x') }
    const quoted=root.replaceAll("'","''")
    ps(`$p='${quoted}'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.AccessControl.DirectorySecurity]::new(); $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $p -AclObject $a`)
    const sddl=target=>ps(`(Get-Acl -LiteralPath '${target.replaceAll("'","''")}').GetSecurityDescriptorSddlForm('Access')`)
    const deep=path.join(root,'d9','deep','f29.txt'), deepDir=path.join(root,'d9','deep')
    const before={root:sddl(root),deep:sddl(deep),deepDir:sddl(deepDir)}
    const backups=path.join(process.env.DSH_HOME,'dsh-ops','acl-backups')
    const receipts=()=>fs.existsSync(backups) ? fs.readdirSync(backups).length : 0
    const initial=receipts()
    await runPreparation(root)
    const after=sddl(root)
    assert.ok(after.startsWith(before.root.slice(0,before.root.indexOf('('))),`DACL control flags kept: ${before.root} -> ${after}`)
    assert.ok(after.startsWith(before.root),`existing ACEs kept in order: ${after}`)
    const rights=ps(`(Get-Acl -LiteralPath '${quoted}').Access | ForEach-Object { $_.FileSystemRights.ToString() }`)
    assert.match(rights,/TakeOwnership/)
    assert.doesNotMatch(rights,/FullControl/)
    assert.equal(sddl(deep),before.deep,'a deep file keeps its exact ACL')
    assert.equal(sddl(deepDir),before.deepDir,'a deep directory keeps its exact ACL')
    assert.equal(receipts(),initial+1,'one backup receipt per cold preparation')
    await runPreparation(root)
    assert.equal(receipts(),initial+1,'the warm path writes no new receipt')
  })
})
await test('an inheriting (AI) workspace root keeps its inheritance and descendants (#43)', async () => {
  // The expensive real-world shape: a root with no explicit ACEs that inherits from its parent.
  if(process.platform!=='win32')return
  await withTempDir('prepare-inherited',async parent => {
    ps(`$p='${parent.replaceAll("'","''")}'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=[Security.AccessControl.DirectorySecurity]::new(); $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath $p -AclObject $a`)
    const ws=path.join(parent,'ws')
    fs.mkdirSync(ws)
    const quoted=ws.replaceAll("'","''")
    // Owner-only write: the script refuses roots the user does not own, and this leaves the DACL untouched.
    const sid=ps(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $o=[Security.AccessControl.DirectorySecurity]::new(); $o.SetOwner($sid); [IO.Directory]::SetAccessControl('${quoted}',$o); $sid.Value`)
    for(let d=0;d<10;d++) { const dir=path.join(ws,`d${d}`,'deep'); fs.mkdirSync(dir,{recursive:true}); for(let f=0;f<30;f++) fs.writeFileSync(path.join(dir,`f${f}.txt`),'x') }
    const sddl=target=>ps(`(Get-Acl -LiteralPath '${target.replaceAll("'","''")}').GetSecurityDescriptorSddlForm('Access')`)
    const aces=text=>text.match(/\([^)]*\)/g) ?? []
    const deep=path.join(ws,'d9','deep','f29.txt'), deepDir=path.join(ws,'d9','deep')
    const before={root:sddl(ws),deep:sddl(deep),deepDir:sddl(deepDir)}
    assert.ok(before.root.startsWith('D:AI('),`fixture root must be auto-inherited, not protected: ${before.root}`)
    assert.ok(aces(before.root).length>0 && aces(before.root).every(ace=>ace.split(';')[1].includes('ID')),`fixture root must carry only inherited ACEs: ${before.root}`)
    const backups=path.join(process.env.DSH_HOME,'dsh-ops','acl-backups')
    const receipts=()=>fs.existsSync(backups) ? fs.readdirSync(backups).length : 0
    const initial=receipts()
    await runPreparation(ws)
    const after=sddl(ws)
    assert.ok(after.startsWith('D:AI('),`auto-inherited flag kept: ${before.root} -> ${after}`)
    for(const ace of aces(before.root)) assert.ok(aces(after).includes(ace),`inherited ACE kept: ${ace} in ${after}`)
    const added=aces(after).filter(ace=>!aces(before.root).includes(ace))
    assert.equal(added.length,1,`exactly one ACE added: ${after}`)
    const [type,flags,mask,,,trustee]=added[0].slice(1,-1).split(';')
    assert.equal(type,'A'); assert.equal(flags,'','the added ACE applies to the root directory only')
    assert.equal(trustee,sid)
    assert.ok((Number.parseInt(mask,16) & 0x80000)!==0,`the added ACE grants WRITE_OWNER: ${added[0]}`)
    const rights=ps(`(Get-Acl -LiteralPath '${quoted}').Access | ForEach-Object { $_.FileSystemRights.ToString() }`)
    assert.doesNotMatch(rights,/FullControl/)
    assert.equal(sddl(deep),before.deep,'a deep file keeps its exact ACL')
    assert.equal(sddl(deepDir),before.deepDir,'a deep directory keeps its exact ACL')
    assert.equal(receipts(),initial+1,'one backup receipt per cold preparation')
    await runPreparation(ws)
    assert.equal(receipts(),initial+1,'the warm path writes no new receipt')
  })
})
await test('ops reads and writes reach the host read-before-edit table (#17)', async () => {
  await withTempDir('fs-observed',async root => {
    fs.writeFileSync(path.join(root,'a.txt'),'alpha\nbeta\n')
    const {ctx}=await bootHost()
    const agent={id:'observed',session:{id:'observed',header:{cwd:root}}}
    const exec={agent,signal:new AbortController().signal}
    try {
      await ctx.plugin(Subprocess)
      await ctx.plugin(inner=>inner.provide('sandboxPolicy',{defaultMode:'danger-full-access',resolve:()=>({mode:'danger-full-access',workspaceRoot:root})}))
      // Without the host fs service, ops tools still work and simply record nothing.
      const bare=await fileCall(ctx,worker,'inspect_local_file',{path:'a.txt'},exec,exec.signal)
      assert.equal(bare.status,'completed',JSON.stringify(bare))
      await ctx.plugin(FileSystem,{})
      await ctx.plugin(ObservationPolicy)
      const host=ctx.get('fs')
      const target=await host.resolve('a.txt',{cwd:root})
      const intent=()=>ctx.waterfall('fs/edit-intent',target,exec,()=>undefined)
      const current=async()=>(await host.stat(target)).version
      await assert.rejects(intent(),error=>error.code==='FS_NOT_OBSERVED')
      const read=await fileCall(ctx,worker,'inspect_local_file',{path:'a.txt',limit:1},exec,exec.signal)
      assert.equal(read.status,'completed',JSON.stringify(read))
      assert.deepEqual(await intent(),{version:await current()})
      const before=await current()
      const dry=await fileCall(ctx,worker,'replace',{path:'a.txt',pattern:'alpha',replacement:'gamma',dryRun:true},exec,exec.signal)
      assert.equal(dry.dryRun,true,JSON.stringify(dry))
      assert.deepEqual(await intent(),{version:before})
      // Keep the size identical so the version change is not a size-only artifact.
      await new Promise(r=>setTimeout(r,20))
      const replaced=await fileCall(ctx,worker,'replace',{path:'a.txt',pattern:'alpha',replacement:'delta'},exec,exec.signal)
      assert.equal(replaced.changed,1,JSON.stringify(replaced))
      const after=await current()
      assert.notEqual(after,before)
      assert.deepEqual(await intent(),{version:after})
    } finally { await shutdown(ctx) }
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
      // Strict adapters fill optional fields with empty placeholders; they must not reach the worker. (#19)
      const grep=await fileCall(ctx,worker,'grep',{path:'',pattern:'before',glob:[],outputMode:''},exec,exec.signal)
      assert.equal(grep.status,'completed',JSON.stringify(grep))
      assert.ok(grep.matched>=1,JSON.stringify(grep))
      const placeholders=await fileCall(ctx,worker,'inspect_local_file',{path:path.join(outside,'keep.txt'),encoding:'',view:'',offset:null},exec,exec.signal)
      assert.equal(placeholders.status,'completed',JSON.stringify(placeholders))
      const badEncoding=await fileCall(ctx,worker,'inspect_local_file',{path:path.join(outside,'keep.txt'),encoding:'gbk'},exec,exec.signal)
      assert.notEqual(badEncoding.status,'completed',JSON.stringify(badEncoding))
      assert.equal(badEncoding.error.code,'INVALID_ARGUMENT',JSON.stringify(badEncoding))
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
// The preparation interpreter must not inherit the host's PowerShell module search path: a DSH host
// runs under pwsh 7, whose **process-level** `PSModulePath` makes PowerShell 5.1 resolve
// `Microsoft.PowerShell.Security` to the pwsh 7 copy, fail to load it, and lose `Get-Acl`/`Set-Acl`
// before the script reaches its first ACL statement.
await test('preparation hands the 5.1 interpreter no inherited PowerShell module path', async () => {
  const inherited = {
    PATH: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
  }
  const env = preparationEnvironment(inherited)
  assert.equal(Object.hasOwn(env, 'PSModulePath'), false)
  assert.equal(env.PATH, 'C:\\bin')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(preparationEnvironment({}).PSModulePath, undefined)
  assert.equal(inherited.PSModulePath.startsWith('C:\\Program Files\\PowerShell\\7'), true)
})
// Covers the **call site**, not just the helper: `preparationSpawnSpec()` returns the exact
// `{executable, args, options}` handed to `spawn`, so a regression that passes `process.env` straight
// through is caught here — verified by mutation, which the helper-only assertion did not catch.
await test('preparation hands the spawned interpreter the scrubbed environment', async () => {
  const spec = preparationSpawnSpec('C:\\work\\scratch')
  assert.equal(Object.hasOwn(spec.options.env, 'PSModulePath'), false)
  // ⚠️ Look keys up case-insensitively: on Windows `process.env` is a case-insensitive proxy, but
  // `{ ...process.env }` is a plain object whose keys keep their original spelling (`Path`, not PATH).
  const pick = (obj, name) => Object.keys(obj).find((k) => k.toUpperCase() === name)
  const pathKey = pick(spec.options.env, 'PATH')
  assert.notEqual(pathKey, undefined)
  assert.equal(spec.options.env[pathKey], process.env.PATH)
  assert.equal(spec.executable.toLowerCase().endsWith('windows\\system32\\windowspowershell\\v1.0\\powershell.exe'), true)
  assert.deepEqual(spec.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-File'])
  assert.equal(spec.args.includes('C:\\work\\scratch'), true)
})
report('permissions')
