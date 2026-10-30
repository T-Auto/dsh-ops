import { createRunDirectory } from './output.mjs';
/**
 * ast-grep 单干能做到什么程度？（小树 606 文件 / 5.4MB）
 *
 * 三个问题：
 *  Q1 只用 ast-grep，能不能同时赢枚举 / 定位 / 改写？
 *  Q2 napi 的 findInFiles（Rust 侧走文件+并行 parse）比 Node 侧懒读快还是慢？
 *  Q3 改写精度与耗时，在"同一条 606 文件树"上分别多少？
 *
 * 对照组（原生基线：readdirSync / readFileSync / 正则 / writeFileSync，零子进程）
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, extname, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, findInFiles, Lang } from '@ast-grep/napi';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TREE = resolve(process.argv[2] ?? 'K:/ai/ai-stack/repos/OpenViking/web-studio/src');
const SG = process.env.PTC_SG ?? 'ast-grep';
const EXT = new Set(['.ts', '.tsx']);
const EXTS = ['.ts', '.tsx'];

const SYMBOL = 'getValidRequestBody';
const LOC_RULE = { rule: { pattern: `function ${SYMBOL}($$$A) { $$$B }` } };
const RW_PATTERN = 'return $A';
const RW_REWRITE = 'return ($A);';

const work = createRunDirectory('astgrep-only');
mkdirSync(work, { recursive: true });

const ms = (t) => Math.round(t * 100) / 100;

/** napi 的 node.replace(text) 不展开 meta 变量，必须自己展开（与 src/ast/inproc.cts 同款） */
const META = /\$\$\$([A-Za-z_]\w*)|\$([A-Za-z_]\w*)/g;
function expandTemplate(node, tpl) {
  return tpl.replace(META, (_w, multi, name) => {
    if (multi) {
      const all = node.getMultipleMatches(multi);
      if (!all || all.length === 0) return '';
      return all.map((n) => n.text()).join(node.text().includes('\r\n') ? '\r\n' : '\n');
    }
    return node.getMatch(name)?.text() ?? '';
  });
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

function run(bin, args, opts = {}) {
  const t0 = performance.now();
  return new Promise((res) => {
    const c = spawn(bin, args, { shell: false, cwd: opts.cwd, windowsHide: true });
    const out = []; const err = [];
    c.stdout.on('data', (d) => out.push(d));
    c.stderr.on('data', (d) => err.push(d));
    c.stdin.on('error', () => {});
    if (opts.stdin != null) c.stdin.end(opts.stdin);
    c.on('close', (code) => res({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8'), t: performance.now() - t0 }));
  });
}

async function times(fn, n = 7) {
  const samples = []; let last;
  for (let i = 0; i < n; i++) { const t0 = performance.now(); last = await fn(); samples.push(performance.now() - t0); }
  return { med: median(samples), last, n };
}

/* ── 枚举 ── */
const walk = () => {
  const out = [];
  (function rec(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) rec(p); else if (EXT.has(extname(e.name))) out.push(p); } })(TREE);
  return out;
};
const FILES = walk();

/* ── E1 枚举 ── */
async function e1() {
  const r = {};
  r['原生 readdirSync'] = (await times(() => walk())).med;
  r['napi findInFiles($$$A)'] = (await times(async () => new Promise((ok) => {
    const set = new Set();
    findInFiles(Lang.TypeScript, { paths: [TREE], matcher: { rule: { pattern: '$A' } } }, (err, nodes) => {
      for (const n of nodes) set.add(n.getRoot().filename());
    }).then(() => ok(set.size));
  }), 3)).med;
  return r;
}

/* ── E2 定位 ── */
async function e2() {
  const r = {};
  // 原生懒读：子串预筛 + 只读命中文件
  const nativeLazy = () => {
    for (const f of FILES) {
      const s = readFileSync(f, 'utf8');
      const i = s.indexOf(SYMBOL);
      if (i < 0) continue;
      const e = s.indexOf('}', i);
      return { file: f, bytes: Buffer.byteLength(s.slice(i, e + 1)) };
    }
    return null;
  };
  r['原生懒读（readdir+子串+只读1个）'] = (await times(nativeLazy)).med;
  r['sg CLI 扫全树'] = (await times(async () => {
    const x = await run(SG, ['run', '-p', LOC_RULE.rule.pattern, '-l', 'ts', '--json=stream', TREE]);
    return x.out.split('\n').filter(Boolean).length;
  }, 5)).med;
  // napi findInFiles：Rust 侧递归 + 并行 parse
  const fi = () => new Promise((ok) => {
    let n = 0, bytes = 0;
    findInFiles(Lang.TypeScript, { paths: [TREE], matcher: LOC_RULE }, (err, nodes) => {
      for (const node of nodes) { n++; bytes += Buffer.byteLength(node.text()); }
    }).then(() => ok({ n, bytes }));
  });
  r['napi findInFiles 全树'] = (await times(fi, 5)).med;
  // napi 懒读：子串预筛后只 parse 1 个
  r['napi 懒读（子串+parse 1个）'] = (await times(() => {
    for (const f of FILES) {
      const s = readFileSync(f, 'utf8');
      if (!s.includes(SYMBOL)) continue;
      const ast = parse(Lang.TypeScript, s);
      const hit = ast.root().find(LOC_RULE);
      return hit ? hit.text().length : 0;
    }
    return 0;
  })).med;
  return r;
}

/* ── E3 改写 ── */
function freshCopy(tag, file) {
  const p = join(work, `${tag}-${basename(file)}`);
  copyFileSync(file, p);
  return p;
}

async function e3() {
  const target = FILES.find((f) => readFileSync(f, 'utf8').includes(`function ${SYMBOL}`));
  const r = {};

  // 原生正则（锁符号体）
  r['原生正则'] = (await times(() => {
    const p = freshCopy('native', target);
    let s = readFileSync(p, 'utf8');
    const i = s.indexOf(`function ${SYMBOL}`);
    const e = s.indexOf('\n}', i);
    const body = s.slice(i, e).replace(/return\s+([^;\n]+);/g, 'return ($1);');
    writeFileSync(p, s.slice(0, i) + body + s.slice(e));
    return Buffer.byteLength(body);
  })).med;

  // sg CLI -U 原地
  r['sg CLI -U'] = (await times(async () => {
    const p = freshCopy('sgcli', target);
    const x = await run(SG, ['run', '-p', RW_PATTERN, '-r', RW_REWRITE, '-l', 'ts', '-U', p]);
    return x.code;
  }, 5)).med;

  // napi 进程内：parse 1 个 + commitEdits
  r['napi 进程内'] = (await times(() => {
    const p = freshCopy('napi', target);
    const src = readFileSync(p, 'utf8');
    const ast = parse(Lang.TypeScript, src);
    const fn = ast.root().find(LOC_RULE);
    if (!fn) return 0;
    const edits = fn.findAll({ rule: { pattern: RW_PATTERN } }).map((n) => n.replace(expandTemplate(n, RW_REWRITE)));
    const after = ast.root().commitEdits(edits);
    writeFileSync(p, after);
    return edits.length;
  })).med;

  return { target, r };
}

/* ── 主 ── */
const t0 = performance.now();
console.log(`tree: ${TREE}`);
console.log(`files: ${FILES.length}  bytes: ${FILES.reduce((n, f) => n + statSync(f).size, 0)}`);

const E1 = await e1();
const E2 = await e2();
const E3 = await e3();

console.log('\n== E1 枚举 ==');
for (const [k, v] of Object.entries(E1)) console.log(`${k.padEnd(28)} ${ms(v)} ms`);
console.log('\n== E2 定位 ==');
for (const [k, v] of Object.entries(E2)) console.log(`${k.padEnd(28)} ${ms(v)} ms`);
console.log('\n== E3 改写 ==');
for (const [k, v] of Object.entries(E3.r)) console.log(`${k.padEnd(28)} ${ms(v)} ms`);

const out = { tree: TREE, files: FILES.length, e1: E1, e2: E2, e3: E3.r, ms: Math.round(performance.now() - t0) };
writeFileSync(join(work, 'astgrep-only.json'), JSON.stringify(out, null, 2));
console.log(`\ntotal ${out.ms} ms`);
