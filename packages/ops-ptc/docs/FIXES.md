# 2.0.8 — 审计数字与围栏回执（2026-10-30）

## A1 `ops_ptc_audit` 的加减行与"改写数"是硬编码的假值（严重）

**现象**：任意两次审计都回 `+0/-0 行，1 处改写`。同一文件跟自己比也是这句；2 行的文件跟 144 KB
的文件比也是这句。

**根因**：`ops_ptc_audit` 为了让 `difftasticAudit()` 有位可坐，塞了一份占位编辑
`[{ startByte: 0, endByte: 0, text: '', before: '' }]`。`addedLines` / `removedLines` 是从 `edits`
的 `text` / `before` 数出来的，于是恒为 `linesOf('') = 0`；摘要把 `edits.length` 当"改写处数"，恒为 1。
真正可信的只有 difftastic 给的 `hunks`。

**修法**：纯审计传 `[]`。`difftasticAudit()` 在编辑清单为空时改从 difftastic 的 `aligned_lines`
推加减行 —— `[lhs, rhs]` 两侧都有、`[null, rhs]` 新增、`[lhs, null]` 删除，比按 chunk 数更准（一个
chunk 里可以同时有改动行与新增行）。difftastic 缺席时退回公共前缀/后缀裁剪的行级对齐，仍不编数字。

**实测**

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 文件与自己比 | `0 hunk，1 处改写，+0/-0` | `0 hunk，+0/-0` |
| 改一行 + 加一行 | `1 hunk，1 处改写，+0/-0` | `1 hunk，+1/-0` |
| 2 行 vs 144 KB | `1 hunk，1 处改写，+0/-0` | `1 hunk，+9001/-0` |

注：difftastic 的对齐把"改动行"算作两侧都有，所以它只计入纯粹的增/删行；`hunks` 仍然标出改动。

## A2 围栏拒绝回执丢模式、错标可重试

- `PATH_RESTRICTED` / `POLICY_DENIED` 的 `sandbox.mode` 一律 `unknown`，而策略此时已解析成功。改为
  报真实 `policy.mode`（`danger-full-access` / `workspace-write`）。
- 不可重试集合只有 `INVALID_ARGUMENT` / `POLICY_DENIED`，于是 `PATH_RESTRICTED`、`CREDENTIAL_DENIED`
  被标 `retryable: true`。同一路径重试只会再撞同一道围栏。四类现在都是 `false`。

## Q1 `ptc_locate` 找不到类方法与表达式体箭头（严重）
## Q1 `ptc_locate` 找不到类方法与表达式体箭头（严重）

**位置**：`dist/ptc/inproc.js`（`DEFINITIONS`、`locateSymbol`）

**现象**：定义模式只有 `function` / `const x = () => { ... }` / `class` / `interface` / `type` 五类。`class Beta { gamma() {} }` 的 `gamma`、`export const epsilon = () => 4` 的 `epsilon` 一律 `E_INPROC_NO_MATCH`。实测同一文件里 `alpha`/`Beta` 命中、`gamma`/`epsilon` 零命中。调用方只能退回 grep + read，一次定位变成三次调用。

**修补**：补三条表达式体箭头模式（含 `async`、含返回类型、无括号单参），并新增 kind 通道 `method_definition` / `public_field_definition` / `pair` + 命名字段正则 —— 方法在 ast-grep 里没有合法的 `$N(...) { }` 模式，只能按 kind 取。修后同一文件五个符号全部命中。

## Q2 `ptc_find` / `ptc_refactor` 只看第一个候选文件

**位置**：`dist/ptc/pipeline.js`、`dist/ptc/tools.js`

**现象**：`everythingFind` 返回候选列表后取 `files[0]`。符号在第二个候选时就报 `E_SANE_SYMBOL_NOT_FOUND`。实测 `src/` 下 `a.ts` 排第一、`r1` 在 `ref.ts` 里，一次本该成功的 preview 直接失败。`ptc_find` 同病，且 `symbol` 是必填 —— 纯文件发现做不到。

**修补**：先用子串把候选缩到真正提到该符号的文件（≤8 次读），再逐个 `saneLocate`（≤3 次），命中即停；`symbol` 改为可选，缺省时返回匹配文件列表。

## Q3 Everything 索引滞后被报成「零命中」

**位置**：`dist/ptc/stages.js`（`everythingFind`）

**现象**：es 索引异步建立。新建目录/文件在索引里尚不存在时，`everythingFind` 抛 `E_EVERYTHING_NOT_FOUND` —— 盘上明明有。实测新建 `ws/src/` 后 `query: a.ts` 熔断，几秒后才正常。

