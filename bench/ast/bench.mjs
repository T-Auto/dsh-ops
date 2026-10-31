import { createRunDirectory } from './output.mjs';
/**
 * PTC 基准测试（bench）：给 PR 用的可复现数据。
 *
 * 四个维度：
 *   B1 寻址   Everything (es.exe) vs Node 递归遍历（ops_glob 的同类实现）
 *   B2 上下文 SANE 符号切片 vs 全文读入（进入模型上下文的字节数）
 *   B3 正确性 ast-grep AST 匹配 vs 正则替换（字符串字面量污染）
 *   B4 端到端 preview 模式延迟（含 difftastic 审计）
 *
 * 用法：node bench/bench.mjs [root]
 * 输出：stdout JSON + bench/results.json
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEditsInMemory,
  astGrepRewrite,
  defaultConfig,
  detectEol,
  everythingFind,
  runRefactorPipeline,
  saneLocate,
} from '../../lib/ast/index.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scanRoot = resolve(process.argv[2] ?? 'K:/ai');
const esPath = resolve(root, 'vendor/es.exe');
const work = createRunDirectory('bench');

mkdirSync(work, { recursive: true });

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const ms = (t) => Math.round(t * 100) / 100;

/* ───────────────── B1 寻址：Everything vs 递归遍历 ───────────────── */

function walkCollect(dir, want, limit, deadline) {
  const hits = [];
  let visited = 0;
  let dirs = 0;
  const stack = [dir];
  while (stack.length > 0) {
    if (limit > 0 && hits.length >= limit) break;
    if (Date.now() > deadline) return { hits, visited, dirs, timedOut: true };
    const cur = stack.pop();
    dirs += 1;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (limit > 0 && hits.length >= limit) break;
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        visited += 1;
        if (e.name.endsWith(want)) hits.push(p);
      }
    }
  }
  return { hits, visited, dirs, timedOut: false };
}

async function benchFindAt(scanRoot) {
  const limit = 200;
  const want = '.ts';
  const cfg = defaultConfig({ cwd: scanRoot, esPath });

  // 全量枚举：ops_glob 语义（要回答「仓库里所有 *.ts」，必须走完整棵树）
  const tFull = performance.now();
  const full = walkCollect(scanRoot, want, 0, Date.now() + 90_000);
  const fullMs = performance.now() - tFull;

  // 早停：只要前 200 个
  const tEarly = performance.now();
  const early = walkCollect(scanRoot, want, limit, Date.now() + 90_000);
  const earlyMs = performance.now() - tEarly;

  const samples = [];
  let esFiles = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    esFiles = await everythingFind(cfg, { pattern: '*', ext: 'ts', limit, roots: [scanRoot] });
    samples.push(performance.now() - t);
  }
  const esMs = median(samples);

  return {
    root: scanRoot,
    limit,
    walkFull: { ms: ms(fullMs), filesVisited: full.visited, dirsOpened: full.dirs, matched: full.hits.length, timedOut: full.timedOut },
    walkEarly: { ms: ms(earlyMs), filesVisited: early.visited, dirsOpened: early.dirs, matched: early.hits.length },
    everything: { ms: ms(esMs), samples: samples.map(ms), matched: esFiles.length, crlfClean: esFiles.every((f) => !f.includes('\r') && !f.endsWith(' ')) },
    /** >1 表示 Everything 比「全量枚举」快 */
    vsFullEnumeration: Number((fullMs / esMs).toFixed(2)),
    /** >1 表示 Everything 比「早停」快 */
    vsEarlyStop: Number((earlyMs / esMs).toFixed(2)),
  };
}

/* ───────────────── B2 上下文：SANE 切片 vs 全文 ───────────────── */

function makeBigFixture(lines = 2400) {
  const parts = [];
  parts.push('export function target(a: number): number {');
  parts.push('  const scale = a * 2;');
  parts.push('  return scale + 1;');
  parts.push('}');
  parts.push('');
  for (let i = 0; i < lines; i++) {
    parts.push(`export function filler${i}(x: number): number {`);
    parts.push(`  const v${i} = x * ${i + 2};`);
    parts.push(`  return v${i} + ${i};`);
    parts.push('}');
    parts.push('');
  }
  return parts.join('\n');
}

