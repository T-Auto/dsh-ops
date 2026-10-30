# 审计报告 — ops-parallel-read 4.1.8（2026-10-30）

范围：本包作为 `ops_read_files` 的进程内实现并入 dsh-ops 后的第六轮审计。本轮只做一件事 ——
把「同一文件在同一次会话里被重复读」的重复计算抽掉，并验证它没有动摇任何一道闸门。

历史轮次：4.1.5（静默截断）、4.1.6（功能 A+B 合并）、4.1.7（路径口径与正文保真解耦）见文末各节。

## 0. 本轮结论（4.1.8）

| 项 | 4.1.7 | 4.1.8 |
| --- | --- | --- |
| 同文件第二遍读（`worker.js`，17.5 KB） | 1.07 ms | **0.67 ms** |
| 缓存键 | — | `dev:ino:size:mtime` + 全部正文开关 |
| 失效条件 | — | `mtime` / `size` 变化即换键 |
| `inode` 不可用（网络盘报 0） | — | 不缓存（没有身份就没有命中判断） |
| 容量 | — | 64 项 / 8 Mi 字符，LRU |
| 新增导出 | — | `readCacheStats()` / `clearReadCache()` |
| 四道闸门位置 | 并发池 / 2 MiB / 3 s / 二进制 | 不变 |

为什么要留 `open` 与 `fstat`：它们是「这个文件现在是什么」的唯一凭据。跳过它们等于用上一次的结论
回答这一次的问题 —— 缓存能省的只是它们之后那段纯计算（解码、`SHA-256`、切行、行窗口结算）。

命中判据是**键完全相等**，包括 `full` / `hash` / `normalize` / `stripBom` / `strictUtf8`、行窗口、
字符额度。所以命中即等价于同一批字节、同一个窗口、同一套开关，不存在「缓存把截断版当完整版返回」
这类语义漂移。

## 1. 结论（4.1.5）

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

---

## 第十五轮（2026-10-30）：路径口径与正文保真解耦 → 4.1.7

### 1. 这轮改的是口径，不是速度

`normalize` 原本一个开关管三件事：CRLF→LF、剥/留 BOM、路径键 `\`→`/`。宿主 compat 层的要求正好
是**反着的组合** —— 正文必须逐字节（上层拿返回文本回写，清洗过就是静默写坏），路径必须是 POSIX
（回执里的 `path` 会被当成下一次调用的入参；`symbol_map` 与五个 `ops_ptc_*` 都已经是「相对 cwd +
POSIX」，只有 `read_files` 还在回 `K:\ai\...`）。旧实现只能二选一。

### 2. 改动

| 位置 | 改动 |
| --- | --- |
| `DEFAULTS` | 新增 `normalizePaths: undefined`，未指定时跟随 `normalize`（老调用点行为不变） |
| `normalizeOptions()` | 解析 `normalizePaths`，与 `normalize` 完全独立 |
| `readOne()` | 键与 `path` 只看 `opts.normalizePaths` |
| `compatItem()` | 外层 entry / `skeleton()` / 逐行 `items[]` / 行内截断 item / 字节前缀全部用同一条 POSIX 串；I/O 仍走原始 `f.path` |

字节前缀必须同步换：`sizeOf(n)` 用 `JSON.stringify({line, path, text})` 累加每行开销，路径串若与
最终回执不是同一串，128 KiB 预算会算歪，少算的部分直接变成超预算。

### 3. 实测

| 项 | 4.1.6 | 4.1.7 |
| --- | --- | --- |
| 单文件回执 | 2,186 B | **2,060 B**（−5.8%） |
| 32 文件回执里的同一路径 | 出现 2 次、每次带转义对 | 出现 2 次、无反斜杠 |
| `test_normalize.mjs` | 16 条 | **23 条**（新增 normalizePaths 4 条、compat 路径 3 条） |
| 内容语义 | CRLF/BOM 保真 | 不变（23 条全过） |

### 4. 回归

宿主 7 个 resident 工具的联合审计 75 项全过，其中与 read_files 相关的 21 项覆盖：CRLF/LF 切行、
无尾换行、UTF-16 与 GBK 的明确拒绝、代理对、300 KB 单行削减、越界 offset、32/33 文件边界、
栏内/栏外 junction 拒绝、工作区内凭据名拒绝、批量内凭据 fail-closed、50 万字符预算削减后仍给
`nextOffset`。

## 5. 4.1.8 回归

缓存插入点位于「解码 + 切行 + 行窗口结算」之后，四道闸门与预算结算都不经过它，所以行为面只需
验证三件事：命中是否等价、失效是否及时、未命中是否退回原路径。

| 用例 | 结果 |
| --- | --- |
| 同文件连读两次，正文逐字节相同 | 一致；第二遍走缓存 |
| 改文件后立即再读 | 键（`mtime`）变化，未命中，读到新内容 |
| `limit` / `offset` 不同的两次读 | 键不同，不互相污染 |
| `normalize: false` 与缺省交叉读同一文件 | 键不同，各回各的字节 |
| `inode` 为 0 的路径 | 不写缓存，行为与 4.1.7 相同 |
| 32 文件批量 + 缓存命中 | 回执字节与未缓存路径一致 |
| `readCacheStats()` 命中计数 | 单调递增；`clearReadCache()` 后归零 |

未修：目录链 TOCTOU（叶子已用 `lstat` + `fstat` 的 `dev+ino` 收口，父目录替换窗口仍在，彻底关闭需要
`openat` 逐级下钻，Node 不暴露）。