**修补**：零命中时按 query 的 basename 正则 + 扩展名做一次有界 walk（2000 文件 / 500ms），过滤重解析点后作为兜底候选；只有兜底也空才熔断。

## Q4 回执路径三种口径，`file` 只给 basename

**位置**：`dist/ptc/inproc.js`、`dist/ptc/pipeline.js`、`dist/ptc/tools.js`

**现象**：`locate`/`find` 给绝对路径（Windows 反斜杠），`refactor`/`inproc`/`audit` 只给 basename。`src/inp.ts` 回成 `inp.ts`，模型拿它当下一次调用的 `file` 会解析到 cwd 根 —— 一次成功的定位变成一次 NOT_FOUND。`find.lines` 还是 0 基，`locate.lines` 是 1 基。

**修补**：引擎回执统一给绝对路径，宿主适配层折成「cwd 相对 + POSIX」（`lib/file/ptc-inproc.js` 的 `present()`）；`find.lines` 改 1 基。

## Q5 枚举时每个候选一条 lstat 链

**位置**：`dist/ptc/reparse.js`

**现象**：`reparseEscape` 从叶子逐级 `lstat` 到卷根。一次 32 候选的树级 locate 要付 32 × 路径深度 次 `lstat`，是整条枚举路径上最贵的一段。

**修补**：先做一次 `realpathSync.native`，解析结果与请求串相同即证明链上没有重解析点，直接放行；只有不同（真链接、8.3 短名、大小写）才落回 lstat 链，那时它还有活干 —— 指出是哪一级。

# 本地修补 — ops-ptc 2.0.5

并入 dsh-ops 后审计出四类缺陷，全部在本机复现并修完。

## P1 重解析点逃逸（严重）

**位置**：`dist/ptc/inproc.js`（`narrow` / `inprocLocate` / `inprocRefactor` 的读取点）、新增 `dist/ptc/reparse.js`

**现象**：引擎用 `statSync` + `readFileSync` 直接读调用方给的名字。工作区内放一个 junction 指向栏外，`ws/link/leak.ts` 在词法上完全在栏内、过得了凭据围栏（名字里没有凭据）也过得了锚定，内核在 open 时才把 `link` 解析到别处。实测：`ptc_locate`、`ptc_inproc` 都能读到栏外文件并返回符号。

**修补**：新增 `reparseEscape(target)`，从叶子逐级 `lstat`（遇到卷根停止），命中任何 symlink/junction 即返回该组件。三个读取点在读之前调用，命中则跳过；宿主适配层对调用方**点名**的路径另有一道，返回 `PATH_RESTRICTED` 而不是静默跳过。

## P2 `esPath` 永远解析不到 vendor

**位置**：`dist/ptc/proc.js`

**现象**：`defaultConfig` 把 `esPath` 定为字面量 `'./es.exe'`。它带路径分隔符，spawn 时按进程 cwd 相对解析，于是候选清单里本该命中的 `vendor/es.exe` 根本没被走到——`ptc_find` / `ptc_refactor` 稳定报 `E_BIN_MISSING: 找不到可执行文件: ./es.exe`，即使二进制就在包里。

**修补**：新增 `pickExistingEs()`，按 `esCandidates()` 的顺序挑第一个**存在**的绝对候选；裸命令名（`es`、`es.exe`）保持原样交给 PATH。`defaultConfig` 改用该函数。

## P3 `ptc_locate` 默认不扫 JavaScript

**位置**：`dist/ptc/inproc.js`（`inprocLocate` / `inprocRefactor` 的 `ext` 默认值）

**现象**：`req.ext ?? ['ts', 'tsx']`。一个纯 `.js` 的库里 `ptc_locate` 枚举零命中，报 `E_INPROC_NO_MATCH`——但它自己的 `langOf()` 明明支持 `.js`。实测在 dsh-ops 里定位一个 `.js` 里的函数，只枚举到 13 个 `.ts` 候选，直接报「未找到」。

**修补**：默认扩展名改为 `['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']`。同一查询修复后枚举 154 个文件、命中 1 处、220 ms。

## P4 `ptc_find` 把目录当文件读

**位置**：`dist/ptc/stages.js`（`everythingFind`）

**现象**：`es.exe` 的索引里目录也是条目，`-path <root>` 加子串查询会把 `node_modules/@dsh-ops` 这种目录吐出来，流水线随后拿它当文件：`E_SANE_UNSUPPORTED_LANG`，`不支持的文件类型: `（扩展名为空）。

