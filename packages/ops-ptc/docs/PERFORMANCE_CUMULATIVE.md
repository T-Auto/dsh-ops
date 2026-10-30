# ops-ptc 2.0.0 → 2.0.5 累计优化与验收

对象：`K:/ai/ops-ptc`　最终版本：2.0.5
环境：Windows x64 / Node v24.22.1 / AMD Ryzen 7 9700X（8C16T）
状态：**未 commit / 未 push / 未 publish / 未替换生产插件**

## 0. 一页结论

1. **曾被打上 ⚠ 的两个倒退点已经收敛**：`tiny-4-edits/inproc/preview` 从 0.911x 升到 **2.041x**（对 2.0.0）、**2.204x**（对 2.0.2）；`large-1500/pipeline/preview` 从 0.856x 升到 **1.230x**（对 2.0.0）、**1.396x**（对 2.0.2）。
2. **14 个可与 2.0.0 逐字节对比的热路径场景里，13 个 ≥ 1.0**，最大 6.518x（`large-1500/inproc/preview`）。唯一低于 1.0 的是 `tiny-4-edits/inproc/apply` 0.944x（2.0.4 时 0.871x），原因是 2.0.1 才加的原子写屏障，见 §5.1。
3. **冷路径**（每次全新进程，含启动与外部工具探测）inproc 全部 ≈1.0（0.957~1.240），pipeline 0.858~0.995，残差是一次性的 difftastic 版本探测 50.9 ms，见 §5.2。
4. **2.0.5 只做精简与正则预编译**：安装包 134165 → **65313** 字节（−51.3%），15 个场景输出逐字节不变，热路径相对 2.0.4 最大回退 1.6%（噪声带内），见 §9。

## 1. 口径（不读这段，数字会被误用）

- 方法：串行交替 AB/BA；冷路径 5 个全新进程；热路径 2 次预热 + 9 次采样取中位。命令与原始样本见 §7。
- 每一对 A/B 都在**同一次运行、同一进程内**交替采样。**倍率只在同一次运行内有效，绝对值不可跨运行比较**（历史多次出现同场景绝对值差 3~5 倍、倍率不变）。
- 比较范围：全部公开返回字段 + 落盘后的实际字节（`preview` 不落盘，比对原文件字节不变；`apply` 与独立字节 oracle 比对）。
- 对 2.0.0 基线时使用 `--parity bytes`：2.0.0 的 `audit.nodesAdded/kinds` 对 `parenthesized_expression` 有已知少计缺陷（2.0.1 F03 修复），因此只比对**字节**这一独立可证的产物。

## 2. 五个版本各自改了什么（累计口径）

| 版本 | 主题 | 关键改动 | 证据 |
|---|---|---|---|
| 2.0.1 | 审计与正确性 | variadic 捕获保留逗号/注释/空白（F01）；同名符号多形态汇总 + 歧义熔断（F02）；诊断按身份与位移比对而非只比数量（F03）；写前全量预审计 + 协作锁 + 独占临时文件 + 双快照 + mode 保留（F04）；枚举全局上限与缓存键（F05）；入参校验（F06）；pipeline 先审计后落盘（F07）；变长恢复用当前长度（F08）；临时目录 mkdtemp + finally 清理（F09）；worker 16 MiB/10000 edits/hex hash 约束（F10）；stdout/stderr 共享预算（F11）；MCP 帧/在途/输出预算（F12）；真实 dsh-ops 契约 adapter（F13）；自包含 smoke（F14） | [`AUDIT_REPORT.md`](AUDIT_REPORT.md) |
| 2.0.2 | 性能第一轮 | 八种定义形态的独立全树查询合并为一次 native `any` 查询；区间审计从「每节点线性扫全部区间」改为 preorder 二分 + 后缀最小 ends；TS 诊断关闭 parent 指针；root 文本按文件缓存 | `PERFORMANCE_ROUND2.md`（仓库内） |
| 2.0.3 | 消灭两处倒退 | 命中区间一次取回后纯 JS 排序；改写模板只取一次 root 文本；线性切片拼装替代逐条 `replace/commitEdits`；pipeline 单次递增 UTF-8→UTF-16 游标；新增 `auditSyntax` 只做判定不算统计；difftastic 先探测后落临时文件并按工具身份单飞缓存；`detectEol` 单次字节扫描。顺带修非法 `mode` 被包装成 apply、`checkedWrite` 清理异常吞掉已落盘结果 | `PERFORMANCE_ROUND3.md`（仓库内） |
| 2.0.4 | 同一份源码不再重复 parse | `parseAuditRoot` 有界整树缓存（语言 + 完整源码为键，6 条 / 4 MiB，LRU）；ERROR 节点首次使用时才扫；`auditAst` 复用第五参数传入的根；`inprocLocate` 改走缓存根 | `PERFORMANCE_ROUND4.md`（仓库内） |
| 2.0.4 补丁 | 版本与冷路径 | `tools.ts:64` 版本号回填 2.0.4（原先停在 2.0.3，导致安装验收读到的 MCP 版本是旧值）；`stages.ts:506` 导出 `difftAvailable`，`pipeline.ts:116` 提前发起探测，让这次 spawn 与定位/改写的外部进程墙钟重叠（`pipeline.ts:160` 观测点） | 本文件 §5.2、§6 |
| 2.0.5 | 包精简 + 正则预编译 | tarball 134165 → **65313**（安装包只留 `dist/` + 四份文档，基准样本与分组报告移出）；`.js` 去注释而 `.d.ts` 保留 JSDoc 的两遍 emit；inproc `rank` 打分一次替代比较器内重算、地址分隔符改为无分配计数；热路径正则全部提到模块层，模板 EOL 归一回退为按需扫描 | 本文件 §9 |