async function benchContext() {
  const file = join(work, 'big.ts');
  const src = makeBigFixture();
  writeFileSync(file, src, 'utf8');
  const total = Buffer.byteLength(src);

  const cfg = defaultConfig({ cwd: work, esPath });
  const t0 = performance.now();
  const slice = await saneLocate(cfg, file, 'target');
  const saneMs = performance.now() - t0;

  // 全文基线：ops_read_files 式整文件读入 = 全部字节进上下文
  const full = readFileSync(file).length;

  // 真实场景：不知道符号在哪个文件 → 传统做法是把候选文件全读一遍
  let candidates = [];
  try {
    candidates = await everythingFind(defaultConfig({ cwd: root, esPath }), {
      pattern: '*',
      ext: 'ts',
      limit: 19,
      roots: [join(root, 'src')],
    });
  } catch {
    candidates = [];
  }
  candidates.push(file);
  const candidateBytes = candidates.reduce((n, f) => {
    try {
      return n + statSync(f).size;
    } catch {
      return n;
    }
  }, 0);

  return {
    fileBytes: total,
    fullReadBytes: full,
    fullReadLines: src.split('\n').length,
    sane: {
      bytes: slice.slice.length,
      lines: slice.endLine - slice.startLine + 1,
      ms: ms(saneMs),
      signature: slice.signature,
    },
    /** 估算 token：英文/代码约 3.6 字节/token */
    savedBytesRatio: Number((1 - slice.slice.length / full).toFixed(4)),
    savedTokensEstimate: Math.round((full - slice.slice.length) / 3.6),
    /** 候选集全读 vs 只切一刀 */
    candidateSet: {
      files: candidates.length,
      fullReadBytes: candidateBytes,
      sliceBytes: slice.slice.length,
      savedBytesRatio: Number((1 - slice.slice.length / Math.max(1, candidateBytes)).toFixed(4)),
      savedTokensEstimate: Math.round((candidateBytes - slice.slice.length) / 3.6),
    },
  };
}

/* ───────────────── B3 正确性：AST vs 正则 ───────────────── */

const REGEX_FIXTURE = `function guard(flag: boolean): boolean {
  return true;
}

const note = "docs say return true is fine";
const tpl = \`legacy: return true\`;
`;

async function benchCorrectness() {
  const file = join(work, 'regex.ts');
  writeFileSync(file, REGEX_FIXTURE, 'utf8');

  const cfg = defaultConfig({ cwd: work, esPath });
  const before = readFileSync(file);
  const eol = detectEol(before);

  const edits = await astGrepRewrite(cfg, file, {
    pattern: 'return true',
    rewrite: 'return false',
    lang: 'ts',
    eol,
  });
  const astAfter = applyEditsInMemory(before, edits).toString('utf8');

  const regexHits = (REGEX_FIXTURE.match(/return true/g) ?? []).length;
  const regexAfter = REGEX_FIXTURE.replace(/return true/g, 'return false');
  const stringIntact = (s) => s.includes('"docs say return true is fine"') && s.includes('`legacy: return true`');

  return {
    occurrencesInSource: regexHits,
    astGrep: { edits: edits.length, stringLiteralsIntact: stringIntact(astAfter) },
    regex: { edits: regexHits, stringLiteralsIntact: stringIntact(regexAfter) },
    verdict: stringIntact(astAfter) && !stringIntact(regexAfter) ? 'ast-grep correct, regex corrupts literals' : 'inconclusive',
  };
}

/* ───────────────── B4 端到端延迟 ───────────────── */

async function benchPipeline(runs = 5) {
  const file = join(work, 'e2e.ts');
  const samples = [];
  let last = null;
  for (let i = 0; i < runs; i++) {
    writeFileSync(file, makeBigFixture(400), 'utf8');
    const cfg = defaultConfig({ cwd: work, esPath });
    const t = performance.now();
    last = await runRefactorPipeline(
      {
        query: 'big.ts',
        symbol: 'target',
        astPattern: 'return scale + 1',
        astRewrite: 'return scale + 2',
        file: basename(file),
        mode: 'preview',
      },
      cfg,
    );
    samples.push(performance.now() - t);
  }
  return {
    runs,
    medianMs: ms(median(samples)),
    samples: samples.map(ms),
    lastStatus: last?.status,
    lastStages: last?.stages,
    lastSummary: last?.summary,
    outBytes: Buffer.byteLength(JSON.stringify(last ?? {})),
  };
}

/* ───────────────── 汇总 ───────────────── */

