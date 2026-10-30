#!/usr/bin/env node
/**
 * 构建 = `tsc` + 两份非 TS 资源。
 *
 * `src/**\/*.ts` 是本包唯一的实现源，`dist/` 由 TypeScript 编译器生成，仓库里不保存。
 * 只有两样东西不进 tsc：
 *   - `agentbox.worker.cjs`：AgentBox 写入通道的 worker 入口，手写 CJS，`proc.ts` 按
 *     `__dirname` 直接拉起；
 *   - `schema.json`：五个工具的入参 schema，宿主侧当纯数据读，不参与类型检查。
 */
import { cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

rmSync(dist, { recursive: true, force: true });
const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.json')], { stdio: 'inherit' });

for (const asset of ['ptc/agentbox.worker.cjs', 'ptc/schema.json']) {
  cpSync(resolve(root, 'src', asset), resolve(dist, asset), { force: true });
}
console.log('[build] tsc -> dist (+ worker, schema)');
