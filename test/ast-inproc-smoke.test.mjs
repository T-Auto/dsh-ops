import './lib/ast-cli.mjs';
import { inprocRefactor, inprocLocate, enumerate } from '../lib/ast/inproc.cjs';
import { runRefactorPipeline, defaultConfig } from '../lib/ast/index.cjs';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const W=mkdtempSync(join(tmpdir(), 'dsh-refactor-inproc-'));
mkdirSync(W,{recursive:true});
// Optional PTC_FIXTURE is read-only input: it must define getValidRequestBody
// with exactly four `return $A` matches. All modifications use sandbox copies.
const fixture = process.env.PTC_FIXTURE
  ? readFileSync(process.env.PTC_FIXTURE, 'utf8')
  : `// Smoke fixture: neighbouring functions must remain unchanged.
const helper = (value: string) => value.trim();
function beforeRequest(value: number) { return value + 1; }
function getValidRequestBody(body: unknown): unknown {
  if (body === undefined) {
    return null;
  }
  if (typeof body === 'string') {
    return helper(body);
  }
  if (body instanceof Uint8Array) {
    return Array.from(body);
  }
  return JSON.stringify(body);
}
function afterRequest(value: number) { return value - 1; }
`;
const SRC=join(W,'fixture-source.ts');
writeFileSync(SRC, fixture, 'utf8');
const results=[];
function chk(name, ok, note=''){ results.push({name,ok,note}); console.log((ok?'PASS':'FAIL')+'  '+name+(note?'  '+note:'')); }

// 预热 tsc oracle：一次 require('typescript') 约 100ms，单独拿出来，
// 否则下面的耗时对比量到的是模块加载而不是改写本身。
try { createRequire(import.meta.url)('typescript'); } catch {}

// ── 1. inproc 与五段 pipeline 逐字节一致
copyFileSync(SRC, join(W,'a.ts')); copyFileSync(SRC, join(W,'b.ts'));
const o1 = inprocRefactor({file:'a.ts',symbol:'getValidRequestBody',pattern:'return $A',rewrite:'return ($A);',mode:'apply'}, W);
const o2 = await runRefactorPipeline({file:'b.ts',symbol:'getValidRequestBody',astPattern:'return $A',astRewrite:'return ($A);',mode:'apply'}, defaultConfig({cwd:W}));
const A=readFileSync(join(W,'a.ts'),'utf8'), B=readFileSync(join(W,'b.ts'),'utf8');
chk('inproc 与五段 pipeline 输出逐字节一致', o1.status==='ok' && o2.status==='ok' && A===B, `inproc=${o1.edits}处/${o1.ms}ms pipeline=${o2.status}/${o2.hunks??'?'}hunk`);
chk('inproc 改动处数 = 4', o1.edits===4, String(o1.edits));

// ── 2. preview 不落盘
copyFileSync(SRC, join(W,'c.ts'));
const beforeC=readFileSync(join(W,'c.ts'),'utf8');
const o3 = inprocRefactor({file:'c.ts',symbol:'getValidRequestBody',pattern:'return $A',rewrite:'return ($A);',mode:'preview'}, W);
chk('preview 不写盘', beforeC===readFileSync(join(W,'c.ts'),'utf8'), `staged=${o3.staged}`);

// ── 3. 中文 + CRLF 文件，字节偏移安全
const zh = 'export function demo() {\r\n  const 说明 = "返回值";\r\n  return 说明;\r\n}\r\n';
writeFileSync(join(W,'zh.ts'), zh, 'utf8');
const o4 = inprocRefactor({file:'zh.ts',symbol:'demo',pattern:'return $A',rewrite:'return ($A);',mode:'apply'}, W);
const zhOut = readFileSync(join(W,'zh.ts'),'utf8');
chk('中文+CRLF 改写正确', zhOut.includes('return (说明);') && zhOut.includes('\r\n'), JSON.stringify(zhOut.slice(0,40)));
chk('中文文件仍是 CRLF', (zhOut.match(/\r\n/g)??[]).length===(zh.match(/\r\n/g)??[]).length, '');

// ── 4. 符号不存在 → 熔断
const o5 = inprocRefactor({file:'a.ts',symbol:'noSuchFn',pattern:'return $A',rewrite:'return ($A);',mode:'preview'}, W);
chk('符号不存在熔断', o5.status==='error' && o5.code==='E_INPROC_NO_MATCH', o5.code);

// ── 5. pattern 零命中 → 熔断
const o6 = inprocRefactor({file:'a.ts',symbol:'getValidRequestBody',pattern:'while ($X) { $$$B }',rewrite:'',mode:'preview'}, W);
chk('pattern 零命中熔断', o6.status==='error' && o6.code==='E_INPROC_NO_MATCH', o6.code);

