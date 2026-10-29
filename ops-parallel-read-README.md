# ops-parallel-read

> **4.1.5**：缺省不再按 200 行截断。271 行的文件一次读满（2,625 → 3,713 token，省掉一整轮补读），
> 显式 `limit` 行为不变。详见 [FIXES.md](FIXES.md)。

零依赖的批量文件并发读取器。给 AI Agent 当"眼睛"：一次问 20 个文件，读得动、读得完、不会把上下文和 FD 一起撑爆。

```js
const { parallelRead } = require('ops-parallel-read');

const result = await parallelRead(['src/a.ts', 'src/b.ts', 'huge.log']);
// {
//   'src/a.ts':  { status: 'success', content: '...', truncated: false, ... },
//   'src/b.ts':  { status: 'error', error: { code: 'ENOENT', ... } },
//   'huge.log':  { status: 'error', error: { code: 'FILE_TOO_LARGE', ... } }
// }
```

零依赖，只用 `fs` / `path` / `crypto` / `string_decoder`。没有 `p-limit`，没有 `p-queue`，`dependencies` 是空对象。

---

## 为什么需要它

Agent 批量读文件有四种翻车方式，本工具各有一道闸：

| 翻车 | 后果 | 闸门 |
| --- | --- | --- |
| 一次读 200 个文件 | FD 耗尽，进程报 `EMFILE` | 并发池，峰值 = `concurrency`（默认 10） |
| 有人传了个 800MB 日志 | 内存直接顶穿 | `fstat` 先看大小，> 2 MiB 一个字节都不读 |
| 文件挂在断掉的网络盘上 | `readFile` 卡 30 秒，整批拖死 | 单文件 3 s 总预算，到点强杀并释放槽位 |
| 把 PNG 当 UTF-8 读 | 几百万个替换符污染上下文 | 已读前缀内见 NUL 即判二进制，拒绝返回文本（覆盖范围见 `scannedBytes`） |

外加两道针对**上下文**而非针对**系统**的闸：单文件 50,000 字符封顶、全批 120,000 字符封顶（对齐 dsh-ops 的 128 KiB 输出预算）。预算按**输入顺序**结算，同样的输入永远得到同样的输出，不会因为哪个文件先读完而变。

---

## 安装

```bash
npm install ops-parallel-read
```

Node >= 16。CommonJS 主入口，ESM 可直接命名导入（`cjs-module-lexer` 能静态识别导出）：

```js
import { parallelRead, readFilesCompat } from 'ops-parallel-read';
```

---

## API

### `parallelRead(filePaths, options?)`

返回 `Promise<Record<string, ReadEntry>>`，key 是路径，value：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | `string` | 原样回写 |
| `status` | `'success' \| 'error'` | |
| `content` | `string \| null` | 成功时的文本，超限已截断并带 `TRUNCATED_MARK` |
| `error` | `{ code, message } \| null` | |
| `truncated` | `boolean` | 内容被截断（读取早停或预算二次切） |
| `size` | `number \| null` | `fstat` 字节数 |
| `bytes` | `number \| null` | 实际读入字节（早停时 < `size`） |
| `mtimeMs` | `number \| null` | |
| `lineCount` | `number \| null` | 只在 `full` 或行窗口模式有值；早停模式为 `null`（不谎报） |
| `revision` | `string \| null` | SHA-256，只在 `full + hash` 有值 |
| `elapsedMs` | `number` | |
| `rows` | `string[] \| null` | 行窗口命中的行；native 模式为 `null` |
| `rowsClipped` | `boolean` | 行窗口被字节预算削过 |
| `scannedBytes` | `number` | 二进制闸门与解码闸门实际覆盖的字节数；早停时 `< size` |

单个文件失败**不会**让整批 reject。只有 `filePaths` 不是数组时才抛 `TypeError`，因为那是调用方的编程错误，不该被静默吞掉。

```js
// 收进沙箱
await parallelRead(paths, { root: '/srv/repo' });   // 越界 → ESCAPE_ROOT

// 取消整批
const ac = new AbortController();
await parallelRead(paths, { signal: ac.signal });

// 需要精确行数与内容指纹
await parallelRead(paths, { full: true, hash: true });
```