## 3. 累计实测：2.0.5 vs 2.0.0（14/14 可比场景）

`node scripts/performance-round2.mjs --baseline audit/perf-round3/baseline-200/package/dist --candidate dist --parity bytes --exclude variadic-html/apply`

| 场景 / 引擎 / 模式 | cold 倍率 | cold 2.0.0 ms | cold 2.0.5 ms | warm 2.0.0 ms | warm 2.0.5 ms | warm 倍率 |
|---|---:|---:|---:|---:|---:|---:|
| tiny-4-edits / inproc / preview | 1.017 | 162.9 | 160.1 | 0.88 | 0.43 | **2.041x** |
| tiny-4-edits / inproc / apply | 1.007 | 160.9 | 159.8 | 1.82 | 1.93 | **0.944x** ⚠ |
| tiny-4-edits / pipeline / preview | 0.858 | 294.8 | 343.5 | 229.62 | 166.45 | **1.379x** |
| tiny-4-edits / pipeline / apply | 0.889 | 375.5 | 422.3 | 305.92 | 251.86 | 1.215x |
| large-1500 / inproc / preview | 1.096 | 265.5 | 242.1 | 89.00 | 13.65 | **6.518x** |
| large-1500 / inproc / apply | 1.085 | 266.3 | 245.5 | 89.89 | 16.46 | **5.463x** |
| large-1500 / pipeline / preview | 0.932 | 598.1 | 641.9 | 521.58 | 424.14 | **1.230x** |
| large-1500 / pipeline / apply | 0.911 | 663.8 | 728.3 | 598.69 | 509.13 | 1.176x |
| many-750 / inproc / preview | 1.230 | 338.7 | 275.3 | 154.53 | 35.87 | **4.307x** |
| many-750 / inproc / apply | 1.240 | 342.6 | 276.3 | 134.51 | 34.76 | **3.869x** |
| many-750 / pipeline / preview | 0.995 | 2238.3 | 2248.9 | 2173.44 | 2056.14 | 1.057x |
| many-750 / pipeline / apply | 0.986 | 2309.2 | 2341.1 | 2241.26 | 2199.89 | 1.019x |
| variadic-html / inproc / preview | 0.957 | 152.6 | 159.4 | 0.42 | 0.33 | 1.247x |
| locate-only / inproc / locate | 1.003 | 88.6 | 88.3 | 23.84 | 8.52 | **2.800x** |

`variadic-html / inproc / apply` 被显式排除（`report.excluded`）：2.0.0 的 variadic 捕获会丢逗号/注释（F01），该路径 2.0.0 的输出字节与现在不同，**不能用它做字节基线**。排除是记录在案的选择，不是测量失败。

## 4. 两个原倒退点的收敛轨迹

| 点 | 2.0.1 基线 | 2.0.2（出问题） | 2.0.3 | 2.0.4 | 现在对 2.0.0 |
|---|---:|---:|---:|---:|---:|
| tiny-4-edits / inproc / preview | 1.000 | **0.911x** | 1.868x | 2.204x | **2.156x** |
| large-1500 / pipeline / preview | 1.000 | **0.856x** | 1.225x | 1.396x | **1.268x** |

