/**
 * 小树（606 文件 / 5.4MB）上，五段流水线怎么才不输原生。
 *
 * 对照组：
 *  B0  进程启动基线 —— 一切固定成本的理论下界（空 node / --version / es 查询）
 *  E1  枚举 606 个 ts/tsx：node-glob / node-walk / es / fd / rg
 *  E2  定位符号（要 file + byteOffset + 片段）：全量读 / 懒读 / es+sg / rg-json / sg-tree
 *  E3  改写同一函数：原生正则 / sg -U 单进程 / sg --json + node 写入 / PTC 五段
 *  E4  常驻 sidecar：冷启动一次，之后 100 次查询的平均（唯一可能压到亚毫秒的路线）
 *  E5  批量改写 20 文件：逐文件起进程 vs 单进程多文件
 *
 * 用法：node bench/smalltree.mjs [tree]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TREE = resolve(process.argv[2] ?? 'K:/ai/ai-stack/repos/OpenViking/web-studio/src');
const ES = resolve(root, 'vendor/es.exe');
const SG = process.env.PTC_SG ?? 'ast-grep';
const RG = process.env.PTC_RG ?? 'rg';
const FD = process.env.PTC_FD ?? 'fd';

const SYMBOL = 'getValidRequestBody';
const LOC_PATTERN = `function ${SYMBOL}($$$A) { $$$B }`;
const RW_PATTERN = 'return $A';
const RW_REWRITE = 'return ($A);';

const work = join(root, '.sandbox', 'smalltree');
mkdirSync(work, { recursive: true });

/* ───────────── 工具 ───────────── */

const ms = (t) => Math.round(t * 100) / 100;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const p90 = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
};

function run(bin, args, opts = {}) {
  const t0 = performance.now();
  return new Promise((res) => {
    const c = spawn(bin, args, { shell: false, cwd: opts.cwd, windowsHide: true });
    const out = [];
    const err = [];
    let n = 0;
    c.stdout.on('data', (d) => {
      n += d.length;
      if (n <= 64 << 20) out.push(d);
    });
    c.stderr.on('data', (d) => err.push(d));
    c.stdin.on('error', () => {});
    if (opts.stdin != null) c.stdin.end(opts.stdin);
    else c.stdin.end();
    c.on('close', (code) =>
      res({
        code: code ?? -1,
        out: Buffer.concat(out).toString('utf8'),
        err: Buffer.concat(err).toString('utf8'),
        ms: performance.now() - t0,
      }),
    );
  });
}

/** warmup + 采样，返回 {median, p90, min, samples} */
async function bench(fn, { warmup = 2, n = 9 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  return { median: ms(median(samples)), p90: ms(p90(samples)), min: ms(Math.min(...samples)), samples: samples.map(ms) };
}

function walk(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let es;
    try {
      es = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of es) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  }
  return out;
}

const lines = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/* ───────────── B0 进程启动基线 ───────────── */

async function b0() {
  const cases = {
    'spawn node -e ""': () => run(process.execPath, ['-e', '']),
    'spawn ast-grep --version': () => run(SG, ['--version']),
    'spawn rg --version': () => run(RG, ['--version']),
    'spawn fd --version': () => run(FD, ['--version']),
    'spawn es.exe (零命中查询)': () => run(ES, ['-n', '1', 'zzzz_no_such_file']),
  };
  const out = {};
  for (const [k, fn] of Object.entries(cases)) out[k] = await bench(fn, { n: 11 });
  return out;
}

/* ───────────── E1 枚举 ───────────── */

async function e1() {
  const cases = {
    'node fs.globSync ×2': async () => globSync('**/*.ts', { cwd: TREE }).concat(globSync('**/*.tsx', { cwd: TREE })),
    'node readdirSync 递归': async () => walk(TREE),
    'es.exe (Everything)': async () => {
      const r = await run(ES, ['-n', '100000', '-path', TREE, '-r', '\\.tsx?$']);
      if (r.code !== 0) throw new Error(r.err);
      return lines(r.out);
    },
    'fd -e ts -e tsx': async () => {
      const r = await run(FD, ['-e', 'ts', '-e', 'tsx', '.', TREE]);
      if (r.code !== 0) throw new Error(r.err);
      return lines(r.out);
    },
    'rg --files -g *.ts*': async () => {
      const r = await run(RG, ['--files', '-g', '*.ts', '-g', '*.tsx', TREE]);
      if (r.code !== 0) throw new Error(r.err);
      return lines(r.out);
    },
  };
  const out = {};
  for (const [k, fn] of Object.entries(cases)) {
    const t = performance.now();
    const hits = await fn();
    const first = performance.now() - t;
    const b = await bench(fn, { n: 9 });
    out[k] = { ...b, hits: hits.length, firstRunMs: ms(first) };
  }
  return out;
}

