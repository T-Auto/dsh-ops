/** Compare two workers on one content-identified local corpus; never a CI timing gate. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
const [before, after, selected] = process.argv.slice(2)
if (!before || !after || !selected) throw new Error('Usage: node bench/search-profile.mjs BEFORE_WORKER AFTER_WORKER CORPUS_ROOT')
const root = fs.realpathSync(selected)
const samples = Number(process.env.DSH_OPS_PROFILE_SAMPLES ?? 5)
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20) throw new Error('DSH_OPS_PROFILE_SAMPLES must be an integer from 1 to 20')
const sha = value => createHash('sha256').update(value).digest('hex')
function identity() {
  const entries = []; let bytes = 0
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (name.startsWith('.') || ['node_modules','target','.venv'].includes(name)) continue
      const file = path.join(directory,name), stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) visit(file)
      else if (stat.isFile()) { const content=fs.readFileSync(file); bytes+=content.length; entries.push([path.relative(root,file).replaceAll('\\','/'),sha(content)]) }
    }
  }
  visit(root); return {files:entries.length,bytes,sha256:sha(JSON.stringify(entries))}
}
const corpus=identity(), results=[]
const queries=[
  {name:'exact',tool:'grep',args:{pattern:'^export ',glob:['**/*.ts','!**/*.test.ts','!**/fixtures/**'],limit:50}},
  {name:'bounded',tool:'grep',args:{pattern:'^export ',glob:['**/*.ts','!**/*.test.ts','!**/fixtures/**'],limit:5,exactTotal:false}},
  {name:'miss',tool:'grep',args:{pattern:'__dsh_profile_absent_726c__',limit:5}},
  {name:'glob',tool:'glob',args:{pattern:['**/*.ts','!**/*.test.ts','!**/fixtures/**'],limit:50}},
]
for (const query of queries) for (let ordinal=0;ordinal<3+samples;ordinal++) {
  let reference
  // Preserve first-touch and two further warmups; alternate order to expose order/cache effects.
  const pairs=ordinal%2 ? [['after',after],['before',before]] : [['before',before],['after',after]]
  for (const [variant,worker] of pairs) {
    const input=JSON.stringify({root,scope:'search-profile',read_only:true,tool:query.tool,args:{path:root,...query.args}})
    const started=performance.now(), output=spawnSync(worker,[],{input,encoding:'utf8',timeout:35000,maxBuffer:512*1024,
      env:{...process.env,DSH_OPS_PROFILE_SEARCH:'1'}})
    const row={query:query.name,variant,ordinal,phase:ordinal===0?'first':ordinal<3?'warmup':'measured',elapsedMs:performance.now()-started,
      exitCode:output.status,error:output.error?.message}
    try {
      const value=JSON.parse(output.stdout), profile=output.stderr.split(/\r?\n/).find(line=>line.startsWith('dsh-ops-search-profile '))
      row.resultHash=sha(JSON.stringify(value)); row.coverage={scanComplete:value.scanComplete,pageComplete:value.pageComplete,
        scannedFiles:value.scannedFiles,skippedFiles:value.skippedFiles,matchedTotal:value.matchedTotal,matchedObserved:value.matchedObserved,truncatedBy:value.truncatedBy}
      row.profile=profile?JSON.parse(profile.slice('dsh-ops-search-profile '.length)):undefined
      if (reference && reference!==row.resultHash) row.error='Canonical result differs between workers'
      reference=row.resultHash
      if (!profile) row.error='Expected opt-in stage profile is missing'
      if (value.error) row.error=JSON.stringify(value.error)
    } catch(error) { row.error=String(error) }
    results.push(row)
    process.stderr.write(`${query.name} ${variant} ${ordinal}: ${row.elapsedMs.toFixed(1)}ms${row.error?' ERROR':''}\n`)
  }
}
const unchanged=JSON.stringify(identity())===JSON.stringify(corpus)
const report={version:1,corpus,unchanged,workers:{before:sha(fs.readFileSync(before)),after:sha(fs.readFileSync(after))},
  environment:{platform:process.platform,arch:process.arch,release:os.release(),node:process.version,cpu:os.cpus()[0]?.model},samples,
  boundary:'direct one-shot worker including process startup; stage clocks are opt-in and walkTotal includes sub-stages',
  queries,results}
console.log(JSON.stringify(report,null,2))
if (!unchanged || results.some(row=>row.error || row.exitCode!==0)) process.exitCode=1
