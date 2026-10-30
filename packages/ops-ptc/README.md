# ops-ptc

> **2.1.1**：修一个真事故 —— `proc.js` 的七个函数曾被改写成 `function safeStr($$$) { try {`
> 并压成单行，`async` 一起丢掉，模块直接加载失败，`ops_ptc_find` / `ops_ptc_refactor` 枚举段
> 整体不可用。`checkedWrite` 现在先过一道占位符闸门（`E_INPROC_UNRESOLVED_PLACEHOLDER`），
> 未解析的 `$$$` 不落盘。另加 `engine-load.js` 双锚点，`pnpm install` 清空 `node_modules` 后
> 从 `vendor/deps` 回退，不再报 `E_ENGINE_UNAVAILABLE`。详见 [FIXES.md](FIXES.md)。
>
> **2.1.0**：`ops_ptc_locate` 附赠命中正文（≤8 KiB 直给，超限给 `readHint` 抄参数），省掉一整轮
> 上下文重发；回执加 24 KiB 闸门，超了先退正文再削命中并给 `nextOffset`；命中删掉 5 个自报字段
> （−82 B/命中）；引擎改为首调用懒加载，会话启动导入 **19.01 → 4.56 ms**。详见 [FIXES.md](FIXES.md)。
>
> **2.0.8**：`ops_ptc_audit` 的 `+/-` 行数不再恒为 0、"处改写"不再恒为 1（改用 difftastic 的
> `aligned_lines`）；围栏拒绝回执报真实 `sandbox.mode`，`PATH_RESTRICTED` / `CREDENTIAL_DENIED`
> 改为不可重试。详见 [FIXES.md](FIXES.md)。
>
> **2.0.6**：五个工具的 `inputSchema` 描述瘦身 `2,588 B → 2,328 B`（−10%）。常驻工具面每轮都在付
> 这段字节，语义、`enum`、`required` 不变。详见 [FIXES.md](FIXES.md)。

进程内 AST 重构引擎，提供 CLI、MCP stdio 和独立的 DSH Tool adapter。安装 `ops-ptc` 会安装 `@ast-grep/napi` 与生产依赖 `typescript`。`strategy: walk` 且不开 strict 时不依赖外部命令；Everything、strict 对账和旧 pipeline 会启动子进程。

2.0.5 的包精简与正则预编译、2.0.3~2.0.4 的重复解析/模板展开/pipeline 优化，以及 2.0.0 以来的四版累计改动与冷热对照，全部并入 [PERFORMANCE_CUMULATIVE.md](PERFORMANCE_CUMULATIVE.md)；2.0.1 的审计与修复见 [AUDIT_REPORT.md](AUDIT_REPORT.md)；这些约束继续保留。分组报告（PERFORMANCE_ROUND2/3/4.md）、SMALL_TREE.md 与 `audit/*.json` 原始样本只留在仓库，安装包不再携带。宿主接线见 [HOST_INTEGRATION.md](HOST_INTEGRATION.md)。性能数字来自保存版本的串行交替测量，不作为其它环境的性能保证。

安装包只含 `dist/`、`package.json` 与上面四份文档：不含基准样本、脚本、旧构建或源码。

```bash
npm i ./ops-ptc-2.0.5.tgz   # 本地验证包；未发布 registry
npx ops-ptc locate   --symbol getValidRequestBody --roots src
npx ops-ptc refactor --pattern 'return $A' --rewrite 'return ($A);' --symbol getValidRequestBody --mode preview
```

三层职责；表中耗时来自历史单机样本：

| 层 | 实现 | 代价 |
| --- | --- | --- |
| 寻址 | `readdirSync` 递归；工作区根自动切 Everything `es.exe`（可选） | 小树 2.7 ms / 大树 577 ms |
| 改写 | `@ast-grep/napi`：`parse` → `findAll` → `replace` → `commitEdits` | 单文件 1.5 ms |
| 审计 | `auditAst()`：区间外逐字符零改动 + tsc `parseDiagnostics` 增量 + 节点计数 | 2.6 ms |