### `readFilesCompat(files, options?)`

对齐 dsh-ops 0.4.1 `ops_read_files` 的入参/出参，用于**原位替换**：

```js
const { readFilesCompat } = require('ops-parallel-read');

const out = await readFilesCompat([
  { path: 'src/a.ts', offset: 1, limit: 200 },
  { path: 'src/b.ts' },
]);
// out.items[0].items → [{ line: 1, path: 'src/a.ts', text: '...' }, ...]
// out.nextIndex / out.status / out.truncated 与原装同义
```

字段逐项对齐原装：`complete` / `nextOffset` / `omitted` / `skipped` / `matched` / `total` / `revision` / `phase` / `effectState` / `nextAction`，错误码 `NOT_FOUND` / `PERMISSION_DENIED` / `ERR_INVALID_ENCODING` / `INVALID_ARGUMENT` 也一致。

单行超过输出预算时按**行内截断**处理：给 `truncatedInLine` + `bytesOmitted` + `bytesTotal`，`nextOffset` 停在原行（与原装一致，否则上层按 `nextOffset` 续读会原地打转）。

这一层还刻意跟原装保持了三处**行为**一致（4.1.3 起）：

- **没有 2 MiB 上限**。原装读 30 MiB 文件带 `offset/limit` 只要 72 ms；替换路径若沿用 native 的 2 MiB 闸门，所有大日志会当场变成 `INVALID_ARGUMENT`。
- **拒绝设备名与备用数据流**：`CON` / `NUL` / `COM1` / `CONOUT$` / `nul.txt` / 尾点 / 尾空格 / `file.txt:stream` 一律 `INVALID_ARGUMENT`。这些名字在 Windows 上不是文件，`NUL` 读出来是空、`CON` 会等控制台输入。
- **不跟随 symlink / junction**（`PATH_RESTRICTED`）：目录联接不需要管理员权限就能把 `repo/link/secret.txt` 变成一个词法合法的路径，读到栏外；原装每级 `open_nofollow`，这里每级 `lstat`（目录链按批缓存，叶子与 `open` 并发）。要放行传 `allowLinks: true`。
- **严格 UTF-8**：非法字节与 UTF-16 一律 `ERR_INVALID_ENCODING`，不做 U+FFFD 有损替换 —— 上层 `ops_edit_file` 按 UTF-8 回写会把混进来的 UTF-16 写坏。native 入口 `strictUtf8` 默认关闭，GBK 仍可降级读。
- **保留 BOM**（4.1.4 起）：原装实测保留文件头的 U+FEFF（首行 `"\uFEFFhello"`，BOM-only 文件 `lineCount=1`）。替换路径跟着保留，返回文本与磁盘逐字节一致；要剥就显式传 `stripBom: true`。

### 其它导出

`runPool(items, limit, worker)`（并发池，可单独复用）、`truncate(text, maxChars)`、`OpsError`、`DEFAULTS`、`TRUNCATED_MARK`。

---

## 参数

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `concurrency` | `10` | 并发槽位上限，同时是 FD 峰值。`readFilesCompat` 下默认取契约上限 32 |
| `maxFileSize` | `2 * 1024 * 1024`（compat 无限） | 单文件字节上限；兼容层对齐原装，默认不设限 |
| `timeoutMs` | `3000` | 单文件**总**预算（覆盖 open/fstat/read/close） |
| `maxChars` | `50000` | 单文件字符上限 |
| `maxTotalChars` | `120000` | 全批字符上限 |
| `chunkBytes` | `65536` | 分块粒度 |
| `closeMs` | `100` | close 等待上限 |
| `encoding` | `'utf8'` | 无 BOM 时的解码方式 |
| `root` | `null` | 路径围栏（opt-in）。先做词法检查，再用 `realpath` 复核 symlink / junction，并打开真实路径 |
| `signal` | `null` | 取消整批。可打断**进行中**的 `open`，不必等到 3 s 超时 |
| `full` | `false` | 读到 EOF（产 `lineCount` / `revision`） |
| `hash` | `false` | 边读边算 SHA-256，仅 `full` 模式生效 |
| `maxOpenRetries` | `2` | `EMFILE`/`ENFILE`/`EBUSY` 退避重试次数 |
| `strictUtf8` | `false`（compat 恒 `true`） | 非法 UTF-8 直接报错，不做有损替换 |
| `allowLinks` | `true`（compat 为 `false`） | `false` 时拒绝 symlink / junction（`PATH_RESTRICTED`） |
| `stripBom` | `true`（compat 为 `false`） | 是否剥掉文件头的 UTF-8 BOM。**compat 默认保留**：原装实测保留 BOM，替换路径剥掉会让上层按返回文本回写时静默丢 3 个字节 |