两次倒退的共同原因都不是「算法变慢」，而是新增的正确性开销没有控住：inproc 侧是每个命中跨 N-API 读 `range()`、每个命中重解模板、多次复制整文件；pipeline 侧是每个 edit 从文件头重解码 UTF-8 前缀（750 处改写退化成 O(n×m)）以及为语法判定白算 hunk/kind 统计。2.0.3 把这两类开销改成一次取、一次解、只算必要项，2.0.4 再把「同一份源码解析两遍」压成一遍。

## 5. 仍然低于 1.0 的三处：归因，不是漏改

### 5.1 `tiny-4-edits / inproc / apply` 0.944x（1.82 → 1.93 ms）

阶段归因（`audit/perf-round5/tiny-attrib.mjs`，147 字节 fixture，120 次中位同进程）：

| 阶段 | 中位 |
|---|---:|
| 整次 inproc apply | 1.871 ms |
| `checkedWrite` 单测 | 1.367 ms（**73%**） |
| `auditAst` 单测 | 0.114 ms |
| `inprocLocate` 单测 | 0.169 ms |

差值全部落在写入屏障上：2.0.0 的 apply 没有协作锁、没有独占临时文件、没有写前/写后双快照，直接覆盖原文件（这正是 2.0.1 F04 修掉的问题）。2.0.5 把模板展开与 EOL 归一改成无分配路径后，该点从 0.871x 抬到 0.944x；再往上只能删掉原子写，即恢复「中途失败可留下半截文件」。**没做**。

### 5.2 pipeline 冷路径 0.855~0.991

同一次运行里 pipeline 热路径是 1.03~1.41x，冷路径反向，差值 45~52 ms，且只在 pipeline 出现（inproc 冷路径 0.988~1.217）。实测一次冷探测成本：

```
probe 0 true 50.9ms   # 首次：pickBin + stat + spawn difft --version
probe 1 true  4.2ms   # 命中身份缓存，只重做 stat
probe 2 true  3.6ms
```

50.9 ms 与 45~52 ms 的冷路径残差同量级、同方向。这笔钱是 2.0.3 为了「difftastic 不可用时不落任何临时文件」而加的探测；删掉它等于让缺失工具的请求先写两份候选再失败。**没做**，只把它提前到与定位/改写并发（`pipeline.ts:116`），本轮实测把冷路径从 0.825/0.832/0.903/0.888/0.954/0.970 抬到 0.855/0.880/0.933/0.914/0.991/0.972。

### 5.3 `many-750 / pipeline / apply` 1.032x（对 2.0.0 曾 0.983x）

2.09 s 里有 1.78 s 是 difftastic 的图对齐成本（131 KB × 2、750 处改写），与实现无关。2.0.4 相对 2.0.0 的增量是 2.0.1 起强制的前置审计（F07：落盘前审计完整候选），约 25~30 ms。本轮把 0.983x 抬到 1.032x 后已进入噪声带。

## 6. 本轮（2.0.4 补丁）新增的两项

1. **发布缺陷修复**：`src/ptc/tools.ts:64` 的 `version` 停在 `2.0.3`，而 `package.json` 已是 `2.0.4`。后果不是显示问题——`smoke:package` 里 `ops-ptc/mcp` 的 `serverInfo.version` 断言直接失败（`'2.0.3' !== '2.0.4'`），也就是 2.0.4 的安装验收当时是红的。已回填并补守护：`scripts/mode-audit-regression.mjs` 新增「元数据版本必须等于 package.json 版本」检查（27 → 28 项）。
2. **冷探测并发**：`difftAvailable` 导出，`pipeline.ts:116` 在发起定位/改写的同时发起探测，`pipeline.ts:160` 作为观测点。语义不变——仍然先探测后落临时文件，不可用时的降级与 `requireAudit` 判定都在原处。

## 7. 验收与可复现命令

| 入口 | 结果 | 内容 |
|---|---|---|
| `npm run verify` | rc=0 | typecheck + build + 3 个 smoke + 12 段回归（`audit/perf-round6/verify.log`，153 行 PASS） |
| `npm run test:regression` | rc=0 | 124 项 PASS，含 mode-audit 28 项、清理回执 3 项、deep-inproc 36 项、locate parity 84 项、产物形态 1 项 |
| `npm run test:perf` | rc=0 | 347 项审计差分 + 36 组定位/改写差分 |
| `npm run smoke:package` | rc=0 | 生产安装（omit=dev / ignore-scripts）+ 消费端 5 项，含精简契约与 `dist < 200 KiB` 守护 |
| `node scripts/performance-round2.mjs …` | rc=0 | 15/15 场景字段与字节完全一致（`audit/perf-round6/comparison-205-vs-204.json`） |
| 2.0.5 vs 2.0.0 | rc=0 | 14/14 可比场景逐字节一致（`audit/perf-round6/comparison-205-vs-200.json`） |