## 分级寻址（`strategy: auto`）

两种枚举的固定成本差两个数量级，所以不能一刀切：

| 策略 | 606 文件 | K:/ai（27,839 源码） | 说明 |
| --- | --- | --- | --- |
| `walk` | **18 ms** | 250 ms 预算内只走到 133 个文件；不限时走到底 10.7 s（12,001 触顶） | 天然跳过 `node_modules` |
| `everything` | 163 ms | **577 ms** | 固定 IPC 成本，与规模无关 |
| `auto` | **21 ms** | **585 ms** | 两边都取到各自最优，不额外付代价 |

`auto` 的判据很便宜：根目录里有 `node_modules`，或「目录深度 ≤3 且子目录 ≥10」⇒ 工作区根，直接上 es；否则走进程内，并留 250 ms 时间预算兜底，超时立刻改走 es。

`strategy` 显式传 `walk` / `everything` 可以绕过自动判断。auto 是启发式选择，目录布局、索引状态、缓存与查询完整性会改变结果；历史样本不足以确定通用文件数交叉点。

一个必须知道的坑：`!path:node_modules` 排除语法只在 Everything 1.5+ 生效，1.4 的 `es.exe` 会把它当普通词、原样把依赖目录计进来。所以 es 拿回的路径一律在 JS 侧再过一道正则——对 10 万条路径是微秒级，比赌版本可靠。

## 两个引擎

| 引擎 | 入口 | fork 次数 | 适用 |
| --- | --- | --- | --- |
| **`inproc`** | `ops_ptc_inproc` / `ops_ptc_locate` / `inprocRefactor()` | walk + 非strict为0；Everything或strict另起进程 | 单文件、千级文件；TS / TSX / JS / JSX / HTML / CSS |
| `pipeline` | `ops_ptc_refactor` / `runRefactorPipeline()` | 4 | 万级文件、其它语言、需要 difftastic 语法审计 |

同一棵树（606 个文件 / 4.11 MB）实测同样的改写：

| 形态 | 中位 | 语法审计 | 相对五段 |
| --- | --- | --- | --- |
| `inproc`（默认） | **3.72 ms** | 进程内 tsc `parseDiagnostics` | 67x |
| `inproc` + `strict` | 56.14 ms | 上者 + `sg` CLI 命中数对账 | 4x |
| `pipeline` 五段 | 251 ms | difftastic 子进程 | 1x |

该历史 fixture 的三种路径曾输出逐字节一致。该比较包含不同枚举、预筛、审计和运行时预热成本，不能把全部差异归因于 fork。当前版本以独立的固定 fixture 复测为准。
完整对照与决策表见仓库内 SMALL_TREE.md §10–§11（安装包不含）。

## 五段去哪儿了

`inproc` 不是另一套算法，是同一套 ast-grep 换了个运行位置。逐段映射：

| 五段 | `inproc` 对应物 | 为什么能省 |
| --- | --- | --- |
| 1 Everything | `readdirSync` 遍历 | 小树上索引查询反而是 139 ms 的固定成本 |
| 2 S.A.N.E. | `parse()` + 定义 pattern 命中符号 | 同一棵 AST，省掉一次进程 |
| 3 ast-grep 改写 | `SgNode.replace()` + `commitEdits()` | 同一个 Rust 核心，走 addon 而非 CLI |
| 4 AgentBox | `commitEdits` + 临时文件 `rename` | **没有字符串拼接，就没有转义**，比 base64+stdin 更彻底 |
| 5 difftastic | `auditAst()`：区间外零改动 + tsc 解析诊断增量 | 两次 parse 共 2.6 ms，不落 tmp 不读 JSON |


## 拓扑

```
es.exe ─路径数组→ SANE ─{startByte,endByte,lang}→ ast-grep
      ─Edit[]{startByte,endByte,text,before}→ 内存候选 + AST/difftastic审计 → AgentBox(stdin)
      ─{hunks,added,removed,language}→ 极简 JSON（<1KB）→ 模型
```

