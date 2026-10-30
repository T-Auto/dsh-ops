# 本地修补 — ops-parallel-read 4.1.7

## M2 路径口径与正文保真解耦（本次）

**问题**：`normalize` 一个开关管两件事 —— 正文清洗（CRLF→LF、剥 BOM）与路径键 `\`→`/`。宿主
compat 层的要求是**正文逐字节、路径 POSIX**：正文不能清洗（上层拿返回文本回写会写坏），路径必须
POSIX（回执里的 `path` 会被当成下一次调用的入参，反斜杠在 JSON 里还是转义对）。旧实现只能二选一，
于是 compat 层回执一直是 `K:\ai\...` 这种形态，与 `symbol_map` / `ptc` 的「相对 cwd + POSIX」不一致。

**改动**

| 位置 | 改动 |
| --- | --- |
| `DEFAULTS` | 新增 `normalizePaths: undefined`（未指定时跟随 `normalize`） |
| `normalizeOptions()` | `opts.normalizePaths = options.normalizePaths === undefined ? opts.normalize : !!options.normalizePaths` |
| `readOne()` | 键与 `path` 改用 `opts.normalizePaths`，不再看 `opts.normalize` |
| `compatItem()` | 展示路径统一 POSIX（外层 entry、`skeleton()`、逐行 `items[]`、行内截断 item、字节前缀），I/O 仍用原始 `f.path` |

**为什么字节前缀也要跟着换**：`sizeOf(n)` 用 `JSON.stringify({line, path, text})` 累加每行开销，
路径字符串必须与最终回执完全同一串，否则 128 KiB 预算会算歪（少算的部分会变成超预算）。

**实测**：单文件回执 2186 B → 2060 B（−5.8%）；`test_normalize.mjs` 16 → 23 条，全过。

## M1 功能 B 并入功能 A
## M1 功能 B 并入功能 A（本次）

**位置**：`ops_parallel_read.js` — `DEFAULTS.normalize`、`normalizeOptions()`、`readOne()` 的 `base` 与正文装配段

**改前**：批次读取只做闸门（并发池 / 2MB / 3s / 二进制 / 5 万字符），清洗靠调用方自己再跑一遍 —— 每条产出都要多一次全串 `replace`，路径 key 也还是反斜杠。`stripBom` 与 CRLF 处理没有统一开关。

**改后**：一个 `normalize`（默认 `true`）同时控制三项清洗：

| 项 | 落点 | 关闭后 |
| --- | --- | --- |
| UTF-8 BOM 剥离 | 解码首块（原有 `stripBom`，默认跟随 `normalize`） | 首字符 `\uFEFF` |
| `\r\n` → `\n` | 截断之后、补标记之前 | 保留 CRLF |
| 键与 `path` 转 POSIX | `emptyResult()` 构造处 | 保留 `\` |

**为什么放在截断之后**：截断标记 `...[Warning: Content truncated]...` 自身含 `\n`。先补标记再归一，标记里不会出现半个 `\r`；反过来则可能把标记切在 `\r` 与 `\n` 之间。

**为什么 `normalize:false` 会连带关掉 `stripBom`**：只关 CRLF 却仍剥 BOM，返回的既不是清洗版也不是磁盘原文 —— "原汁原味"必须是同一个判断，不能是两个半开。

**兼容性**：`readFilesCompat`（`ops_read_files` 替换路径）始终显式传 `normalize:false, stripBom:false`，行为与 4.1.5 逐字节一致。实测 CRLF + BOM 文件仍返回 `"\uFEFFa\r\nb\r\n"`。

**验证**：`node test_normalize.mjs` —— 16 条断言，含默认清洗、完全关闭、两开关正交、UTF-16LE 不被误转、纯 LF 零改动。


## 4.1.8 — 跨调用读取缓存（进程内 LRU）

同一文件在一次会话里被读两遍是常态（读、改、再读确认）。此前每次都重付 open + fstat +
read + 解码 + SHA-256 + 切行；open 与 fstat 必须每次都付（它们是"这个文件现在是什么"的
唯一凭据），能省的是它们之后那段。

- 键 = `dev:ino:size:mtime` + 全部影响正文的开关（full / hash / normalize / stripBom /
  strictUtf8、行窗口、字符额度），所以命中即等价于同一批字节、同一个窗口。
- `inode` 拿不到（部分网络盘报 0）不缓存 —— 没有身份就没有命中判断。
- 容量 64 项 / 8 Mi 字符，超了按 LRU 淘汰。
- 实测 `worker.js`（17.5 KB）第二遍 1.07 ms → 0.67 ms；改文件（mtime 变）立即失效。
- 新增 `readCacheStats()` / `clearReadCache()` 供测试与观测。