```bash
npm run verify
npm run test:perf
node scripts/performance-round2.mjs --baseline audit/perf-round6/baseline-dist --candidate dist   --output audit/perf-round6/comparison-205-vs-204.json
node scripts/performance-round2.mjs --baseline audit/perf-round3/baseline-200/package/dist   --candidate dist --parity bytes --exclude variadic-html/apply   --output audit/perf-round6/comparison-205-vs-200.json
node scripts/dist-shape-regression.mjs
npm pack && npm run smoke:package
```

## 8. 边界（沿用，未因本轮缩小）

1. 冷启动没有实质变快，pipeline 冷路径仍比 2.0.0 慢 1.5%~14.5%，原因见 §5.2。
2. 树缓存按进程存活，键是完整源码；>4 MiB 的文件实际不缓存。
3. difftastic 与 ast-grep 的绝对成本未动，pipeline 耗时由外部工具决定；没有为了数字删掉独立审计。
4. 并发不是 filesystem CAS，多文件不是事务；`committed/partial` 必须核实。
5. 解析 ≠ 语义：`parseDiagnostics` 不做类型/业务校验，tree-sitter 容错解析可能漏错。
6. BOM 源码仍按 fail-closed 处理（`E_AST_AUDIT_SPLICE`），功能缺失未修。
7. 未测 Node 18 / Linux / macOS；外部二进制或 dsh-ops 其它版本仍需跑兼容回归。
8. 可信宿主执行桥仍未接线，不能把 adapter 契约测试当作生产权限链验收。

## 9. 2.0.5：包精简与正则预编译

约束：**不删功能、不改语义、不改任何公开返回字段**。下面每条都能用 §7 的命令复算。

### 9.1 体积：134165 → 65313 字节（−51.3%）

按单项 gzip 贡献分（tarball 是整体压缩，所以分项之和大于文件本身）：

| 类别 | 2.0.4 | 2.0.5 | 变化 |
|---|---:|---:|---:|
| `dist/` | 62303 | 49759 | **−12544（−20.1%）** |
| `audit/perf-round{2,3,4}/summary.json` | 48506 | 0 | −48506 |
| `PERFORMANCE_ROUND2/3/4.md` | 10953 | 0 | −10953 |
| `SMALL_TREE.md` | 5952 | 0 | −5952 |
| `vendor/README.md` | 557 | 0 | −557 |
| 文档与元数据（README/AUDIT/HOST/CUMULATIVE/package.json） | 22711 | 26426 | +3715 |

解包 204133 字节，压缩后 65313（文档里新增的本轮证据占 3301 字节，从节省额度里扣）。两份实测报告与原始样本留在仓库 `audit/perf-round6/`，不再进包。

### 9.2 两项改动

1. **`files` 白名单收口**：只留 `dist` + `README.md` + `AUDIT_REPORT.md` + `HOST_INTEGRATION.md` + `PERFORMANCE_CUMULATIVE.md`。移出的是基准样本（1.19 MB 原始 JSON）、分组报告、`SMALL_TREE.md`、`vendor/README.md` —— 全是研发产物，运行时一次都不读。
2. **两遍 emit**（`scripts/build.mjs:28-29`）：第一遍 `--removeComments` 产出无注释 `.js`，第二遍 `--emitDeclarationOnly` 重新产出**保留 JSDoc** 的 `.d.ts`。单跑 `--removeComments` 会把声明里的类型文档一起删掉，那属于 DX 损失，所以拆成两遍：运行时文件瘦 20.1%，消费端悬浮文档一个字不少。

### 9.3 正则预编译