/* ───────────── E2 定位符号 ───────────── */

const targetFile = (() => {
  const hit = walk(TREE).find((f) => {
    try {
      return readFileSync(f, 'utf8').includes(`function ${SYMBOL}`) || readFileSync(f, 'utf8').includes(`export function ${SYMBOL}`);
    } catch {
      return false;
    }
  });
  return hit;
})();

async function e2() {
  if (!targetFile) throw new Error('目标符号未找到');
  const cases = {
    '原生 全量读（对照）': async () => {
      const all = walk(TREE);
      let bytes = 0;
      for (const f of all) bytes += readFileSync(f).length;
      return { files: all.length, bytes, hit: null };
    },
    '原生 懒读（命中即停）': async () => {
      const all = walk(TREE);
      const needle = `function ${SYMBOL}`;
      for (const f of all) {
        const s = readFileSync(f, 'utf8');
        const i = s.indexOf(needle);
        if (i >= 0) return { files: all.length, bytes: Buffer.byteLength(s.slice(0, i)), hit: f };
      }
      return { files: all.length, bytes: 0, hit: null };
    },
    'es + ast-grep 单文件（PTC 现状）': async () => {
      const e = await run(ES, ['-n', '64', '-path', TREE, '-r', '\\.tsx?$']);
      const files = lines(e.out);
      if (!files.length) throw new Error('es 零命中');
      const r = await run(SG, ['run', '--pattern', LOC_PATTERN, '--lang', 'ts', '--json=stream', targetFile]);
      if (r.code !== 0) throw new Error(r.err);
      const rec = lines(r.out).map((l) => JSON.parse(l))[0];
      return { files: files.length, bytes: rec?.range?.byteOffset?.end ?? 0, hit: targetFile };
    },
    'rg --json 单进程': async () => {
      const r = await run(RG, ['--json', '-n', '--no-heading', '-e', `function ${SYMBOL}`, TREE]);
      if (r.code !== 0) throw new Error(r.err);
      const rec = lines(r.out)
        .map((l) => JSON.parse(l))
        .find((x) => x.type === 'match');
      return { files: 1, bytes: rec?.data?.absolute_offset ?? 0, hit: rec?.data?.path?.text };
    },
    'ast-grep 单进程扫全树': async () => {
      const r = await run(SG, ['run', '--pattern', LOC_PATTERN, '--lang', 'ts', '--json=stream', '--globs', '**/*.ts', TREE]);
      if (r.code !== 0) throw new Error(r.err);
      const rec = lines(r.out).map((l) => JSON.parse(l)).find((x) => x?.metaVariables?.single?.NAME?.text === SYMBOL);
      return { files: 1, bytes: rec?.range?.byteOffset?.end ?? 0, hit: targetFile };
    },
    'rg 预筛 + ast-grep 单文件（2 进程）': async () => {
      const g = await run(RG, ['-l', '-e', `function ${SYMBOL}`, '-g', '*.ts', TREE]);
      const hit = lines(g.out)[0];
      if (!hit) throw new Error('rg 零命中');
      const r = await run(SG, ['run', '--pattern', LOC_PATTERN, '--lang', 'ts', '--json=stream', hit]);
      if (r.code !== 0) throw new Error(r.err);
      const rec = lines(r.out).map((l) => JSON.parse(l))[0];
      return { files: 1, bytes: rec?.range?.byteOffset?.end ?? 0, hit };
    },
  };
  const out = {};
  for (const [k, fn] of Object.entries(cases)) {
    const first = await fn();
    const b = await bench(fn, { n: 7, warmup: 1 });
    out[k] = { ...b, files: first.files, bytes: first.bytes, hit: first.hit ? basename(first.hit) : null };
  }
  return out;
}

/* ───────────── E3 改写单文件 ───────────── */