`maxOutputBytes` 只在兼容层生效，默认 `128 KiB - 1 KiB`，下限 2 KiB。

---

## 性能

同机同盘，每臂 15 轮丢首轮。**v5 相对 v4 的严格对照用同进程交替 80 对**（`tools/ab.mjs`），因为跨进程单轮会有 ±25% 抖动：

| 场景（`readFilesCompat`，真正的替换路径） | v4 (4.0.2) | v5 (4.1.0) | 提升 |
| --- | --- | --- | --- |
| 20 × 2 KB | 1.06 ms | **0.72 ms** | **≈1.4×**（六次 1.2–1.5×） |
| 20 × 16 KB | 0.52 ms | **0.41 ms** | **≈1.28×**（1.25–1.30×） |
| 20 × 64 KB | 0.66 ms | **0.55 ms** | **≈1.19×**（1.17–1.21×） |
| 20 × 1 MB（撞 128 KiB 预算，只读 4–6 个） | 3.13 ms | **3.04 ms** | 1.02–1.06× |

对原装 dsh-ops（spawn worker + 进程内串行读）：

| 场景 | 原装 | 顺序读（无池） | 本包 native | 本包 compat |
| --- | --- | --- | --- | --- |
| 20 × 2 KB | 42.53 ms | 3.09 ms | **0.42 ms** | 0.95 ms |
| 20 × 16 KB | 32.39 ms | 3.17 ms | **0.53 ms** | 0.49 ms |
| 20 × 1 MB | 39.73 ms | 10.85 ms | **1.27 ms** | 3.65 ms |
| 单次调用（1 × 2 KB） | 28.91 ms | — | **0.09 ms** | — |

相对原装 **31×–101×**（native）、**11×–66×**（compat 替换路径）。

`compat` 列的同进程严格 A/B 比这张表更稳（跨进程 15 轮的单次结果会在 0.72–0.97 ms 之间摆，因为进程刚跑过 20 MB 大文件后堆状态不同）：2 KB 上是 **0.72 ms**、16 KB **0.41 ms**、64 KB **0.55 ms**。


这一轮提升来自三处，都是实测驱动、不是猜的：

1. **批大小自适应**（20 × 2 KB 那一行的主要来源）。原来固定 4 个一批，20 个文件要跑 5 轮串行 `await`；现在用"已返回项的平均 JSON 字节"反推剩余预算还装得下几个，第二轮直接发满 32。上限用契约自带的 32（`readFilesCompat` 已限死 1–32 个文件），FD 峰值天然 <= 32。
2. **预算结算去掉一次重复序列化**。`compatItem` 算完字节后把数字带回来，主循环不再对同一个 entry 再 `JSON.stringify` 一遍 —— CPU profile 里 `jsonBytes` 占 12.4%，其中一半是这次重复。
3. **`close()` 的兜底 timer 显式 `clearTimeout`**。原来 `Promise.race([close, sleep(100)])` 的输家不会被取消，20 个文件留 20 个 100 ms 的 timer 在 libuv 堆里。

两件事必须说清楚，否则这些倍数会骗人：

1. 原装的地板是 29–40 ms/次，全是进程 spawn + worker 自检。40 KiB 的批量里它占 68%，跟读文件没关系。
2. 20 × 1 MB 那一行，原装只读了 3 个文件就撞上 128 KiB 输出上限，本包 native 只读到第 50,000 个字符就停（实测读入 1.3 MB vs 20 MB）。这是两者都截断、但截断得更早，不是吞吐更高。

