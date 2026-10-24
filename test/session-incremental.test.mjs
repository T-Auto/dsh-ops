/** Real host counters for #333: unrelated sessions keep their publications and probes. */
import { createScope } from '@deepseek-ai/dsh-scope'
import * as discovery from '../lib/discovery/index.js'
import * as ptc from '../lib/ptc/index.js'
import { mountSessionBash } from '../lib/session-shells.js'
import { isPresentationProbe } from '../lib/presentation.js'
import { bootHost, shutdown } from './lib/host.mjs'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { WORKER, requireWorker } from './lib/boundary.mjs'
requireWorker('session-incremental')
const flush = async () => { for(let i=0;i<4;i++) await new Promise(resolve => setImmediate(resolve)) }

for (const mode of ['native', 'ptc']) await test(`new ${mode} sessions preserve unrelated definitions with bounded probes and registry events`, () => withTempDir('incremental-composition', async dir => {
  const {ctx,tools,prompt} = await bootHost()
  const agents=[], counts=new Map()
  ctx.provide('agents',{list:()=>agents})
  try {
    await ctx.plugin(inner=>{
      inner.provide('subprocess',{spawn(){throw new Error('counter test must not execute tools')}})
      inner.provide('sandboxPolicy',{resolve:({session})=>({mode:'danger-full-access',workspaceRoot:dir,sessionId:session.id})})
      inner.provide('ptcRuntime',{language:'typescript'})
    })
    ctx.effect(()=>prompt.section({name:'incremental:counter',order:6000,text:context=>{
      if(isPresentationProbe(context)) counts.set(context.scope,(counts.get(context.scope)??0)+1)
      return ''
    }}))
    await ctx.plugin({inject:['tools'],apply(inner){mountSessionBash(inner,{publishBashTool:true},{bash:{available:true,file:process.execPath,source:'explicit',detail:'never executed'}})}})
    await ctx.plugin(discovery,{binaryPath:WORKER,required:true})
    await ctx.plugin(ptc,{binaryPath:WORKER,required:true})
    let changes=0;ctx.on('tools/change',()=>{changes++})
    for(let i=0;i<16;i++){
      const agent={id:mode+'-'+i,session:{id:mode+'-'+i,header:{cwd:dir}}}
      agent.ctx=createScope(ctx,agent).ctx
      // This preset declaration is a real external registry/prompt change, not an
      // OPS attach. Settle it before measuring the lifecycle cost the PR fixes.
      if(mode==='ptc') await agent.ctx.plugin({inject:['tools'],apply(inner){inner.tools.presentAs('ptc')}})
      await flush()
      const identities=agents.map(a=>['ops_bash','ops_load_sdk','ops_discover_tools'].map(name=>tools.get(name,a)))
      counts.clear(); changes=0;agents.push(agent)
      await ctx.serial('agent/created',{agent});await flush()
      const old=agents.slice(0,-1)
      assert.equal(old.reduce((sum,a)=>sum+(counts.get(a)??0),0),0,'attach must not assemble old roots')
      old.forEach((a,j)=>['ops_bash','ops_load_sdk','ops_discover_tools'].forEach((name,k)=>assert.equal(tools.get(name,a),identities[j][k],name+' identity must survive sibling creation')))
      assert.ok((counts.get(agent)??0)<=4,'fresh probes are bounded independently of tracked sessions')
      assert.ok(changes<=6,`registration event count ${changes} must not grow with sessions`)
      assert.ok(tools.get('ops_bash',agent))
      assert.ok(tools.get(mode==='ptc'?'ops_load_sdk':'ops_discover_tools',agent))
    }
    const leave=agents.pop(), survivor=agents[0], sdk=tools.get('ops_load_sdk',survivor)
    await flush();counts.clear()
    await ctx.serial('agent/disposed',{agent:leave});await flush()
    assert.equal(agents.reduce((sum,a)=>sum+(counts.get(a)??0),0),0,'independent departure must not re-probe survivors')
    assert.equal(tools.get('ops_load_sdk',survivor),sdk)
  } finally {await shutdown(ctx)}
}))
report('session-incremental')