**修补**：候选在进入流水线前统一 `stat().isFile()` 过滤，并用同一 `reparseEscape` 去掉重解析点（索引是历史数据，早先建的链接照样能被命中）。

## 附带：`vendor/es.exe`

包内新增 `vendor/es.exe`（Everything CLI 1.1.0.38，262 KB），`esCandidates()` 的第三顺位正好是这个路径，装上即可用，不再需要手工摆二进制。`package.json` 的 `files` 已加 `vendor`。

## 验证

| 用例 | 修补前 | 修补后 |
| --- | --- | --- |
| 工作区内 junction 指向栏外（locate / inproc） | 读到栏外符号 | `PATH_RESTRICTED` |
| `ptc_locate` 找 `.js` 里的 `invokePtc` | `E_INPROC_NO_MATCH`（13 候选） | 命中 1 处，220 ms |
| `ptc_find {query:'ptc-inproc.js'}` | `E_BIN_MISSING` | 命中 1 处，186 ms |
| `ptc_find {query:'dsh-ops'}`（名称查询，无同名文件） | `E_SANE_UNSUPPORTED_LANG`（把目录当文件） | `E_EVERYTHING_NOT_FOUND`（诚实的零命中） |
| `ptc_audit` 自比对 | ok | ok，0 hunk / 1 处改写 |

## 未修（已确认为设计取舍）

- `ptc_find` 的 `query` 是**文件名**查询，不是仓库名；`*.js` 这类通配会取排名第一的文件并在符号不存在时报 `E_SANE_SYMBOL_NOT_FOUND`，不会顺延到下一个候选。要跨文件找符号用 `ptc_locate`（它枚举 + 扫描）。
- `pipeline.js` 的 CLI 入口（`pipeline.js:210`）仍然把 `--es` 缺省值当字面量，只影响命令行用法，不影响宿主内的五个工具。

## R12 inputSchema 描述瘦身

**位置**：`dist/ptc/tools.js`（五个工具各自的 `inputSchema`）

**现象**：五个 schema 合计 2,588 B。这些字节不是「调用一次才算」，它们进的是**每一轮请求**
的常驻工具面：描述越长，每轮对话都在为同一段说明付 token。

**修补**：把 `inputSchema` 里重复的默认值、举例和长括号压成关键词，类型、`enum`、`required`
一个不动，工具的 `description` 也不动（保留给首次选择工具时的语义）。

**数字**：`2,588 B → 2,328 B`（−260 B，−10%），计 640 token。同一批入参在新 schema 下仍全部
通过引擎校验（`mode=apply|preview`、`strategy=auto|walk|everything`、`required` 缺失即
`E_BAD_ARGS`）。


## 2.1.0 — 命中正文附赠 / 回执体积闸门 / 字段瘦身 / 引擎懒加载

### L1 `ops_ptc_locate` 附赠命中正文

`locate` 本来就已经把符号体读进内存，算出行区间后又把它丢掉，于是模型必须再调一次
`ops_read_files` 把同一段字节买第二遍 —— 而那次调用要重发整个上下文。

- 新参数 `body`: `true`/缺省 = 总字节 ≤ 8 KiB 才附；`false` = 只给行号；数字 = 自定义额度
  （上限 32 KiB）。
- 不附时给 `bodyOmitted` 与 `readHint`（`{tool:"ops_read_files", files:[{path,offset,limit}]}`，
  约 70 B）：把第二轮从"自己算 offset 试错"变成"照抄参数"。
- 实测：`trimReceipt`（40 行 / 1583 B）→ 1911 B 一次到位；`invokeTrusted`（182 行 / 12.7 KB）
  → 不附，回执 473 B + readHint。

### L2 回执体积闸门（适配层，24 KiB）

引擎的回执形状是它自己的事：`locate` 现在会附正文，`refactor` 的 hunk 数也没有上界。超出
上下文预算时模型看到的是被上游切开的半截 JSON，比一个明确的"还有多少没给"糟得多。降级顺序：

1. 先退正文（唯一"可以再买一次"的字段），并补 `readHint`；
2. 再按稠密前缀削 `hits`/`files`/`edits`，报 `${key}Omitted` 与 `nextOffset`；
3. 最后整体让位，只留 `hitsOmitted` 与 `receiptTruncated`。

### L3 命中字段瘦身