| 位置 | 原写法 | 改动 | 为什么等价 |
|---|---|---|---|
| `inproc.ts:32-45` | 12 个内联字面量分散在枚举/预筛/定位里 | 提到模块层 `RE_*` 常量 | 字面量每次求值都新建 RegExp 包装对象；带 `g` 的只用 `match`/`replace`/`matchAll`，三者按规范入口归零 `lastIndex`，无跨调用状态 |
| `inproc.ts:369` `countSep` | `file.match(/[\/]/g).length` | 直接按 charCode 计数 | 只为个数，不必分配匹配数组 |
| `inproc.ts:390` `rankOrdered` | `rank` 放在 `sort` 比较器里 | 先打分再按键排序 | 比较器里重算等于 O(n log n) 次重复打分；显式按原索引兜底，稳定性与原 `Array#sort` 一致 |
| `inproc.ts:802` 模板 EOL 归一 | 每个命中无条件 `.replace(/\r?\n/g, eol)` | 先判是否含对应换行符 | LF 目标仅当文本含 `\r` 才可能变；CRLF 目标仅当含 `\n` 才可能变。不满足时结果与原字符串完全相同 |
| `inproc.ts` `expandTemplate` | `parts.map(...).join('')` | 累加拼接 | 输出字符串一致，省一个中间数组 |
| `proc.ts:224-229`、`stages.ts:22-23` | `toLines` / `normalizeEol` / 行切分每次重建 | 模块层常量 | 同第一条 |

`variadic-html` 的 `$$$` 语义、BOM 坐标、CRLF 保留都由 15 个场景的字节比对与 36 组 inproc 差分兜住。

### 9.4 你列的方向逐条核对

| 方向 | 现状 | 结论 |
|---|---|---|
| `readdir` 带 `withFileTypes` | 早就在用（`inproc.ts:200`、`:293`） | 已满足，本轮不动 |
| 读前先 `stat` 卡大小 | `INPROC_MAX_BYTES = 2 MiB`（`inproc.ts:169`），读前 `statSync`、读后再验一次字节数 | 已满足 |
| `Buffer.subarray` 零拷贝替代字符串切片 | 切片边界来自 napi 的 **UTF-16** 索引，Buffer 是 UTF-8 字节域 | **不采纳**：转域要先建偏移映射，比直接 `slice` 更慢且会破坏 BOM/CRLF 坐标语义。真正的零拷贝已经在用——`auditAst` 直接收 `root`，不再重解析 |
| 流式处理大输出 | 子进程输出有 `maxBuffer` 与共享预算，读的是整体 JSON/NDJSON | 不需要：这些输出必须整体解析，流式只会增加状态机 |
| `switch` 换 `Object`/`Map` | 现状是 `DEFINITIONS` 数组 + `Map` 去重，没有长 `switch` | 已满足 |
| 闭包捕获大对象 | `templateCache` 有 64 条上限并按 LRU 淘汰；树缓存 6 条 / 4 MiB | 已满足 |
| 全部 `xxxSync` 改 `fs.promises` | 公开 API 是**同步**契约（`inprocRefactor` 返回结果对象，MCP/CLI 直接消费） | **不采纳**：改成异步会破坏 API 与 CLI 调用点，属于破坏性变更，不是优化 |
| 长循环让出事件循环 | 同上，同步函数里无法 `await` | **不采纳**：只能靠异步化实现，收益是 P99 抖动，代价是签名破坏 |
| 缓存 `arr.length` | 剩余两处循环是 argv 解析与 400 条分块扫描，不是热循环 | 不必要，改了也没有可测差异 |
| 不用 `delete` | 全仓仅一处注释提到，无 `delete` 调用 | 已满足 |
| 卫语句替代深嵌套 | `auditAst`、`checkedWrite`、`inprocRefactor` 主路径已是卫语句风格 | 已满足 |

### 9.5 为什么没有顺手改 `astdiff.ts:542` 之类

那几处正则每次请求只跑一次（strict 对账的 stdout 切行），提到模块层省不到可测时间，却要再动一次审计主路径。**收益为零的改动不放进来**，这是本轮唯一的取舍标准。

### 9.6 本轮验收

| 检查 | 结果 |
|---|---|
| `npm run verify` | rc=0，153 行 PASS |
| `npm run test:regression` | rc=0，124 项（新增 `dist-shape-regression` 1 项） |
| `npm run test:perf` | rc=0，347 项审计差分 + 36 组定位/改写 |
| 2.0.5 vs 2.0.4（15 场景） | 全部 `equality: true`；热路径 10/15 ≥1.0，其余 4 项在 −1.6%~−0.2%，`locate-only` 复测 1.037x（首轮 0.946x 为噪声） |
| 2.0.5 vs 2.0.0（14 场景） | 全部逐字节一致，13/14 ≥1.0 |
| `npm run smoke:package` | rc=0，5 项，含精简契约与 `dist < 200 KiB` 守护 |
| `scripts/dist-shape-regression.mjs` | PASS：11 个 `.js` 无块注释、8 份声明保留 JSDoc、导出集合与 2.0.4 逐模块一致 |