| 段 | 进程 | 职责 | 失败码 |
| --- | --- | --- | --- |
| 1 Everything | `vendor/es.exe` | 索引级寻址，按 cwd 内 + basename 精确度重排序 | `E_EVERYTHING_NOT_FOUND` / `E_EVERYTHING_IPC` |
| 2 S.A.N.E. | `ast-grep` | AST 定义 pattern 命中符号体，只读该字节区间 | `E_SANE_SYMBOL_NOT_FOUND` / `E_SANE_AMBIGUOUS` |
| 3 ast-grep | `ast-grep` | 结构化匹配 + 重写，严格锁在符号区间内 | `E_ASTGREP_NO_MATCH` / `E_ASTGREP_OVERLAP` |
| 4 AgentBox | `node agentbox.worker.cjs` | base64 载荷走 stdin，pre-image 哈希校验，临时文件 + rename 原子替换 | `E_AGENTBOX_REJECTED` / `E_AGENTBOX_HASH_MISMATCH` |
| 5 difftastic | `difft` | 语法级 diff，忽略格式差异，返回 hunk 与语言判定 | `E_DIFF_FAILED` / `E_DIFF_EMPTY` |

当前 pipeline 先在内存生成候选并进行可用语言的解析诊断及 difftastic 审计，再交给 worker 提交。已确认提交后的异常会尝试 hash 守护回滚；回滚失败不能当作已经恢复。多文件 inproc 先审计全部候选，但顺序提交不是事务，写入错误通过 `committed` / `partial` 报告。

## 三条硬约束

1. **无 shell**：`spawn(bin, argv, { shell: false })`，参数数组直进 `CreateProcess`，引号/大括号/`%`/`^` 全部失效。
2. **载荷只走 stdin**：代码片段 base64 编码后塞进 `stdin.write()`，不经任何字符串拼接层。
3. **字节偏移不是字符偏移**：`ast-grep` 的 `byteOffset` 是 UTF-8 字节；中文源码用 `string.slice` 会切坏字符。

## Windows 专有处理

| 坑 | 处理 | 位置 |
| --- | --- | --- |
| `es.exe` 输出 CRLF，`\r` 残留进路径 | `split(/\r?\n/)` + 逐行剥 `\r` + 剥 BOM | `src/ptc/proc.ts` `toLines()` |
| 补丁里的 `\n` 与文件 EOL 不一致，整文件 diff 噪声 | `detectEol()` 探测后 `normalizeEol()` 回填 | `src/ptc/proc.ts` |
| `es.exe` 不在 PATH，`./es.exe` 随 cwd 漂移 | `esCandidates()` 候选链：显式配置 → `<cwd>/vendor` → 包内 `vendor/` → Everything 安装目录 → PATH | `src/ptc/proc.ts` |
| `ast-grep` / `ast-grep.exe` / `sg` 三套命名 | `pickBin()` 逐个探 PATH × 扩展名 | `src/ptc/proc.ts` |
| difftastic ≥0.60 用 `--display json` 且要 `DFT_UNSTABLE=yes` | 显式传 `env`，父进程环境不受污染 | `src/ptc/stages.ts` |

## 用法

```bash
npm i
npm run verify        # typecheck + build + smoke + MCP smoke，全绿才算完
```

CLI：

```bash
node dist/ptc/pipeline.js \
  --query "*.ts" --symbol login \
  --pattern "return true" --rewrite "return false" \
  --mode preview        # 只审计不落盘；去掉即 apply
```

MCP stdio server：

```bash
node dist/ptc/mcp.js    # NDJSON JSON-RPC，stdout 只有协议帧，日志走 stderr
```

## 对外契约

五个工具。MCP 直接公开工具列表；原包 discovery 不会自动装载本包工具，需宿主显式注册。