删掉模型从不据此决策的自报口径：`chars`、`bodyBytes`、`fileBytes`、`savedRatio`，以及回执
顶层的 `contextBytes`（自报 JSON 体积，纯诊断）。每命中省 82 B ≈ 21 tok。`ops_ptc_find` 的
`savedTokensRatio` 同步删除。

### L6 引擎懒加载（启动成本）

`ptc-engine` 一被 require 就把 `@ast-grep/napi`（原生 .node）拉进进程。此前
`capabilities/file.js` 为了读 `inputSchema` 直接 require 引擎，而该模块在每个会话启动时都被
import —— 于是从没调过 PTC 工具的会话也在付这笔账。实测 **19.01 ms**。

- 新增 `dist/ptc/schema.json`（由 `tools.js` 的 inputSchema 生成），宿主侧只读这份 JSON。
- `file/ptc-inproc.js` 的引擎引用挪到首调用。
- 实测启动导入 **19.01 → 4.56 ms**，且 `@ast-grep/napi` 不再出现在启动期 require 缓存里。

## 2.1.1 · 引擎自持与写盘闸门

### D8 `checkedWrite` 会把未解析的 ast-grep 占位符写进源码（已修，真事故）

`proc.js` 的七个函数被改成了 `function safeStr($$$) { try {` 这种形状：函数体压成单行、
`async` 一起丢掉。`require('./proc')` 直接抛 `await is only valid in async functions`，
于是 `pickBin` / `run` / `readRange` 全部不可用 —— `ops_ptc_find` 与 `ops_ptc_refactor` 的
枚举段整体失效。`ptc_locate` 走 inproc 分支，所以这个破损在此前几轮审计里一直没被撞上。

成因是改写模板里的 `$$$`（ast-grep 的多节点占位符）没被解析就随 `after` 落盘。闸门加在
`checkedWrite` 的最前面，在拿锁之前：

```js
const PLACEHOLDER_LEAK =
  /function\s+\$\$\$|class\s+\$\$\$|=>\s*\$\$\$|\(\s*\$\$\$\s*[,)]|(?:const|let|var)\s+\$\$\$\s*=/;
```

命中即 `E_INPROC_UNRESOLVED_PLACEHOLDER`，不写盘、不留锁、不建临时文件。占位符只可能出现在
字符串字面量里（`inproc.js` 的 pattern 数组就是），一旦落在声明名或参数位就必然是污染，与任何
合法源码零重叠 —— 实测改写 `function a(y){return y+1}` 正常通过，写成 `function a($$$)` 被拒。

### D9 `engineLoad` 双锚点：依赖被重装清空也不影响可用性

`dsh-ops/package.json` 的 `dependencies` 是 `null`，一次 `pnpm install` 就会清掉
`dsh-ops/node_modules`，语法包随之消失，工具报 `E_ENGINE_UNAVAILABLE` —— 而包还好端端躺在
`vendor/deps` 里。新增 `dist/ptc/engine-load.js`，按顺序试两个锚点：

```js
const ENGINE_ANCHORS = [
  path.join(PACKAGE_ROOT, 'package.json'),
  path.join(PACKAGE_ROOT, 'vendor', 'deps', 'package.json'),
];
```

`astdiff.js` / `inproc.js` / `pipeline.js` 的 `require('@ast-grep/napi')` 全部改走
`require('./engine-load').napi`。第一个锚点命中时行为与旧版逐字节一致；只有 nested 缺失才回退，
回退路径零成本（`anchors` 缓存，一次 `createRequire`）。

实测（把 `lib` + `vendor` + `package.json` 拷到干净目录，不带 `node_modules`）：

```
nested: 不可用（符合预期）
vendor 兜底 ptc: ok hits= 1
```

### D10 `ptc_find` 在上游零命中时补 walk 重扫

Everything 索引「部分陈旧」—— 命中了旧文件、漏了刚建的文件 —— 会让枚举非空，零命中兜底因此
不触发，工具报「符号不存在」，而文件明明就在盘上。`inproc.js` 的 locate 主体改成 `for (let pass = 0; ; pass++)`，
`retryViaWalk()` 只在 `pass === 0 && req.file === undefined && locate.via === 'everything'` 时
为真，第二遍强制 `walk` 并 `refresh`。成功路径一分不付。

| 项 | 值 |
| --- | --- |
| 包体积 | 200,212 B → 约 203 KB（+`engine-load.js`，+1.5%） |
| 首调用引擎加载 | 不变（惰性） |
| 常驻 schema | 不变（`safe-write` / `engine-load` 不进工具面） |
| 破坏场景 | `proc.js` 语法错 → 已还原并加闸门 |

