import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Exercise the root build, including its CommonJS interoperability.
const require = createRequire(import.meta.url);
const { inprocRefactor, inprocLocate } = require('../lib/ast/inproc.cjs');
const { auditAst, spliceExpect } = require('../lib/ast/astdiff.cjs');
const { Lang, parse } = require('@ast-grep/napi');

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ptc-ast-regression-')));
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
function refactor(name, source, request) {
  const file = join(fixtureRoot, name);
  writeFileSync(file, source);
  const outcome = inprocRefactor({ file, mode: 'apply', ...request }, fixtureRoot);
  return { outcome, file, text: readFileSync(file, 'utf8') };
}
function namedCount(node) {
  return node.namedChildren().reduce((sum, child) => sum + 1 + namedCount(child), 0);
}
try {
  test('empty variadic capture expands to empty', () => {
    const r = refactor('empty.ts', 'function demo(){return f();}', { pattern: 'f($$$A)', rewrite: 'g($$$A)' });
    assert.equal(r.outcome.status, 'ok');
    assert.equal(r.text, 'function demo(){return g();}');
  });
  test('variadic capture preserves argument separators and comments', () => {
    const source = 'function demo(){return f(a, /* keep */ b);}';
    const r = refactor('arguments.ts', source, { pattern: 'f($$$A)', rewrite: 'g($$$A)' });
    assert.equal(r.outcome.status, 'ok');
    assert.equal(r.text, source.replace('f(', 'g('));
  });
  test('HTML inline children gain no whitespace', () => {
    const r = refactor('inline.html', '<div><b>a</b><i>b</i></div>', {
      pattern: '<div>$$$A</div>', rewrite: '<section>$$$A</section>',
    });
    assert.equal(r.outcome.status, 'ok');
    assert.equal(r.text, '<section><b>a</b><i>b</i></section>');
  });
  test('unbound single metavariable fails without writing', () => {
    const source = 'function demo(){return 1;}';
    const r = refactor('unbound.ts', source, { pattern: 'return $A', rewrite: 'return $B;' });
    assert.equal(r.outcome.status, 'error');
    assert.equal(r.outcome.code, 'E_INPROC_TEMPLATE');
    assert.equal(r.text, source);
  });
  test('mixed symbol definition forms are all located', () => {
    const source = 'function a(){function demo(){return 1;}}\nfunction b(){const demo=()=>{return 2;};}';
    const file = join(fixtureRoot, 'mixed.ts');
    writeFileSync(file, source);
    const result = inprocLocate({ file, symbol: 'demo' }, fixtureRoot);
    assert.equal(result.status, 'ok');
    assert.equal(result.hits.length, 2);
  });
  test('ambiguous symbol rewrite fails without writing', () => {
    const source = 'function a(){function demo(){return 1;}}\nfunction b(){const demo=()=>{return 2;};}';
    const r = refactor('ambiguous.ts', source, { symbol: 'demo', pattern: 'return $A', rewrite: 'return 9;' });
    assert.equal(r.outcome.status, 'error');
    assert.equal(r.outcome.code, 'E_INPROC_SYMBOL_AMBIGUOUS');
    assert.equal(r.text, source);
  });
  test('equal diagnostic counts cannot mask a new syntax error', () => {
    const before = 'function demo(){const broken = ; return 1;}';
    const after = 'function demo(){const broken=1; return (1;}';
    const r = auditAst(before, after, Lang.TypeScript, [{ startByte: 0, endByte: before.length, text: after }]);
    assert.equal(r.diagBefore, 1);
    assert.equal(r.diagAfter, 1);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'E_AST_AUDIT_BROKEN');
  });
  test('public refactor rejects equal-count syntax error replacement', () => {
    const before = 'function demo(){const broken = ; return 1;}';
    const r = refactor('diagnostic.ts', before, {
      pattern: 'function demo(){ $$$B }', rewrite: 'function demo(){const broken=1; return (1;}',
    });
    assert.equal(r.outcome.code, 'E_AST_AUDIT_BROKEN');
    assert.equal(r.text, before);
  });
  test('unchanged existing diagnostic survives UTF16 offset shift', () => {
    const before = 'function demo(){return 1;}\r\nconst broken = ;';
    const startByte = before.indexOf('1;');
    const edits = [{ startByte, endByte: startByte + 1, text: '"中文😀"' }];
    const r = auditAst(before, spliceExpect(before, edits), Lang.TypeScript, edits);
    assert.equal(r.parser, 'tsc');
    assert.equal(r.diagBefore, 1);
    assert.equal(r.diagAfter, 1);
    assert.equal(r.ok, true);
  });
  test('no-op edit preserves preexisting diagnostics in edited range', () => {
    const before = 'const broken = ;';
    const r = auditAst(before, before, Lang.TypeScript, [{ startByte: 0, endByte: before.length, text: before }]);
    assert.equal(r.diagBefore, 1);
    assert.equal(r.ok, true);
  });
  test('insertion into empty source counts added nodes and hunk', () => {
    const after = 'function demo(){return 1;}';
    const r = auditAst('', after, Lang.TypeScript, [{ startByte: 0, endByte: 0, text: after }]);
    assert.equal(r.ok, true);
    assert.equal(r.hunks, 1);
    assert.equal(r.nodesAdded, namedCount(parse(Lang.TypeScript, after).root()));
    assert.ok(r.nodesAdded > 0);
  });
  test('length-changing replacement counts full after subtree', () => {
    const before = 'function demo(){return 1;}';
    const after = 'function demo(){return (()=>{const x=2;return x;})();}';
    const r = auditAst(before, after, Lang.TypeScript, [{ startByte: 0, endByte: before.length, text: after }]);
    assert.equal(r.ok, true);
    assert.equal(r.nodesRemoved, namedCount(parse(Lang.TypeScript, before).root()));
    assert.equal(r.nodesAdded, namedCount(parse(Lang.TypeScript, after).root()));
  });
  test('multiple edits use cumulative after offsets', () => {
    const before = 'const a=1; const b=2;';
    const a = before.indexOf('1'), b = before.indexOf('2');
    const edits = [{ startByte: a, endByte: a + 1, text: '1000000' }, { startByte: b, endByte: b + 1, text: '3' }];
    const r = auditAst(before, spliceExpect(before, edits), Lang.TypeScript, edits);
    assert.equal(r.ok, true);
    assert.equal(r.hunks, 2);
    assert.equal(r.nodesRemoved, 2);
    assert.equal(r.nodesAdded, 2);
  });
  test('invalid fractional, negative and NaN offsets are rejected', () => {
    for (const startByte of [-1, 0.5, NaN]) {
      assert.throws(() => spliceExpect('abc', [{ startByte, endByte: 1, text: 'x' }]));
    }
  });
  test('Unicode astral CJK source and CRLF are preserved exactly', () => {
    const source = '// 中文😀\r\nfunction demo(){\r\n return "说明😀";\r\n}\r\n';
    const r = refactor('unicode.ts', source, { symbol: 'demo', pattern: 'return $A', rewrite: 'return ($A);' });
    assert.equal(r.outcome.status, 'ok');
    assert.equal(r.text, source.replace('return "说明😀";', 'return ("说明😀");'));
  });
  test('unchanged ratio is measured in UTF8 bytes', () => {
    const before = '//中文😀\nconst a=1;';
    const startByte = before.indexOf('1');
    const edits = [{ startByte, endByte: startByte + 1, text: '2' }];
    const r = auditAst(before, spliceExpect(before, edits), Lang.TypeScript, edits);
    assert.equal(r.ok, true);
    assert.equal(r.unchangedRatio, 1 - 1 / Buffer.byteLength(before));
  });
  test('tree-sitter fallback rejects equal-count replacement errors', () => {
    const before = 'a{color red;}\nb{color:blue;}';
    const after = 'a{color:red;}\nb{color blue;}';
    const r = auditAst(before, after, Lang.Css, [{ startByte: 0, endByte: before.length, text: after }]);
    assert.equal(r.parser, 'tree-sitter');
    assert.equal(r.diagBefore, 1);
    assert.equal(r.diagAfter, 1);
    assert.equal(r.ok, false);
  });
  test('tree-sitter fallback preserves shifted existing error nodes', () => {
    const before = 'a{color red;}';
    const edits = [{ startByte: 0, endByte: 0, text: '/*😀*/\r\n' }];
    const r = auditAst(before, spliceExpect(before, edits), Lang.Css, edits);
    assert.equal(r.parser, 'tree-sitter');
    assert.equal(r.diagBefore, 1);
    assert.equal(r.ok, true);
  });
  test('deleting a full subtree counts only removed nodes', () => {
    const before = 'function demo(){return 1;}';
    const r = auditAst(before, '', Lang.TypeScript, [{ startByte: 0, endByte: before.length, text: '' }]);
    assert.equal(r.ok, true);
    assert.equal(r.nodesAdded, 0);
    assert.equal(r.nodesRemoved, namedCount(parse(Lang.TypeScript, before).root()));
    assert.equal(r.hunks, 1);
  });
  console.log(`${passed}/${passed + failures.length} AST regression checks passed`);
  if (failures.length) throw new Error(`AST regression failures: ${failures.join(', ')}`);
} finally {
  // Only the canonical directory created by this process is eligible for cleanup.
  assert.equal(realpathSync(fixtureRoot), resolve(fixtureRoot));
  rmSync(fixtureRoot, { recursive: true });
}
