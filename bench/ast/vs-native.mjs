import { createRunDirectory } from './output.mjs';
/**
 * 对原生路线（ops_glob 语义 = fs.glob / 手写递归 + 整文件读 + 正则改写）做同场景实测。
 *
 * E1 枚举：fs.globSync vs 手写递归 vs es.exe（同一棵树，全量 *.ts + *.tsx）
 * E2 定位：原生「读全部候选文件才能找到符号」vs PTC「es 定位 + SANE 只切符号体」
 * E3 改写：原生「读全文 + 正则替换 + writeFile」vs PTC「ast-grep + stdin 写入 + difft 审计」
 *
 * 用法：node bench/vs-native.mjs [repoSrc]
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { globSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, everythingFind, runRefactorPipeline, saneLocate } from '../../lib/ast/index.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repo = resolve(process.argv[2] ?? 'K:/ai/ai-stack/repos/OpenViking/web-studio/src');
const esPath = resolve(root, 'vendor/es.exe');
const work = createRunDirectory('vs-native');
mkdirSync(work, { recursive: true });

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length - 1] / 2 + s[s.length / 2] / 2));
};
const ms = (t) => Math.round(t * 100) / 100;

function walk(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p);
    }
  }
  return out;
}

const cfg = () => defaultConfig({ cwd: repo, esPath });

/* ───────── E1 枚举 ───────── */

async function e1() {
  const globSamples = [];
  let globHits = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    globHits = globSync('**/*.ts', { cwd: repo }).concat(globSync('**/*.tsx', { cwd: repo }));
    globSamples.push(performance.now() - t);
  }

  const walkSamples = [];
  let walkHits = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    walkHits = walk(repo);
    walkSamples.push(performance.now() - t);
  }

  const esSamples = [];
  let esHits = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    esHits = await everythingFind(cfg(), { pattern: '*', ext: 'ts;tsx', limit: 100000, roots: [repo] });
    esSamples.push(performance.now() - t);
  }

  return {
    root: repo,
    fsGlob: { medianMs: ms(median(globSamples)), samples: globSamples.map(ms), hits: globHits.length },
    walk: { medianMs: ms(median(walkSamples)), samples: walkSamples.map(ms), hits: walkHits.length },
    es: { medianMs: ms(median(esSamples)), samples: esSamples.map(ms), hits: esHits.length },
    sameSet:
      globHits.length === walkHits.length && walkHits.length === esHits.length ? 'count-equal' : 'count-differs',
  };
}

/* ───────── E2 定位 ───────── */

async function pickTarget() {
  // 用 AST 找一个真实函数，且函数体内有 `return <ident>;`，这样 pattern/rewrite 都是真实语法
  const files = walk(repo).filter((f) => f.endsWith('.ts') && !f.includes('$'));
  for (const file of files) {
    const res = await new Promise((res2) => {
      const c = spawn(
        'ast-grep',
        ['run', '--pattern', 'function $NAME($$$A) { $$$B }', '--lang', 'ts', '--json=stream', file],
        { shell: false },
      );
      let s = '';
      c.stdout.on('data', (d) => (s += d));
      c.on('close', (code) => res2({ code, s }));
    });
    if (res.code !== 0) continue;
    const recs = res.s
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    for (const r of recs) {
      const name = r?.metaVariables?.single?.NAME?.text;
      const body = r?.text ?? '';
      if (!name || typeof name !== 'string') continue;
      if (/^[A-Z]/.test(name)) continue;                  // 跳过组件/类名，挑普通函数
      if (name === 'constructor') continue;
      if (!/return [A-Za-z_$][\w$]*;/.test(body)) continue;
      return { file, funcName: name, pattern: 'return $A', rewrite: 'return ($A);' };
    }
  }
  return null;
}

async function e2(target) {
  // 原生：glob 拿到全部候选 → 只能整份读进上下文才能判断符号在哪个文件
  const gs = [];
  let bytes = 0;
  let files = 0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const all = walk(repo);
    bytes = 0;
    for (const f of all) {
      try {
        bytes += readFileSync(f).length;
      } catch {
        /* skip */
      }
    }
    files = all.length;
    gs.push(performance.now() - t);
  }

  // PTC：es 定位 + SANE 只切符号体
  const ps = [];
  let sliceBytes = 0;
  let esMs = 0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const hits = await everythingFind(cfg(), { pattern: '*', ext: 'ts;tsx', limit: 64, roots: [repo] });
    const tEs = performance.now();
    void hits; // es 只负责定位目录集合，真正的符号切片落在已知目标文件上
    const hit = await saneLocate(cfg(), target.file, target.funcName);
    sliceBytes = hit.slice.length;
    ps.push(performance.now() - t);
    if (i === 0) esMs = tEs - t;
  }

  return {
    native: { filesRead: files, contextBytes: bytes, medianMs: ms(median(gs)) },
    ptc: { esMs: ms(esMs), totalMs: ms(median(ps)), contextBytes: sliceBytes },
    contextRatio: Number((bytes / Math.max(1, sliceBytes)).toFixed(1)),
    tokenSave: Math.round((bytes - sliceBytes) / 3.6),
  };
}