async function e3() {
  const pristine = join(work, 'pristine.ts');
  copyFileSync(targetFile, pristine);

  const reset = () => copyFileSync(pristine, join(work, 'x.ts'));
  const f = join(work, 'x.ts');

  const cases = {
    '原生 readFile+正则+write': async () => {
      reset();
      const t = performance.now();
      const s = readFileSync(f, 'utf8');
      writeFileSync(f, s.replace(/return ([^;\r\n]+);/g, 'return ($1);'), 'utf8');
      return performance.now() - t;
    },
    'ast-grep -U 单进程就地改': async () => {
      reset();
      const r = await run(SG, ['run', '-p', RW_PATTERN, '-r', RW_REWRITE, '-l', 'ts', '-U', f]);
      if (r.code !== 0) throw new Error(`sg -U 失败: ${r.err}`);
      return r.ms;
    },
    'ast-grep --json + node 写入（2 进程）': async () => {
      reset();
      const t = performance.now();
      const r = await run(SG, ['run', '-p', RW_PATTERN, '-r', RW_REWRITE, '-l', 'ts', '--json=stream', f]);
      const before = readFileSync(f);
      const edits = lines(r.out)
        .map((l) => JSON.parse(l))
        .filter((x) => x.replacement != null && x.replacementOffsets)
        .sort((a, b) => a.replacementOffsets.start - b.replacementOffsets.start);
      const parts = [];
      let cur = 0;
      for (const e of edits) {
        parts.push(before.subarray(cur, e.replacementOffsets.start), Buffer.from(e.replacement, 'utf8'));
        cur = e.replacementOffsets.end;
      }
      parts.push(before.subarray(cur));
      writeFileSync(f, Buffer.concat(parts));
      return performance.now() - t;
    },
    'PTC 五段（现状 full pipeline）': async () => {
      reset();
      const { runRefactorPipeline, defaultConfig } = await import('../dist/ptc/index.js');
      const t = performance.now();
      const out = await runRefactorPipeline(
        { file: basename(f), symbol: SYMBOL, astPattern: RW_PATTERN, astRewrite: RW_REWRITE, mode: 'apply' },
        defaultConfig({ cwd: work, esPath: ES }),
      );
      if (out.status !== 'ok') throw new Error(JSON.stringify(out));
      return performance.now() - t;
    },
  };

  const out = {};
  for (const [k, fn] of Object.entries(cases)) {
    await fn();
    const samples = [];
    for (let i = 0; i < 7; i++) samples.push(await fn());
    out[k] = { median: ms(median(samples)), p90: ms(p90(samples)), min: ms(Math.min(...samples)), samples: samples.map(ms) };
  }
  return out;
}

/* ───────────── E4 常驻 sidecar ───────────── */

const SIDECAR_SRC = `
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const ROOT = process.argv[2];
let files = [];
(function walk(){
  const st=[ROOT];
  while(st.length){const c=st.pop();let es;try{es=readdirSync(c,{withFileTypes:true})}catch{continue}
    for(const e of es){const p=join(c,e.name);if(e.isDirectory())st.push(p);else if(/\\.tsx?$/.test(e.name))files.push(p);}}
})();
// 启动即把整棵树读进内存：606 文件 / 4MB 完全放得下
const CASHE = new Map();
for (const f of files) { try { CASHE.set(f, readFileSync(f, 'utf8')); } catch {} }
let buf='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let req; try { req = JSON.parse(line) } catch { continue }
    const t0 = process.hrtime.bigint();
    let res = { ok: false };
    if (req.op === 'enumerate') {
      res = { ok: true, hits: files.length };
    } else if (req.op === 'locate') {
      const needle = 'function ' + req.symbol;
      for (const [f, s] of CASHE) {
        const at = s.indexOf(needle);
        if (at >= 0) {
          const close = s.indexOf('}', s.indexOf('{', at));
          res = { ok: true, file: f, start: at, end: close + 1, bytes: close + 1 - at };
          break;
        }
      }
    } else if (req.op === 'apply') {
      let n = 0;
      for (const [f, s] of CASHE) {
        const out = s.replace(/return ([^;\\r\\n]+);/g, (m, a) => { n++; return 'return (' + a + ');'; });
        if (out !== s) { CASHE.set(f, out); }
      }
      res = { ok: true, writes: n };
    }
    res.us = Number(process.hrtime.bigint() - t0) / 1000;
    process.stdout.write(JSON.stringify(res) + '\\n');
  }
});
`;

async function e4() {
  const { writeFileSync: wf } = await import('node:fs');
  const scPath = join(work, 'sidecar.cjs');
  wf(scPath, SIDECAR_SRC, 'utf8');

  const t0 = performance.now();
  const c = spawn(process.execPath, [scPath, TREE], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = [];
  c.stdout.setEncoding('utf8');
  c.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const r = pending.shift();
      if (r) r(JSON.parse(line));
    }
  });
  const call = (req) =>
    new Promise((res) => {
      pending.push(res);
      c.stdin.write(JSON.stringify(req) + '\n');
    });

  const first = await call({ op: 'locate', symbol: SYMBOL });
  const coldMs = performance.now() - t0;

  const sample = async (req, n = 100) => {
    const s = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await call(req);
      s.push(performance.now() - t);
    }
    return { median: ms(median(s)), p90: ms(p90(s)), min: ms(Math.min(...s)) };
  };

  const loc = await sample({ op: 'locate', symbol: SYMBOL });
  const enu = await sample({ op: 'enumerate' });
  const app = await sample({ op: 'apply' }, 20);

  c.stdin.end();
  c.kill();

  return {
    'sidecar 冷启动（含建索引+读全树）': { median: ms(coldMs), firstHit: first?.file ? basename(first.file) : null },
    'enumerate 常驻': enu,
    'locate 常驻': loc,
    'apply 全树正则改写（内存内，不落盘）': app,
  };
}