**已经贴到 syscall 地板了**：20 个 2 KB 文件是 80 次 `open`/`fstat`/`read`/`close`，0.72 ms 里 syscall 占 25%、`JSON.stringify` 10%、SHA-256 4%、GC 3.5%，剩下是调度。再压只能改契约（不返回 `revision` 省掉 hash、不返回 `lineCount` 省掉全文扫描），不是改实现。

试过但**放弃**的两条，写在这里免得下一轮重复踩：

- **读满整个文件 + Buffer 级行扫描**（只解码窗口内那 200 行）。2 KB 上是负收益、1 MB 上慢 5%：分配 1 MB buffer 比复用 64 KB 块贵，而 `StringDecoder` 流式解码在并发 4 的场景里被 IO 等待盖住了。真正的瓶颈是 `open`（32.5%），不是解码。
- **小批全同步读**（`statSync` + `readFileSync`）。孤立测 `readFileSync` 比 async 池快 16%，但放进兼容层后 2 KB 反而慢 2%、16 KB 快 9%、64 KB 持平 —— 探测阶段要多扫一遍 `statSync`，而实际只读其中几个文件。为 9% 的局部收益换"阻塞事件循环"不值得。


---

## 变更（4.1.1，第八轮审计）

三个真缺陷，都不是读代码看出来的，是打出来的：

| 缺陷 | 证据 | 修法 |
| --- | --- | --- |
| 兼容层 `concurrency` 传小数（`0.5`）→ **死循环** | `Math.floor(0.5) = 0` → 批大小为 0 → `slice` 为空、`cursor` 不前进，进程被 `timeout` 杀掉（exit 124） | 用归一后的 `opts.concurrency`，并 `Math.max(1, …)` 兜底 |
| `root` 围栏被 **junction / symlink** 穿透 | root 下放一个指向栏外的目录联接，`path.resolve` 算出的 `rel` 是 `link/secret.txt`，看着在栏内，实测读到栏外 `TOP-SECRET` | 词法检查后再 `realpath` 复核，并**用真实路径去 open**（判的和开的必须是同一个） |
| 输出预算削行在**转义密集行**上慢 13 倍 | 1.2 MB 引号文件（3000 行 × 400 个 `"`）：38.62 ms，其中几乎全是"整页 `JSON.stringify` 反复回退" | 每行 JSON 字节改成前缀和（行级小 stringify），精确二分 + 定点校正；同一文件 **2.5–4.8 ms**，且多返回 1 行（149 → 150） |

另修一处响应性缺陷：取消只在 chunk 边界检查，挂在坏盘上的 `open` 会把"已取消"拖到 `timeoutMs`。现在 `signal` 参与 `Promise.race`，并在 `finally` 摘掉 listener（否则 20 个文件往同一个 signal 上挂 20 个闭包）。实测慢 400 ms 的 `open` + 20 ms 取消：**20 ms 返回 `ABORTED`**，晚到的句柄被 `abandoned` 分支关掉。

## 变更（4.1.4，第十一轮审计）

第十一轮全部用**随机 + 不变量**打，不再人工挑用例：240 个随机文件做"逐字节可重建"差分、60 个随机文件 × 随机 offset/limit 对原装 worker 做整包 JSON 差分、154 项新矩阵（路径形态 / 参数形状 / 链接与设备名 / 预算与分页 / 资源健壮 / 真实语料 / 无状态残留）。