| 工具 | 作用 | 必填 |
| --- | --- | --- |
| `ops_ptc_refactor` | 五段全跑（或 preview） | `symbol` `pattern` `rewrite`，无 `file` 时需 `query` |
| `ops_ptc_find` | 寻址 + 符号切片，只读 | `query` `symbol` |
| `ops_ptc_audit` | 两个文件的结构 diff，只读 | `file` `beforeFile` |
| `ops_ptc_inproc` | 进程内 AST 改写与审计 | `pattern` `rewrite` |
| `ops_ptc_locate` | 进程内符号定位 | `symbol` |

返回值固定形状（成功）：

```json
{
  "status": "ok", "mode": "apply", "file": "test3.js", "symbol": "runTool",
  "hunks": 1, "addedLines": 1, "removedLines": 1,
  "summary": "test3.js：1 个语法 hunk，1 处改写，+1/-1 行（TypeScript）",
  "stages": ["everything", "sane", "astgrep", "difftastic", "agentbox"],
  "savedTokensRatio": 0.87, "ms": 412
}
```

失败固定形状：`{status:"error", code, stage, message, mode, stages, rollback}`。`code` 即熔断原因，不抛栈、不回显源码。

## 变更（2.1.0，命中正文附赠 / 回执闸门 / 字段瘦身 / 引擎懒加载）

**A. `ops_ptc_locate` 附赠命中正文。** `locate` 本来就把符号体读进了内存，算出行区间后又把它丢掉，
于是模型必须再调一次 `ops_read_files` 把同一段字节买第二遍 —— 而那次调用要重发整个上下文。

| `body` | 行为 |
| --- | --- |
| `true`（缺省） | 命中总字节 ≤ 8 KiB 时随 `hits[].body` 返回 |
| 数字 | 自定义额度（上限 32 KiB） |
| `false` | 只给行号 |

不附时给 `bodyOmitted` 与 `readHint`（`{tool:"ops_read_files", files:[{path,offset,limit}]}`，约 70 B），
把第二轮从「自己算 offset 试错」变成「照抄参数」。实测：40 行 / 1583 B 的符号 → 1911 B 一次到位；
182 行 / 12.7 KB 的符号 → 不附，回执 473 B + `readHint`。

**B. 回执体积闸门（适配层 24 KiB）。** 引擎的回执形状是它自己的事，但超出上下文预算时模型看到的是
被上游切开的半截 JSON。降级顺序：先退正文并补 `readHint` → 再按稠密前缀削 `hits`/`files`/`edits` 并报
`${key}Omitted` 与 `nextOffset` → 最后只留计数。实测 27 KB 输入 → 943 B。

**C. 命中字段瘦身。** 删掉模型从不据此决策的自报口径：`chars`、`bodyBytes`、`fileBytes`、
`savedRatio`，以及回执顶层的 `contextBytes`。每命中省 82 B ≈ 21 token；`ops_ptc_find` 的
`savedTokensRatio` 同步删除。

**D. 引擎懒加载。** `ptc-engine` 一被 `require` 就把 `@ast-grep/napi`（原生 `.node`）拉进进程；
而 `capabilities/file.js` 为了读 `inputSchema` 直接 require 引擎，该模块在每个会话启动时都被 import ——
从没调过 PTC 工具的会话也在付这笔账。实测 **19.01 ms**。改为 `dist/ptc/schema.json` 单独承载
`inputSchema`（纯数据），引擎引用挪到首调用：**19.01 → 4.56 ms**，启动期 require 缓存里不再有
`@ast-grep/napi`。

## 变更（2.0.8，审计数字与围栏回执）

**A. `ops_ptc_audit` 的行数统计此前是假的。** 工具把一份占位编辑塞进审计管线（`startByte: 0`、长度 0），
于是 `addedLines` / `removedLines` 恒为 0，摘要里的"N 处改写"恒为 1。实测：同一文件比对报
`+0/-0，1 处改写`，9000 行新增的文件之间的比对也报 `+9000 行以外` 同样的 `+0/-0`。现在纯审计
（无编辑清单）从 difftastic 的 `aligned_lines` 取真实加减行，difftastic 缺席时退回"公共前缀/后缀
裁剪"的行级对齐，都不再编数字。改后：同文件 `+0/-0`，改一行加一行 `+1/-0`，2 行 vs 144 KB
`+9001/-0`。

