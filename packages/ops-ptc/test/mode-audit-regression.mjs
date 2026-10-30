import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { opsPtcAddition } = require('../dist/ptc/tools.js');
const dir = mkdtempSync(join(tmpdir(), 'ptc-mode-audit-'));
const owned = realpathSync(dir);
const file = join(dir, 'fixture.ts');
const original = 'function demo(){return 1;}\r\n';
let checks = 0;
try {
  // Metadata version must track package.json; drift ships a stale serverInfo.version.
  assert.equal(opsPtcAddition.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  checks++;
  for (const name of ['ops_ptc_inproc', 'ops_ptc_refactor']) {
    for (const mode of ['preveiw', null, false, 0, {}, []]) {
      writeFileSync(file, original);
      const args = { file, symbol: 'demo', pattern: 'return $A', rewrite: 'return 2;', mode };
      const out = await opsPtcAddition.handlers[name](args, { cwd: dir });
      assert.equal(out.code, 'E_BAD_ARGS', `${name} ${JSON.stringify(mode)}`);
      assert.equal(readFileSync(file, 'utf8'), original);
      const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n';
      const child = spawnSync(process.execPath, [resolve('dist/ptc/mcp.js')], { input, encoding: 'utf8', timeout: 5000 });
      assert.equal(child.status, 0, child.stderr);
      const frame = JSON.parse(child.stdout.trim());
      assert.equal(frame.result.isError, true);
      assert.equal(frame.result.structuredContent.code, 'E_BAD_ARGS');
      assert.equal(readFileSync(file, 'utf8'), original);
      checks += 2;
    }
  }
  for (const mode of ['preview', 'apply', undefined]) {
    writeFileSync(file, original);
    const out = await opsPtcAddition.handlers.ops_ptc_inproc({ file, symbol: 'demo', pattern: 'return $A', rewrite: 'return 2;', ...(mode === undefined ? {} : { mode }) }, { cwd: dir });
    assert.equal(out.status, 'ok', JSON.stringify(out));
    assert.equal(readFileSync(file, 'utf8'), mode === 'preview' ? original : 'function demo(){return 2;}\r\n');
    checks++;
  }
  console.log(JSON.stringify({ status: 'ok', checks, coverage: 'direct handlers + real MCP reject invalid modes without file writes; preview/apply/default preserved' }));
} finally {
  assert.equal(realpathSync(dir), owned);
  rmSync(owned, { recursive: true, force: true });
}
