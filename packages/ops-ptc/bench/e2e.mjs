/**
 * E2E A/B：同一批真实文件，同一条改写意图，三条路线各跑一遍。
 *
 *   A  原生        readdir 枚举 + 子串预筛 + 整文件读 + 正则替换 + 直写
 *   A' 原生+审计   同上 + 与 inproc 完全相同的语法 oracle（tsc parseDiagnostics）
 *   B  inproc      napi parse + findAll + commitEdits + tsc 审计 + 原子写
 *   C  pipeline    五段 spawn（Everything/SANE/ast-grep/AgentBox/difftastic）
 *
 * 关注：单文件中位耗时、总耗时、回到调用方上下文的字节数、产物是否逐字节一致。
 */
import { parse } from '@ast-grep/napi';
import ts from 'typescript';
import { inprocRefactor } from '../dist/ptc/inproc.js';
import {
  copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tree = process.env.PTC_TREE ?? 'K:/ai/ai-stack/repos/OpenViking/web-studio/src';
const pattern = 'return $A';
const rewrite = 'return ($A);';
const SANDBOX = path.join(root, '.sandbox', 'e2e');
const ITER = 5;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const t0 = performance.now();
const all = walk(tree);
const enumMs = performance.now() - t0;
const picked = all
  .filter((f) => { try { return readFileSync(f, 'utf8').includes('return '); } catch { return false; } })
  .slice(0, 30);
const prefilterMs = performance.now() - t0;

console.log(`tree: ${tree}`);
console.log(`files: ${all.length}  picked: ${picked.length}  enum: ${enumMs.toFixed(2)}ms  enum+substr: ${prefilterMs.toFixed(2)}ms\n`);

rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });

/* 与 astdiff.ts 同一个 oracle：只看解析期诊断，不做类型检查 */
const diag = (text, file) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true).parseDiagnostics.length;

function nativeOne(src, dst) {
  copyFileSync(src, dst);
  const t = performance.now();
  const text = readFileSync(dst, 'utf8');
  let n = 0;
  const after = text.replace(/return ([^;\n]+);/g, (_m, a) => { n++; return `return (${a});`; });
  writeFileSync(dst, after);
  return { ms: performance.now() - t, edits: n, bytes: Buffer.byteLength(after) };
}

function nativeAudited(src, dst) {
  copyFileSync(src, dst);
  const t = performance.now();
  const text = readFileSync(dst, 'utf8');
  let n = 0;
  const after = text.replace(/return ([^;\n]+);/g, (_m, a) => { n++; return `return (${a});`; });
  writeFileSync(dst, after);
  const ok = diag(after, dst) <= diag(text, src);
  return { ms: performance.now() - t, edits: n, ok };
}

function inprocOne(src, dst) {
  copyFileSync(src, dst);
  const t = performance.now();
  const o = inprocRefactor({ file: dst, pattern, rewrite, mode: 'apply' }, root);
  const ms = performance.now() - t;
  return { ms, edits: o.edits ?? 0, ok: o.status === 'ok', bytes: Buffer.byteLength(JSON.stringify(o)), audit: o.audit?.ok, code: o.code };
}

const rows = { native: [], nativeAudit: [], inproc: [] };
const detail = [];

for (let iter = 0; iter < ITER; iter++) {
  for (const src of picked) {
    const base = `${iter}-${path.basename(src)}`;
    const a = nativeOne(src, path.join(SANDBOX, `native-${base}`));
    const aa = nativeAudited(src, path.join(SANDBOX, `nativeAudited-${base}`));
    const b = inprocOne(src, path.join(SANDBOX, `inproc-${base}`));
    rows.native.push(a.ms);
    rows.nativeAudit.push(aa.ms);
    rows.inproc.push(b.ms);
    if (iter === 0) detail.push({ src, nativeEdits: a.edits, inprocEdits: b.edits, ok: b.ok, code: b.code });
  }
}

/* 产物对比 */
let identical = 0;
const diffs = [];
for (const src of picked) {
  const A = path.join(SANDBOX, `native-0-${path.basename(src)}`);
  const B = path.join(SANDBOX, `inproc-0-${path.basename(src)}`);
  const a = readFileSync(A), b = readFileSync(B);
  if (a.equals(b)) identical++;
  else {
    const d = detail.find((x) => x.src === src);
    diffs.push({ file: path.basename(src), nativeEdits: d.nativeEdits, inprocEdits: d.inprocEdits, inproc: d.code ?? 'ok' });
  }
}

/* pipeline：需要符号，用取样里最典型的那个真实函数 */
const canonical = path.join(tree, 'gen/ov-client/core/utils.gen.ts');
const pipeCopy = path.join(SANDBOX, 'pipe', 'utils.gen.ts');
mkdirSync(path.dirname(pipeCopy), { recursive: true });
copyFileSync(canonical, pipeCopy);
const tp = performance.now();
const pr = spawnSync(process.execPath, [
  path.join(root, 'dist', 'ptc', 'pipeline.js'),
  '--file', pipeCopy, '--symbol', 'getValidRequestBody',
  '--pattern', pattern, '--rewrite', rewrite,
], { encoding: 'utf8' });
const pipeMs = performance.now() - tp;

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sum = (a) => a.reduce((x, y) => x + y, 0);

const report = {
  tree, files: all.length, picked: picked.length, iter: ITER, pattern, rewrite,
  enumMs, prefilterMs,
  native: { median: med(rows.native), total: sum(rows.native), n: rows.native.length },
  nativeWithAudit: { median: med(rows.nativeAudit), total: sum(rows.nativeAudit) },
  inproc: { median: med(rows.inproc), total: sum(rows.inproc) },
  pipeline: {
    median: pipeMs, exit: pr.status,
    outcomeBytes: Buffer.byteLength(pr.stdout ?? ''),
    outcome: pr.stdout?.trim().slice(0, 400),
    stderr: (pr.stderr ?? '').trim().slice(0, 200),
  },
  identical, differ: diffs.length, diffs: diffs.slice(0, 10),
};

writeFileSync(path.join(here, 'e2e.json'), JSON.stringify(report, null, 2) + '\n');

const p = (x) => `${x.toFixed(2)} ms`;
console.log(`== 单文件改写（${picked.length} 文件 × ${ITER} 轮 = ${rows.native.length} 次） ==`);
console.log('A  原生 正则+直写           ', p(report.native.median), ' 总', p(report.native.total));
console.log("A' 原生+tsc 解析期审计      ", p(report.nativeWithAudit.median), ' 总', p(report.nativeWithAudit.total));
console.log('B  inproc napi+审计+原子写   ', p(report.inproc.median), ' 总', p(report.inproc.total));
console.log('C  pipeline 五段 spawn       ', p(report.pipeline.median), ` exit=${report.pipeline.exit}`);
console.log('');
console.log(`产物逐字节一致: ${identical}/${picked.length}`);
if (diffs.length) {
  console.log('不一致样本（nativeEdits vs inprocEdits）:');
  for (const d of diffs.slice(0, 6)) console.log('  ', d.file, d.nativeEdits, 'vs', d.inprocEdits, d.inproc);
}
console.log('');
console.log('pipeline outcome:', report.pipeline.outcome);
