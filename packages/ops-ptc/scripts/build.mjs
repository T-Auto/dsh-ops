#!/usr/bin/env node
/**
 * 构建 = 复制。
 *
 * `src/ptc/` 是本包唯一的实现源（CommonJS，`.d.ts` 手写贴着实现走）；`dist/` 只是发布产物名，
 * 内容与 `src/` 逐字节相同。这样仓库里没有需要编译的中间层，README 里的路径也不必在
 * 「源」和「产物」之间来回换算。
 */
import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(resolve(root, 'dist'), { recursive: true, force: true });
cpSync(resolve(root, 'src'), resolve(root, 'dist'), { recursive: true });
console.log('[build] src -> dist');