- **兼容层剥掉了 UTF-8 BOM**（唯一的内容级缺陷）：原装实测保留 BOM，这里之前首行返回 `"hello"`（磁盘是 `"\uFEFFhello"`），BOM-only 文件 `lineCount` 给 0（原装 1），双 BOM 还被剥两层 —— `TextDecoder` 默认 `ignoreBOM: false`，与显式的 `subarray(3)` 叠加。上层拿返回文本做编辑 / CAS / diff 会按"少了 3 个字节"处理，属于静默写坏。现在 compat 默认保留（`stripBom` 默认按入口区分：native `true`、compat `false`），解码器统一 `ignoreBOM: true`。
- **审计链路自己断过**：`npm run verify` 里 `parity` 遇到"已知可接受差异"也 `exit 1`，于是**后面的 ast 审计与 111 项 e2e 从来没在链路上跑过**。已知差异现在标 `ACPT` 并单独计数，未知差异才 exit 1。
- **ast 规则报的行号被误读**：`swallowed-promise` 的 8 处命中全是 `unhandledRejection` 守卫，各有注释说明；规则现在区分"已说明"与"真静默失败"，两处没注释的补上了理由。

## 变更（4.1.3，第十轮审计：端到端）

第十轮不再读代码猜行为，而是把包 `npm pack` 后装进空目录，用**装好的那份**跑 111 项端到端断言，并把 11 个场景同时喂给原装 worker 逐字段比对（`e2e.mjs`）。

修掉的五个真缺陷：

- **2 MiB 上限被带进兼容层** → >2 MiB 文件（日志、构建产物）在原装能读、在替换后 `INVALID_ARGUMENT`。这是替换后才会暴露的回归。
- **设备名与 ADS 可读** → `NUL` / `CON` / `COM1` / `nul.txt` / 尾点 / 尾空格 / `file.txt:stream` 之前会被当普通文件打开（`NUL` 返回空内容并报 success）。
- **junction 穿透** → 未开 `root` 时，栏内指向栏外的目录联接到栏外文件可正常读出（`TOP-SECRET`），原装是 `PATH_RESTRICTED`。
- **非法 UTF-8 被静默降级** → 原装 `ERR_INVALID_ENCODING`，这里之前返回带 U+FFFD 的正文，等于把乱码喂给上层。
- **CR-only 文件末行丢 `
`** → 原装给 `"a
b
c
"`，这里给 `"a
b
c"`，diff / 编辑按字节比对时会误判。

顺带被自己的二进制闸门抓到一次：审计脚本往源码里写入了两个字面 NUL（`\u0000` 被当转义展开），`parallelRead` 立刻把 `ops_parallel_read.js` 判成 `BINARY_FILE` —— 这条用例现在是常驻回归。

## 变更（4.1.2，第九轮审计）

这一轮不再逐点验功能，而是对**不变量**下手：页内行必须是 `[offset, nextOffset)` 的稠密前缀、输出必须落在预算内、0 字符不占预算。三条全被打破了。

| 缺陷 | 证据 | 修法 |
| --- | --- | --- |
| 窗口内**巨行之后的每一行都被报错一行号**，巨行本身丢失 | 100 条 1KB 行 + 1 条 400KB 行 + 20 条小行：返回 120 条，标称 1..120，实际第 101 条是 `t0`（真值应为 `HHHH…`），巨行从未出现 | 削行时**当场给本页定界**（`winStop`），页恒为稠密前缀；`nextOffset` 指向被挡的那一行，交给 `truncatedInLine` 处理 |
| 行内跨块的巨行会被**拼成「前半段 + 末块」**当完整行交付 | 同上场景，未定界时 `carry` 被预算截断后仍在换行处与尾块拼接 | 同上，定界后该行不再被拼接，整行交给行内截断路径 |
| 错误条目**完全绕过输出预算** | `maxOutputBytes: 2048` + 一条 3000 字符的缺失路径 → 响应 6630 字节 | 错误条目按 `message` 折半缩回预算内；`path` 本身超标时仍然返回（不返回会让 `nextIndex` 原地不动） |
| 预算用尽后**空文件被判 `BUDGET_EXHAUSTED`** | `maxTotalChars: 40` + 一个 0 字节文件 → `error` | 0 字符内容不占预算，先放行 |
| 自定义 `maxOutputBytes` **不扣外层字段** | `maxOutputBytes: 4096` → 响应 4430 字节 | 两个入口统一 `- 1024` 预留外层 |

顺带核对：空文件 `lineCount=0 / items=[] / complete=true` 与原装 worker 逐字段一致（原实现本来就对，是我的参考实现写错了）。