**B. 围栏拒绝回执丢了模式。** `PATH_RESTRICTED` / `POLICY_DENIED` 的 `sandbox.mode` 一律写
`unknown`，而策略明明已经解析成功 —— "被哪一档拦下"这条信息当场丢失。现在报真实 `policy.mode`。

**C. 不可重试的拒绝被标成可重试。** 此前只有 `INVALID_ARGUMENT` / `POLICY_DENIED` 是
`retryable: false`；`PATH_RESTRICTED` 与 `CREDENTIAL_DENIED` 被标成 `true`，模型照着重试只是把
同一次拒绝再买一遍。现在四类都是 `false`。

## 接入 dsh-ops

2.0.3 保留独立 Tool adapter：从 `ops-ptc/tools` 导入 `registerHostTools`，传入插件当前作用域的 `ctx.tools`、`opsPtcAddition` 和宿主实现的可信 `HostBridge`，返回卸载清理函数。

`opsPtcAddition` / `opsPtcDiscoveryEntry` 是自定义元数据，原包 `dsh-ops` 的固定 discovery registry 不会自动加载它们。**在 dsh-ops 0.5.0 上这条桥已经接上了**：五个工具进 `NATIVE_RESIDENT_FILE_TOOLS`，经 `lib/file/ptc-inproc.js` 注册为常驻工具，`lib/ptc-engine/` 就是本包的 `dist/ptc/`（逐文件 sha256 一致）。围栏顺序是「策略解析 → 写意图 → 凭据名 → 词法锚点 → 重解析点 → 真实路径锚点 → 真实路径凭据」，缺 session / policy 时关闭执行，裸 handlers 不提供宿主权限边界。

真实原包 Outcome schema、ToolDefinition 静态类型和 ToolRuntime 注册/执行/清理已通过兼容测试。路径策略、凭证隔离、取消及授权重验由宿主实现，详见 [宿主接入与验证边界](HOST_INTEGRATION.md)。

MCP stdio 入口为 `node dist/ptc/mcp.js`；使用 MCP 也不会自动继承原包的权限实现。

## 已验证

`npm run verify` 覆盖：

- ① 正常改写落盘 ② pattern 零命中熔断 ③ 符号不存在熔断 ④ Everything 零命中熔断
- ⑤ 补丁落地且标点不丢 ⑥ CRLF + 中文源码偏移无损 ⑦ preview 不写盘
- MCP：initialize / tools-list 五工具 / tools-call / 无效协议帧 / EOF / 资源约束
- 独立回归：改写、快照写入、worker、协议和pipeline；实际OPS契约与生产tarball安装另行验证

## Bench

`npm run bench`（见 [BENCH.md](BENCH.md)，数字现场跑出，未手改）：

| 维度 | 对照 | 结果 |
| --- | --- | --- |
| 寻址 | Everything vs 递归全量枚举（`K:/ai`，135 万文件） | 12–17 s → ~140 ms（**84–124x**） |
| 寻址 | Everything vs 递归早停 | 48 ms → 148 ms（**0.33x**，小树里早停更快） |
| 上下文 | SANE 切片 vs 候选集全读 | 284 KB → 81 B（**99.97%**） |
| 正确性 | ast-grep vs 正则 | 正则 3 处命中、把 2 处字符串字面量改坏；AST 1 处、字面量完好 |
| 端到端 | preview（含 difftastic） | 中位 **290 ms**，返回 259 B |

Everything 是**固定成本**（每次一个 es.exe 进程 + IPC，约 135 ms，与索引规模无关），递归是**线性成本**。所以它赢在「必须全量枚举」或「树大到早停也走不动」的场景，输在「小树 + 只要头几个」——这个交叉点不隐瞒，BENCH.md 里两个根目录都给了数。

### vs 原生路线

