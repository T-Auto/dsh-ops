import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
for (const name of ['ast', 'ast/inproc', 'ast/tools']) {
  const esm = await import(`dsh-ops/${name}`);
  const cjs = require(`dsh-ops/${name}`);
  assert.ok(Object.keys(esm).length > 1);
  assert.ok(Object.keys(cjs).length > 1);
  const entry = manifest.exports[`./${name}`];
  assert.ok(existsSync(new URL(entry.types, root)), `${name} declarations are published`);
}
const { defaultConfig } = require('dsh-ops/ast');
assert.ok(existsSync(defaultConfig().agentBoxWorker), 'compiled worker is next to the engine');
const schema = JSON.parse(readFileSync(new URL('lib/ast/schema.json', root), 'utf8'));
assert.equal(Object.keys(schema.tools).length, 5, 'tool schemas are copied by the root build');
for (const tool of require('dsh-ops/ast/tools').opsPtcAddition.tools) {
  assert.deepEqual(schema.tools[tool.name], tool.inputSchema, `${tool.name} schema matches the implementation`);
}
const cli = spawnSync(process.execPath, [fileURLToPath(new URL(manifest.bin['ops-ast'], root)), '--help'], {
  encoding: 'utf8', windowsHide: true,
});
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /locate/);
console.log('ast engine package: ESM/CJS exports, declarations, schema, worker and CLI passed');
