// Guards the bounded parse-root reuse in astdiff: identical (lang, text) may reuse
// one immutable tree, but a changed source must never see a stale tree or stale
// ERROR count, and public audit output must stay byte-for-byte reproducible.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { Lang } = require(resolve(root, 'node_modules/@ast-grep/napi'));
const ast = require(resolve(root, 'dist/ptc/astdiff.js'));

let checks = 0;
const ok = (name, fn) => { fn(); checks += 1; console.log(`PASS ${name}`); };
const stable = ({ ms, ...rest }) => rest;
const edit = (startByte, endByte, text) => ({ startByte, endByte, text });

// ── 1. identity reuse is keyed by the whole source
ok('same language+source reuses one tree', () => {
  const src = 'export function target(){ return 1; }\r\n';
  const a = ast.parseAuditRoot(Lang.TypeScript, src);
  const b = ast.parseAuditRoot(Lang.TypeScript, src);
  assert.equal(a, b);
  assert.equal(a.text(), src);
});

ok('one changed character yields a different tree', () => {
  const src = 'export function target(){ return 1; }\r\n';
  const a = ast.parseAuditRoot(Lang.TypeScript, src);
  const b = ast.parseAuditRoot(Lang.TypeScript, `${src} `);
  assert.notEqual(a, b);
  assert.equal(b.text(), `${src} `);
});

ok('language is part of the key', () => {
  const src = 'const a = 1;\r\n';
  const ts = ast.parseAuditRoot(Lang.TypeScript, src);
  const js = ast.parseAuditRoot(Lang.JavaScript, src);
  assert.notEqual(ts, js);
  assert.equal(ts.text(), src);
  assert.equal(js.text(), src);
});

// ── 2. a cached tree must never fabricate or hide a broken rewrite
ok('new syntax error still reported after a cache hit', () => {
  const src = 'export function target(){ return 1; }\r\n';
  ast.parseAuditRoot(Lang.TypeScript, src);
  const at = src.indexOf('1');
  const after = `${src.slice(0, at)}(1;${src.slice(at + 1)}`;
  const r = ast.auditAst(src, after, Lang.TypeScript, [edit(at, at + 1, '(1;')]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_AST_AUDIT_BROKEN');
  assert.equal(r.diagAfter, 1);
  assert.equal(r.diagBefore, 0);
});

ok('reused ERROR count still flags a broken tree-sitter rewrite', () => {
  const before = '<div>ok</div>';
  const after = '<div>';
  const spans = [edit(0, before.length, after)];
  const cold = ast.auditAst(before, after, Lang.Html, spans);
  const warm = ast.auditAst(before, after, Lang.Html, spans);
  assert.deepEqual(stable(warm), stable(cold));
  assert.equal(cold.parser, 'tree-sitter');
  assert.equal(cold.errorNodes, 1);
  assert.equal(cold.errorNodesBefore, 0);
  assert.equal(cold.ok, false);
  const fixed = ast.auditAst(before, before, Lang.Html, [edit(before.length, before.length, '')]);
  assert.equal(fixed.ok, true);
  assert.equal(fixed.errorNodes, 0);
});

ok('tolerated pre-existing error keeps its shifted identity', () => {
  const src = 'export function target(){ return 1; }\r\nconst = ;\r\n';
  const at = src.indexOf('1');
  const after = `${src.slice(0, at)}(1)${src.slice(at + 1)}`;
  const spans = [edit(at, at + 1, '(1)')];
  const cached = ast.auditAst(src, after, Lang.TypeScript, spans);
  assert.equal(cached.ok, true);
  assert.equal(cached.diagBefore, 1);
  // Push the snapshot out of the cache, then audit again from a cold parse.
  for (let i = 0; i < 8; i++) ast.parseAuditRoot(Lang.TypeScript, `const pad${i} = ${i};\r\n`);
  const fresh = ast.auditAst(src, after, Lang.TypeScript, spans);
  assert.deepEqual(stable(cached), stable(fresh));
});

// ── 3. reused root must not change audit output at all
ok('warm audit equals cold audit field for field', () => {
  const src = 'const a=1; const b=2;\r\n';
  const spans = [edit(19, 22, '300'), edit(8, 11, '10000')];
  const after = ast.spliceExpect(src, spans);
  const cold = ast.auditAst(src, after, Lang.TypeScript, spans);
  const warm = ast.auditAst(src, after, Lang.TypeScript, spans);
  assert.deepEqual(stable(warm), stable(cold));
});

ok('caller-supplied root stays authoritative for its own text', () => {
  const src = 'const a=1;\r\n';
  const spans = [edit(6, 7, '2')];
  const after = ast.spliceExpect(src, spans);
  const rootNode = ast.parseAuditRoot(Lang.TypeScript, src);
  const viaRoot = ast.auditAst(src, after, Lang.TypeScript, spans, rootNode);
  const viaParse = ast.auditAst(src, after, Lang.TypeScript, spans);
  assert.deepEqual(stable(viaRoot), stable(viaParse));
});

// ── 4. BOM keeps the documented fail-closed behaviour (native strips U+FEFF)
ok('BOM source: native root drops U+FEFF and audit rejects that mismatch', () => {
  const src = '\uFEFFconst a=1;\r\n';
  const rootNode = ast.parseAuditRoot(Lang.TypeScript, src);
  assert.equal(rootNode.text(), src.slice(1));
  const exact = ast.auditAst(src, src.replace('1', '2'), Lang.TypeScript, [edit(9, 10, '2')]);
  assert.equal(exact.ok, true);
  // A rewrite rebuilt from the native root loses the BOM, which must fail closed.
  const stripped = ast.auditAst(src, src.slice(1).replace('1', '2'), Lang.TypeScript, [edit(9, 10, '2')]);
  assert.equal(stripped.ok, false);
  assert.equal(stripped.code, 'E_AST_AUDIT_SPLICE');
});

// ── 5. eviction keeps correctness (more distinct texts than cache slots)
ok('eviction re-parses instead of returning a wrong tree', () => {
  const texts = Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};\r\n`);
  for (const t of texts) assert.equal(ast.parseAuditRoot(Lang.TypeScript, t).text(), t);
  // The first one was evicted long ago; asking again must still be exact.
  const again = ast.parseAuditRoot(Lang.TypeScript, texts[0]);
  assert.equal(again.text(), texts[0]);
  const againCached = ast.parseAuditRoot(Lang.TypeScript, texts[0]);
  assert.equal(again, againCached);
});

ok('interleaved distinct sources do not contaminate each other', () => {
  const a = 'export function a(){ return 1; }\r\n';
  const b = 'export function b(){ return 2; }\r\n';
  const ra = ast.auditAst(a, a.replace('1', '9'), Lang.TypeScript, [edit(a.indexOf('1'), a.indexOf('1') + 1, '9')]);
  ast.auditAst(b, b.replace('2', '8'), Lang.TypeScript, [edit(b.indexOf('2'), b.indexOf('2') + 1, '8')]);
  const ra2 = ast.auditAst(a, a.replace('1', '9'), Lang.TypeScript, [edit(a.indexOf('1'), a.indexOf('1') + 1, '9')]);
  assert.deepEqual(stable(ra2), stable(ra));
  assert.equal(ra.ok, true);
});

console.log(`audit root cache: ${checks} checks passed`);