## 已知限制

- **一页放不下的巨行会挡住该文件的分页**。单行 > 128 KiB 时，该页只剩这一条 `truncatedInLine`，`nextOffset` 停在原行（与原装契约一致：文本分页无法取到它的后半段）。此时 `nextAction` 明确要求改用 hex 检视。不要按 `nextOffset` 硬循环 —— 加一层"`nextOffset === offset` 即停"的判断。
- **`revision` 需要读全文**。要 SHA-256 就必须读到 EOF，早停和摘要天然冲突。兼容层为此付 5 ms（20 × 1 MB 场景）的代价。
- **窗口外的巨行仍要扫完**。为了报出准确 `lineCount`，一行 1 MB 且不在返回窗口内时，仍得把它读完才知道下一行的行号。
- **`close()` 卡死时只是放手**。`closeMs` 到点就不再等，FD 由进程回收。这是"坏盘上宁可再生一个句柄，也别拖住整批"的取舍。
- **`parallelRead` 的并发 10 是折中值**。它接受任意长度数组，所以必须自己限 FD；调到 32 会更快一点（约 12%），但那会放大 FD 峰值。`readFilesCompat` 不受此限 —— 那个入口的契约本来就限死 1–32 个文件，所以默认放开到 32。
- **批大小在首轮之外才自适应**。第一轮固定发 4 个，因为此时还不知道文件多大；如果所有文件都是 1 MB 级，这一轮会多读几个（预算不需要的那些）。要精确就得先 `stat` 一遍，那比多读几百 KB 更贵。
- **不支持 UTF-16BE**。见到 `FE FF` 明确报 `UNSUPPORTED_ENCODING`，不猜。
- **早停时 NUL 检测只覆盖已读前缀**。读到 50,000 字符就停是性能核心（2 MB 只需读 ~64–120 KB），代价是"前段干净、后段是二进制"的混合文件会被当成文本返回前段。看 `scannedBytes < size` 即可知道没验全文。
- **`maxChars` 单独调大无效**。单文件读取上限是 `min(maxChars, maxTotalChars)`，要把 `maxTotalChars` 一起调，否则 keep 仍被 120,000 夹住。
- **UTF-16LE 关闭 NUL 闸**。认了 `FF FE` BOM 之后不再用 NUL 判二进制（UTF-16 天然满屏 `\0`），带 BOM 的二进制会当文本解码。
- **二进制判据只看 NUL**。没有 `\0` 的二进制（`0xFF` 填充的固件段、部分加密块）会按文本返回一串 `U+FFFD`，虽被 50,000 字符上限夹住，但仍是噪声。要覆盖这种情况得加 UTF-8 合法性校验，代价是 GBK/拉丁文文件从"降级可读"变成"直接拒绝"——这一轮没做，因为规格指定的是 NUL。
- **`root` 围栏有 TOCTOU 窗口**。`realpath` 与 `open` 之间，重解析点仍可能被换成别的目标。真要抗并发替换得用 `openat`+`O_NOFOLLOW`（Node 没有），或打开后按 FILE_ID 复核。当前实现挡住的是"存量联接"，不是"正在被改的联接"。

---

## 开发

```bash
npm test          # 55 项功能断言
npm run test:edge # 15 项边界断言
npm run test:hunt # 402 项审计矩阵（含 60 组差分模糊 + 真实语料比对）
node hunt-r8.js   # 49 项语义面矩阵（分页收敛 / 全局预算 / 取消延迟 / 围栏穿透）
node hunt-r9.js   # 64 项不变量矩阵（稠密前缀 / 预算契约 / 空文件 / FD 归零）
npm run parity    # 与原装 worker 逐字段差分（9 场景）
npm run bench     # 四臂基准 + 21 项正确性
npm run audit     # ast-grep 规则 + 死代码 + AST 成本量化
npm run hazard    # 危险输入（目录/符号链接/空数组/非字符串）
npm run mem       # 堆占用前后对照（需 --expose-gc）
```

`tools/` 下的规则与脚本只在开发期使用，不进 npm 包，不引入任何依赖。

## License

MIT