const t0 = performance.now();
const findRoots = [scanRoot, join(resolve(scanRoot), 'ai-stack', 'repos')].filter((d) => {
  try {
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
});
const results = {
  meta: {
    when: new Date().toISOString(),
    Node: process.version,
    platform: `${process.platform} ${process.arch}`,
    es: esPath,
    scanRoot,
    totalMs: 0,
  },
  B1_find: [],
  B2_context: null,
  B3_correctness: null,
  B4_pipeline: null,
};
for (const r of findRoots) results.B1_find.push(await benchFindAt(r));
results.B2_context = await benchContext();
results.B3_correctness = await benchCorrectness();
results.B4_pipeline = await benchPipeline();
results.meta.totalMs = ms(performance.now() - t0);

writeFileSync(join(work, 'results.json'), JSON.stringify(results, null, 2), 'utf8');

const b1s = results.B1_find;
const b2 = results.B2_context;
const b3 = results.B3_correctness;
const b4 = results.B4_pipeline;

const b1Table = b1s
  .map(
    (b1) => `### \`${b1.root}\`（取前 ${b1.limit} 个 \`*.ts\`）

| 实现 | 耗时 | 打开目录 | 读到文件 | 命中 |
| --- | --- | --- | --- | --- |
| 递归全量枚举（ops_glob 语义） | ${b1.walkFull.ms} ms | ${b1.walkFull.dirsOpened} | ${b1.walkFull.filesVisited} | ${b1.walkFull.matched} |
| 递归早停（前 ${b1.limit} 个即停） | ${b1.walkEarly.ms} ms | ${b1.walkEarly.dirsOpened} | ${b1.walkEarly.filesVisited} | ${b1.walkEarly.matched} |
| Everything (es.exe) | ${b1.everything.ms} ms | 索引内 | 索引内 | ${b1.everything.matched} |

对比全量枚举 **${b1.vsFullEnumeration}x**，对比早停 **${b1.vsEarlyStop}x**；es 输出 \`\\r\` 残留检查：${b1.everything.crlfClean ? 'pass' : 'FAIL'}，3 次采样 ${b1.everything.samples.join(' / ')} ms。`,
  )
  .join('\n\n');

const md = `# Bench

${results.meta.when} · Node ${results.meta.Node} · ${results.meta.platform}

> 数字由 \`node bench/bench.mjs <root>\` 现场跑出，未手改。Everything 的耗时是**固定成本**（每次调用一个 es.exe 进程 + IPC 往返，约 150 ms，与索引规模无关）；递归遍历是**线性成本**（随目录数增长）。交叉点由树的大小决定，下表给的是本机实测。

## B1 寻址：Everything vs 递归遍历

${b1Table}

## B2 上下文：SANE 切片 vs 全文

| 读法 | 字节 | 行数 |
| --- | --- | --- |
| 单文件全文读入（${b2.fullReadLines} 行） | ${b2.fullReadBytes} | ${b2.fullReadLines} |
| SANE 符号切片 | ${b2.sane.bytes} | ${b2.sane.lines} |

单文件省 **${(b2.savedBytesRatio * 100).toFixed(2)}%**（约 ${b2.savedTokensEstimate} tokens），切片耗时 ${b2.sane.ms} ms。签名：\`${b2.sane.signature}\`

真实场景（不知道符号在哪个文件，候选集 ${b2.candidateSet.files} 个文件全读 vs 只切一刀）：

| 读法 | 字节 | 估算 tokens |
| --- | --- | --- |
| 候选集全读 | ${b2.candidateSet.fullReadBytes} | ${Math.round(b2.candidateSet.fullReadBytes / 3.6)} |
| 只切目标符号 | ${b2.candidateSet.sliceBytes} | ${Math.round(b2.candidateSet.sliceBytes / 3.6)} |

省 **${(b2.candidateSet.savedBytesRatio * 100).toFixed(2)}%**（约 ${b2.candidateSet.savedTokensEstimate} tokens）。注意省的只是**进上下文的字节**，磁盘仍是全量解析——AST 必须看懂整个文件才能定位符号。

## B3 正确性：AST 匹配 vs 正则替换

源文件里 \`return true\` 出现 ${b3.occurrencesInSource} 次，其中 2 次在字符串 / 模板字面量里。

| 实现 | 改写数 | 字面量未被污染 |
| --- | --- | --- |
| ast-grep (AST) | ${b3.astGrep.edits} | ${b3.astGrep.stringLiteralsIntact ? 'yes' : 'NO'} |
| 正则 /return true/g | ${b3.regex.edits} | ${b3.regex.stringLiteralsIntact ? 'yes' : 'NO'} |

${b3.verdict}

## B4 端到端（preview，含 difftastic）

${b4.runs} 次中位 **${b4.medianMs} ms**，返回 JSON ${b4.outBytes} 字节（阶段：${(b4.lastStages ?? []).join(' → ')}）。目标文件已知，故跳过第 1 段；走完整五段时再加一次 es 固定成本。

\`\`\`json
${JSON.stringify({ status: b4.lastStatus, stages: b4.lastStages, summary: b4.lastSummary }, null, 2)}
\`\`\`

复现：\`node bench/bench.mjs ${scanRoot}\`
`;

writeFileSync(join(work, 'BENCH.md'), md, 'utf8');
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