[VS_NATIVE.md](VS_NATIVE.md)（`npm run bench:vs`）在同一棵真实仓库树（606 个 `*.ts`/`*.tsx`，4.1 MB）上把三条路并排跑：

| 维度 | 原生（ops_glob / ops_read_files 等效） | PTC | 差距 |
| --- | --- | --- | --- |
| 枚举 606 文件 | `fs.globSync` 11.9 ms / 手写递归 3.4 ms | es 132.8 ms | 这棵树原生快 11–40x（es 是固定成本） |
| 枚举 135 万文件 | 12.4 s | ~140 ms | PTC 快 **84x** |
| 定位一个符号 | 读 606 文件 = 4.11 MB 进上下文 | 切 771 B | 上下文差 **5331x**（省约 114 万 tokens） |
| 改写一个真实函数 | 0.44 ms，整文件正则改 6 处 | 288 ms，锁符号域改 4 处 | 同作用域下两边输出**逐字节一致** |

该历史样本不足以推导通用文件数交叉点；当前选择需同时看目录布局、查询完整性、缓存与索引状态。

### 小树：进程内引擎

SMALL_TREE.md（`npm run bench:small`）测了 606 文件树上所有可能架构：

| 做法 | 中位 | 结论 |
| --- | --- | --- |
| `inprocRefactor`（进程内 napi） | **0.63 ms** | 单文件改写，上下文 246 B |
| 原生 `readFile + 正则 + writeFile` | 0.22 ms | 时间地板，但没有 AST 保证 |
| `ast-grep -U` 单进程 | 45.2 ms | 一次 fork 的代价 |
| PTC 五段（现状） | 291.1 ms | 四次 fork 的代价 |
| 全树 `parse` 不预筛 | **447.4 ms** | 反例：小树上最贵的操作 |
| 20 文件逐一起进程 | **936.6 ms** | 反例：vs 单次调用 55.5 ms（17x） |

三个反模式：小树上用 Everything、全树 parse、逐文件起进程。

## 目录

```
src/ptc/proc.ts           spawn 唯一出口 + CRLF/BOM/EOL 收口 + es 候选链
src/ptc/stages.ts         五段实现
src/ptc/pipeline.ts       编排、熔断、回滚、CLI
src/ptc/agentbox.worker.cjs  唯一落盘进程（stdin JSON → 原子 rename）
src/ptc/inproc.ts         进程内 AST 引擎（@ast-grep/napi，零 fork）
src/ptc/tools.ts          tools_addition + discovery entry
src/ptc/mcp.ts            MCP stdio 适配（在途请求 drain 后才退出）
scripts/smoke.mjs         端到端 7 例（在 .sandbox 副本上跑，不碰原文件）
scripts/mcp-smoke.mjs     MCP 协议级 5 例
scripts/inproc-smoke.mjs  进程内引擎 9 例（与五段逐字节对比 / 中文 CRLF / 熔断）
bench/bench.mjs           四维基准（寻址 / 上下文 / 正确性 / 端到端）
bench/vs-native.mjs       对照原生 glob/读全文/正则的实测
bench/smalltree.mjs       小树全架构对照（进程基线 / 枚举 / 定位 / 改写 / sidecar / 批量 / inproc）
BENCH.md                  基准结果（bench 生成）
VS_NATIVE.md              原生对照结果（bench:vs 生成）
SMALL_TREE.md             小树结论与决策表（bench:small 生成数据）
vendor/README.md          es.exe 放置说明（二进制不入库）
```

### 2.1.0（本地构建）

- `ops_ptc_locate` 新增 `body`：命中正文 ≤8 KiB 时随回执附赠，超了给 `readHint`（省一次往返）。
- 适配层回执闸门 24 KiB：先退正文、再削条目、最后只留计数。
- 命中字段删 `chars/bodyBytes/fileBytes/savedRatio`，回执删 `contextBytes`。
- `schema.json` 与引擎解耦：宿主启动导入 19.01 → 4.56 ms，原生 AST 模块不再进启动路径。
