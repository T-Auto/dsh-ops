# 审计报告 — ops-parallel-read 4.1.5（2026-10-29）

范围：本包作为 `ops_read_files` 的进程内实现并入 dsh-ops 后的第四轮审计。重点测量 token 成本，并把上一轮遗留的「静默截断」清掉。

## 1. 结论

| 项 | 4.1.4 | 4.1.5 |
| --- | --- | --- |
| 缺省 `limit` | 200 行 | 整文件（受 128 KiB JSON 预算约束） |
| 271 行文件 | 返回 200 行，`status:completed` | 返回 270 行，`nextOffset:271` |
| 该次读取 token | 2,625 | 3,713 |
| 读完该文件所需调用 | 2 | 1 |

一次调用多付 1,088 token，省掉一整轮上下文重发。按本机实测的常驻工具面（7 个工具 1,379 token）加对话正文估算，任何一次「补读」的固定成本都远高于 1,088。

## 2. 缺陷：缺省 200 行造成静默截断

`COMPAT_DEFAULT_LIMIT` 照抄了原装 Rust worker 的 200 行缺省值。原装的 200 行是给「别把大文件灌进上下文」设的节流，但它的回执里 `status` 仍是 `completed`，只有 `nextOffset` 暗示后面还有内容。对模型来说，这就是「文件读完了」的错误信号：

- 271 行的 `dsh-ops/lib/file/worker.js` 只回 200 行，少了 71 行；
- 少了的那段不在摘要里，模型不会知道要补；
- 就算补，也是一整轮额外的上下文重发。

修法：`COMPAT_DEFAULT_LIMIT = COMPAT_MAX_LIMIT`。真正的闸门只剩输出预算——单条响应 128 KiB JSON，超预算时按行削到刚好放得下，并给 `nextOffset`。显式 `limit` 仍按 1..10000 生效，`limit: 200` 的行为与 4.1.4 逐字节一致。

## 3. 性能（未变）

进程内实现相对原生 worker 的收益来自「不起进程」，不是「并行读得快」：

| 数据集 | 原生 spawn | 进程内 | 倍率 |
| --- | --- | --- | --- |
| 6 × 2KB | 35.70 ms | 2.07 ms | 17.2x |
| 12 × 1KB | 48.10 ms | 2.49 ms | 19.3x |
| 24 × 512B | 72.22 ms | 4.35 ms | 16.6x |

空载 spawn 地板 18.15 ms（3.8 MB `dsh-ops-file.exe`）。纯 IO 层面并行没有收益：页缓存下没有等待可重叠，小文件场景 `Promise.all` 的调度开销反而更高（12 × 3–8KB：串行 2 ms，并行 5 ms）。本包的价值是消掉这段固定成本与一条 spawn 失败路径。

## 4. 围栏（未变）

| 用例 | 结果 |
| --- | --- |
| 叶子在 `lstat` 与 `open` 之间被换成链接 | `PATH_RESTRICTED`（`fstat` 的 `dev+ino` 比对） |
| 目录链上有 symlink / junction | `PATH_RESTRICTED` |
| `.ssh/id_rsa` | `CREDENTIAL_DENIED` |
| 1–32 文件上限、`offset>=1`、`limit 1..10000` | 与 schema 一致 |
| 非法 UTF-8 / UTF-16 | `ERR_INVALID_ENCODING` |

## 5. 残余风险

1. **目录链 TOCTOU**：`assertParentDirs` 与 `open` 之间仍有窗口。叶子已用 `fstat` 收口，目录链没有——要彻底消掉得用 `openat` 逐级下钻，Node 的 `fs` 不暴露。
2. **`maxFileSize`**：本实现保留 2 MiB 闸门；原装没有这道闸（3 MB 带 offset/limit 照读）。
3. **去重**：`readDedup` 挂在宿主观测服务上，脱离 DSH 进程即 no-op，本报告不度量。

## 6. 验证

```
node check.mjs
PR default {"lines":270,"total":270,"status":"completed","truncated":false,"nextOffset":271}
```

包内 `FIXES.md` 逐条记录本轮与前三轮的修补点。