/* ───────────── E6 进程内 AST（@ast-grep/napi，无 fork） ───────────── */

async function e6() {
  const { inprocRefactor } = await import('../dist/ptc/inproc.js');
  const { parse, Lang } = await import('@ast-grep/napi');

  const file = targetFile;
  const call = (over) =>
    inprocRefactor(
      {
        pattern: RW_PATTERN,
        rewrite: RW_REWRITE,
        symbol: SYMBOL,
        mode: 'preview',
        ...over,
      },
      TREE,
    );

  const timeOf = (fn, n = 11) => {
    for (let i = 0; i < 3; i++) fn();
    const s = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      fn();
      s.push(performance.now() - t);
    }
    return { median: ms(median(s)), p90: ms(p90(s)), min: ms(Math.min(...s)) };
  };

  const single = timeOf(() => call({ file }));
  const tree = timeOf(() => call({ roots: [TREE], limit: 1, ext: ['ts', 'tsx'] }), 7);

  // 反例对照：610 个文件全 parse（不做预筛）
  const allParse = timeOf(() => {
    for (const f of walk(TREE)) {
      const s = readFileSync(f, 'utf8');
      parse(f.endsWith('.tsx') ? Lang.Tsx : Lang.TypeScript, s).root().findAll({ rule: { pattern: 'return $A' } });
    }
  }, 3);

  return {
    '进程内 单文件（指定 file）': single,
    '进程内 全树枚举+预筛（不给 file）': tree,
    '反例 全树 parse 不预筛': allParse,
    lastOutcome: call({ file }),
  };
}


/* ───────────── E5 批量改写 20 文件 ───────────── */

async function e5() {
  const all = walk(TREE).filter((f) => {
    if (!f.endsWith('.ts')) return false;   // .tsx 用 -l ts 解析会失败，批量对照只用 .ts
    try {
      return readFileSync(f, 'utf8').includes('return ');
    } catch {
      return false;
    }
  }).slice(0, 20);

  const dir = join(work, 'batch');
  mkdirSync(dir, { recursive: true });
  const flat = (f) => join(dir, relative(TREE, f).replace(/[\\/]/g, '__'));
  for (const f of all) copyFileSync(f, flat(f));

  const cases = {
    '逐文件起进程（20 × sg -U）': async () => {
      const t = performance.now();
      for (const f of all) {
        const r = await run(SG, ['run', '-p', RW_PATTERN, '-r', RW_REWRITE, '-l', 'ts', '-U', flat(f)]);
        if (r.code !== 0) throw new Error(r.err);
      }
      return performance.now() - t;
    },
    '单进程多文件（1 × sg -U 20 files）': async () => {
      const t = performance.now();
      const r = await run(SG, ['run', '-p', RW_PATTERN, '-r', RW_REWRITE, '-l', 'ts', '-U', ...all.map(flat)]);
      if (r.code !== 0) throw new Error(r.err);
      return performance.now() - t;
    },
    '单进程目录递归（1 × sg -U dir）': async () => {
      const t = performance.now();
      const r = await run(SG, ['run', '-p', RW_PATTERN, '-r', RW_REWRITE, '-l', 'ts', '-U', dir]);
      if (r.code !== 0) throw new Error(r.err);
      return performance.now() - t;
    },
  };

  const out = { files: all.length };
  for (const [k, fn] of Object.entries(cases)) {
    // 每次跑前还原，避免二次改写变 no-op 影响耗时
    for (const f of all) copyFileSync(f, flat(f));
    await fn();
    for (const f of all) copyFileSync(f, flat(f));
    const samples = [];
    for (let i = 0; i < 5; i++) {
      for (const f of all) copyFileSync(f, flat(f));
      samples.push(await fn());
    }
    out[k] = { median: ms(median(samples)), p90: ms(p90(samples)), min: ms(Math.min(...samples)) };
  }
  return out;
}

/* ───────────── main ───────────── */

const t0 = performance.now();
const results = {
  meta: {
    when: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    tree: TREE,
    symbol: SYMBOL,
    target: targetFile ? relative(TREE, targetFile) : null,
    files: walk(TREE).length,
    bytes: walk(TREE).reduce((n, f) => n + readFileSync(f).length, 0),
  },
  B0_spawnBaseline: await b0(),
  E1_enumerate: await e1(),
  E2_locate: await e2(),
  E3_rewriteSingle: await e3(),
  E4_sidecar: await e4(),
  E5_batch: await e5(),
  E6_inproc: await e6(),
};
results.meta.totalMs = ms(performance.now() - t0);
results.meta.treeBytes = results.meta.bytes;
delete results.meta.bytes;

writeFileSync(join(root, 'bench', 'smalltree.json'), JSON.stringify(results, null, 2), 'utf8');
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
