import { createRunDirectory } from './output.mjs';
/**
 * 分级寻址实测：进程内 walk / Everything es.exe / auto 三策略，在小树与大树上的真实代价。
 *
 * 关键点：这不是「Everything 全面更快」的证明。两者固定成本差 47 倍，
 * 交叉点在 1.2 万文件附近，auto 的作用就是让调用方不必自己判断落在哪一侧。
 *
 *   node bench/tiered.mjs
 */
import { enumerate, inprocLocate, clearEnumCache } from '../../lib/ast/inproc.cjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const SMALL = 'K:/ai/ai-stack/repos/OpenViking/web-studio/src';
const BIG = 'K:/ai';
const ROUNDS = Number(process.env.PTC_BENCH_ROUNDS ?? 3);

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const ms = (n) => Math.round(n * 100) / 100;

function timeIt(fn) {
  const t = performance.now();
  const out = fn();
  return { ms: performance.now() - t, out };
}

const rows = [];
for (const [label, root, rounds] of [
  ['小树 web-studio/src', SMALL, ROUNDS],
  ['大树 K:/ai', BIG, Math.max(2, Math.min(ROUNDS, 2))],
]) {
  for (const strategy of ['walk', 'everything', 'auto']) {
    const samples = [];
    let files = 0;
    let via = '?';
    for (let i = 0; i < rounds; i++) {
      clearEnumCache();
      const r = timeIt(() => enumerate([root], new Set(['.ts', '.tsx']), { strategy, cwd: process.cwd() }));
      samples.push(r.ms);
      files = r.out.files.length;
      via = r.out.via;
    }
    rows.push({ tree: label, strategy, via, files, medianMs: ms(med(samples)), samples: samples.map(ms) });
    console.log(`${label.padEnd(20)} ${strategy.padEnd(11)} via=${via.padEnd(11)} ${String(files).padStart(6)} files  ${ms(med(samples))}ms`);
  }
}

// 定位（只读）：同一符号，三种策略
const locateRows = [];
for (const [label, root, symbol] of [
  ['小树', SMALL, 'getValidRequestBody'],
  ['大树', BIG, 'inprocRefactor'],
]) {
  for (const strategy of ['walk', 'everything', 'auto']) {
    clearEnumCache();
    const r = timeIt(() => inprocLocate({ symbol, roots: [root], strategy, limit: 1 }, process.cwd()));
    const hit = r.out.hits[0];
    locateRows.push({
      tree: label,
      strategy,
      status: r.out.status,
      via: r.out.locate?.via ?? null,
      ms: ms(r.ms),
      contextBytes: r.out.contextBytes,
      file: hit?.file ?? null,
    });
    console.log(
      `locate ${label} ${strategy.padEnd(11)} ${r.out.status} via=${r.out.locate?.via ?? '-'} ${ms(r.ms)}ms ctx=${r.out.contextBytes}B`,
    );
  }
}

const output = createRunDirectory('tiered');
const out = `${output}/tiered.json`;
writeFileSync(
  out,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), node: process.version, enum: rows, locate: locateRows },
    null,
    2,
  ),
);
console.log(`\n-> ${out}`);