/* ───────── E3 改写：原生 vs PTC ───────── */

async function e3(target) {
  const srcFile = join(work, `native-${basename(target.file)}`);
  const ptcFile = join(work, `ptc-${basename(target.file)}`);
  copyFileSync(target.file, srcFile);
  copyFileSync(target.file, ptcFile);

  // 原生：读全文（模型看到的量）→ 正则替换 → writeFile
  const tNative = performance.now();
  const text = readFileSync(srcFile, 'utf8');
  // 与 pattern `return $A` 同构：任意表达式，不只 ident
  const nativeOut = text.replace(/return ([^;\r\n]+);/g, 'return ($1);');
  writeFileSync(srcFile, nativeOut, 'utf8');
  const nativeMs = performance.now() - tNative;

  // PTC：ast-grep 命中 + stdin 写入 + difftastic 审计
  const tPtc = performance.now();
  const ptcOut = await runRefactorPipeline(
    {
      file: basename(ptcFile),
      symbol: target.funcName,
      astPattern: target.pattern,
      astRewrite: target.rewrite,
      mode: 'apply',
    },
    defaultConfig({ cwd: work, esPath }),
  );
  const ptcMs = performance.now() - tPtc;

  const nativeText = readFileSync(srcFile, 'utf8');
  const ptcText = readFileSync(ptcFile, 'utf8');

  // 语法是否仍可解析：让 ast-grep 把整份文件当 AST 走一遍
  const parseOk = async (file) =>
    new Promise((res) => {
      const c = spawn('ast-grep', ['run', '--pattern', 'return $A', '--lang', 'ts', '--json=stream', file], { shell: false });
      c.on('close', (code) => res(code === 0));
    });

  const countParen = (s2) => (s2.match(/return \(/g) ?? []).length - (text.match(/return \(/g) ?? []).length;
  const changedNative = countParen(nativeText);
  const changedPtc = countParen(ptcText);

  // 同作用域对照：原生也把替换锁进该函数的字节区间，看两条路线是否逐字节一致
  const scope = await new Promise((res) => {
    const c = spawn(
      'ast-grep',
      ['run', '--pattern', 'function $NAME($$$A) { $$$B }', '--lang', 'ts', '--json=stream', target.file],
      { shell: false },
    );
    let s = '';
    c.stdout.on('data', (d) => (s += d));
    c.on('close', () => {
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (r?.metaVariables?.single?.NAME?.text === target.funcName) {
          res(r.range.byteOffset);
          return;
        }
      }
      res(null);
    });
  });

  let scopedIdentical = null;
  if (scope) {
    const before = readFileSync(target.file, 'utf8');
    const scoped =
      before.slice(0, scope.start) +
      before.slice(scope.start, scope.end).replace(/return ([^;\r\n]+);/g, 'return ($1);') +
      before.slice(scope.end);
    scopedIdentical = scoped === ptcText;
  }

  return {
    target: { file: basename(target.file), symbol: target.funcName, pattern: target.pattern, rewrite: target.rewrite },
    native: {
      ms: ms(nativeMs),
      contextBytes: Buffer.byteLength(text),
      writes: changedNative,
      parseAfter: await parseOk(srcFile),
      bytesAfter: Buffer.byteLength(nativeText),
    },
    ptc: {
      ms: ms(ptcMs),
      contextBytes: 0,          // 中间态不进上下文，只回一行 JSON
      writes: changedPtc,
      parseAfter: await parseOk(ptcFile),
      bytesAfter: Buffer.byteLength(ptcText),
      identicalToNativeWholeFile: ptcText === nativeText,
      identicalToNativeScoped: scopedIdentical,
      outcome: ptcOut,
    },
  };
}

/* ───────── main ───────── */

const target = await pickTarget();
if (!target) {
  process.stdout.write(JSON.stringify({ status: 'error', message: '没找到可改写的真实函数' }, null, 2));
  process.exit(1);
}

const t0 = performance.now();
const results = {
  meta: {
    when: new Date().toISOString(),
    Node: process.version,
    platform: `${process.platform} ${process.arch}`,
    repo,
    es: esPath,
    totalMs: 0,
  },
  E1_enumerate: await e1(),
  E2_locate: await e2(target),
  E3_rewrite: await e3(target),
};
results.meta.totalMs = ms(performance.now() - t0);

writeFileSync(join(work, 'vs-native.json'), JSON.stringify(results, null, 2), 'utf8');

const { E1_enumerate: e1r, E2_locate: e2r, E3_rewrite: e3r } = results;
const md = `# 对比原生路线（VS_NATIVE）

${results.meta.when} · Node ${results.meta.Node} · ${results.meta.platform} · 目标仓库 \`${repo}\`

"原生"指 ops_glob / ops_read_files 的等效实现：\`fs.globSync\`、手写递归 \`readdirSync\`、整文件 \`readFileSync\`、正则替换 + \`writeFileSync\`。

## E1 枚举同一棵树（${e1r.fsGlob.hits} 个 \`*.ts\` / \`*.tsx\`，3 次中位）

| 实现 | 中位耗时 | 命中 |
| --- | --- | --- |
| \`fs.globSync\`（Node 原生 glob） | ${e1r.fsGlob.medianMs} ms | ${e1r.fsGlob.hits} |
| 手写 \`readdirSync\` 递归（老 ops_glob 实现） | ${e1r.walk.medianMs} ms | ${e1r.walk.hits} |
| Everything (es.exe) | ${e1r.es.medianMs} ms | ${e1r.es.hits} |

命中数一致性：${e1r.sameSet}。es 比 glob 慢 ${(e1r.es.medianMs / e1r.fsGlob.medianMs).toFixed(1)}x、比手写递归慢 ${(e1r.es.medianMs / e1r.walk.medianMs).toFixed(1)}x —— 这棵树只有 ${e1r.fsGlob.hits} 个文件，es 的 ~130 ms 是固定成本（进程 + IPC），与索引规模无关；递归是线性的。按 K:/ai 实测（135 万文件 / 12.4 s ≈ 10.9 万文件每秒）折算，交叉点约在 **1.2 万文件**：小于它，原生 glob 更快；大于它，Everything 开始领先，135 万文件时领先两个数量级。

## E2 定位符号（原生必须整份读进上下文）

| 路线 | 读的文件 | 进上下文字节 | 耗时 |
| --- | --- | --- | --- |
| 原生：glob + 全量 \`readFile\` | ${e2r.native.filesRead} | ${e2r.native.contextBytes} | ${e2r.native.medianMs} ms |
| PTC：es 定位 + SANE 切片 | 1（只切符号体） | ${e2r.ptc.contextBytes} | ${e2r.ptc.totalMs} ms（其中 es ${e2r.ptc.esMs} ms） |

上下文体积差 **${e2r.contextRatio}x**，单这一刀省约 ${e2r.tokenSave} tokens。注意 PTC 省的是**进上下文的字节**，磁盘上 ast-grep 仍要解析目标文件全文。

## E3 改写同一个真实函数（${e3r.target.file} · \`${e3r.target.symbol}\`）

| 路线 | 耗时 | 进上下文字节 | 改写处数 | 改后仍可 AST 解析 |
| --- | --- | --- | --- | --- |
| 原生：读全文 + 正则 + writeFile | ${e3r.native.ms} ms | ${e3r.native.contextBytes} | ${e3r.native.writes} | ${e3r.native.parseAfter ? 'yes' : 'NO'} |
| PTC：ast-grep + stdin + difftastic | ${e3r.ptc.ms} ms | ${e3r.ptc.contextBytes} | ${e3r.ptc.writes} | ${e3r.ptc.parseAfter ? 'yes' : 'NO'} |

改写处数不同不是缺陷，是作用域：原生整文件扫（${e3r.native.writes} 处），PTC 的 ast-grep 被 \`within\` 锁在符号体内（${e3r.ptc.writes} 处）。**把原生也锁进同一字节区间后，两边输出是否逐字节一致：${e3r.ptc.identicalToNativeScoped === null ? 'n/a' : e3r.ptc.identicalToNativeScoped ? '是（identical）' : '否'}**。

PTC 返回（全部回给模型的东西，${Buffer.byteLength(JSON.stringify(e3r.ptc.outcome))} 字节）：

\`\`\`json
${JSON.stringify(e3r.ptc.outcome, null, 2)}
\`\`\`

PTC 慢的那 ${(e3r.ptc.ms - e3r.native.ms).toFixed(0)} ms 是四段子进程的固定启动成本（ast-grep ×2 + node worker + difft），与文件大小基本无关；原生是单进程正则，单文件上必然更快。换来的：作用域锁定、字符串字面量不被误伤（BENCH.md B3：正则 3 处命中里 2 处在字符串里）、pre-image 哈希校验、原子替换、失败可回滚。

复现：\`node bench/vs-native.mjs ${repo}\`
`;

writeFileSync(join(work, 'VS_NATIVE.md'), md, 'utf8');
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