// ── 6. 上下文体积：outcome 自身 < 1KB
chk('outcome 序列化 < 1KB', Buffer.byteLength(JSON.stringify(o1))<1024, Buffer.byteLength(JSON.stringify(o1))+'B');

// ── 7. 计时：inproc 内部 vs 五段内部
console.log(`OBSERVE  内部耗时 inproc=${o1.ms}ms pipeline=${o2.ms}ms（不作为正确性门槛）`);

// ── 8. 进程内 AST 审计（替代 difftastic）
chk('审计通过且改写处数吻合', o1.audit?.ok===true && o1.audit?.hunks===o1.edits, `hunks=${o1.audit?.hunks} edits=${o1.edits}`);
chk('审计用 tsc 作 oracle 且诊断零增量', o1.audit?.parser==='tsc' && o1.audit?.diagAfter===o1.audit?.diagBefore, `${o1.audit?.parser} ${o1.audit?.diagBefore}->${o1.audit?.diagAfter}`);

// 首次 createSourceFile 带 JIT 开销，取 3 次中位才算热路径成本
const auditMs=[];
for(let i=0;i<3;i++){
  copyFileSync(SRC, join(W,'h.ts'));
  auditMs.push(inprocRefactor({file:'h.ts',symbol:'getValidRequestBody',pattern:'return $A',rewrite:'return ($A);',mode:'preview'}, W).audit.ms);
}
const medAudit = [...auditMs].sort((a,b)=>a-b)[1];
console.log(`OBSERVE  审计热路径中位 ${medAudit}ms（三次 ${auditMs.join('/')}；不作为正确性门槛）`);

// ── 9. 破坏语法的改写必须熔断且不落盘
copyFileSync(SRC, join(W,'d.ts'));
const beforeD=readFileSync(join(W,'d.ts'),'utf8');
const o7 = inprocRefactor({file:'d.ts',symbol:'getValidRequestBody',pattern:'return $A',rewrite:'return ($A;',mode:'apply'}, W);
chk('破坏语法熔断', o7.status==='error' && o7.code==='E_AST_AUDIT_BROKEN', o7.code);
chk('熔断后文件零改动', beforeD===readFileSync(join(W,'d.ts'),'utf8'), '');

// ── 10. strict：sg CLI 独立复核命中数
copyFileSync(SRC, join(W,'e.ts'));
const o8 = inprocRefactor({file:'e.ts',symbol:'getValidRequestBody',pattern:'return $A',rewrite:'return ($A);',mode:'preview',strict:true}, W);
chk('strict 两引擎命中数一致', o8.status==='ok' && o8.crossCheck?.agree===true, `napi=${o8.crossCheck?.napiCount} sg=${o8.crossCheck?.sgCount}`);

// ── 11. 只读定位：给区间与签名，不回正文
const L = inprocLocate({symbol:'getValidRequestBody', file:'a.ts'}, W);
chk('locate 命中并给出行区间', L.status==='ok' && L.hits.length===1 && L.hits[0].lines[0]>0, `L${L.hits?.[0]?.lines?.join('-')}`);
// 2.1.0 起 locate 默认附正文，上限 8 KiB；超过就只给 readHint。这里只验证闸门仍在。
chk('locate 附正文但受 8 KiB 闸门', !L.hits?.[0]?.body || Buffer.byteLength(L.hits[0].body) <= 8192, `${Buffer.byteLength(L.hits?.[0]?.body ?? '')}B`);
chk('locate 签名是首行且不含函数体', /^function getValidRequestBody/.test(L.hits?.[0]?.signature ?? ''), (L.hits?.[0]?.signature ?? '').slice(0,40));

// ── 12. 分级寻址：小树 auto 走进程内
const E1 = enumerate([W], new Set(['.ts']), {strategy:'auto', cwd:W, refresh:true});
chk('小树 auto 选择进程内 walk', E1.via==='walk' && E1.files.length>0, `${E1.via} ${E1.files.length} files ${E1.ms}ms`);

// ── 13. 枚举缓存：第二圈 0ms
const E2 = enumerate([W], new Set(['.ts']), {strategy:'auto', cwd:W});
chk('枚举结果命中进程内缓存', E2.cached===true && E2.files.length===E1.files.length, `cached=${E2.cached} ${E2.ms}ms`);

const fails=results.filter(r=>!r.ok).length;
console.log(`\n${results.length-fails}/${results.length} PASS`);
process.exit(fails?1:0);
