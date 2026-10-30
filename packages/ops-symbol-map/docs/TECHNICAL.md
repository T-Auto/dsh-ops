# ops_symbol_map 技术说明

> 读者：要改这段代码的人，和要判断它值不值的人。
> 所有数字都能用文末的两条命令复现；不能复现的数字不写在这里。

---

## 1. 它做什么，不做什么

**做**：把一个文件压成「符号名 + 类型 + 起止行号」的列表，让模型在几百 token 内知道这个文件有
什么，再决定读哪一段。

**不做**：

- 不返回源码。回执里没有任何一行文件正文，测试逐条断言这一点（`CODE_BODIES` 那组）。
- 不做类型、作用域、跨文件引用。Tree-sitter 是语法层，`import { A } from './a'` 里的 `A` 指向
  哪里它不知道。要跨文件就 `ops_grep`。
- 不返回 `interface` / `type`。它们不是可执行声明，这是设计不是遗漏。**但 `declare function`、
  重载头、`abstract class`、`declare class` 的方法签名都算** —— 那些是同一类声明的"没有函数体"
  写法，漏了就是大纲比文件短（第五轮修掉，见 §5.1）。
- 不写文件。全链路只读，任何失败都是 `effectState: 'none'`。

---

## 2. 调用链

```
模型
 └─ 工具名 ops_symbol_map
     └─ file/worker.ts :: invoke()                    ← Native 与 PTC 两条桥的共同分派点
         ├─ withResultSession()                       会话生命周期与取消
         ├─ withCallBudget()                          每条会话 2 活跃 / 8 排队
         └─ file/symbol-map.ts :: invokeSymbolMap()    ← 进程内，不 spawn
             ├─ 1. session.id + 绝对 cwd               缺一即 EXECUTOR_UNAVAILABLE
             ├─ 2. policy.resolve() 一次权威解析，再校验 mode 白名单
             ├─ 3. normalizeArguments() → 恰好一个绝对目标路径
             ├─ 4. credentialPath()                    ← 必须在锚定之前
             ├─ 5. anchoredPath()                      把 workspace/cwd/tmp 当锚，不 realpath 调用方的父目录
             ├─ 6. getSymbolMap() → paginate() → receipt()
             └─ 7. renderNative() / canonicalOutput()  Native 投影或 PTC 信封
```

第 4 步在第 5 步之前不是风格问题。`anchoredPath` 可能返回一个不存在的路径，而 `credentialPath`
匹配的是**调用方写的名字**；两步调换，`project/key -> ~/.ssh` 这种链接就能先过锚定再被读出去。

这里没有 `invokeTrusted` 的第二次策略解析，因为本分支从解析到 parse 全程同步：`readFileSync`、
懒加载的 grammar、query 都不让出事件循环，用户没有窗口改选择器。**哪天它变成异步，第二次解析
就必须跟着回来** —— 这条写在模块头注释里，是给未来的约束。

---

## 3. 模块与它存在的理由

| 模块 | 行 | 为什么单独存在 |
| --- | --- | --- |
| `types.ts` | 185 | `SyntaxTree` 等用结构化接口描述，`src/` 里任何文件都不 import tree-sitter。tsc 因此能在没装 grammar 的机器上通过 |
| `grammar.ts` | 207 | 懒加载 + 进程级池：每语言一个 `Parser`，每（语言, 档位）一个编译好的 `Query`。池命中率由 `stats().queryCompiles` 证明 |
| `query.ts` | 152 | S-表达式与 capture 语义表，**按语法家族组装**（第五轮）：TS 独有的四个节点名不能进 JS 的 query，否则编译失败 |
| `walk.ts` | 209 | 默认热路径。单张 `KIND` 查表分发，只进"能装声明"的节点，出声明即停 |
| `engine.ts` | 433 | 解析、错误扫描、恢复、`mapSource` |
| `cache.ts` | 261 | 文件级缓存：mtime 快路径、树复用（增量解析）、LRU 上限 |
| `snapshot.ts` | 265 | 符号编码/解码、分页、`verifySymbolMap`、快照读写 |
| `files.ts` | 135 | SHA-256、读文件（errno → 错误码）、路径显示、scope 规范化 |
| `errors.ts` | 66 | 错误码 + 统一 `fail()` |
| `index.ts` | 82 | 出口。模块可挪可并，外部只认这个面 |
| `file/symbol-map.ts` | 215 | 门禁顺序、参数规范化、回执投影。**顺序即安全属性** |
| `authority-paths.ts` | 71 | 锚定。第五轮把锚的 `realpath` 记忆化（§6.5）—— 这项收益属于**所有**文件工具 |
| `credential-policy.ts` | 220 | 共享围栏。第四轮加了根列表缓存（§6.4） |

---

## 4. 契约

### 4.1 符号

```
{ name: string, type: 'function' | 'class' | 'method', startLine: number, endLine: number }
```

1-based，闭区间，`endLine >= startLine`。顺序是「外层优先」：早的开始行在前，同一开始行取更长的
跨度在前，再按名字。一个比较器只有一份（`walk.ts::compareSymbols`），`engine.ts` 曾经有第二份，
两份差一个分支就会产出两份不同的大纲而没有任何东西报错。

### 4.2 线上编码

`"12-40 m render"` / `"12 f alpha"`。五个 token 一个符号，对象形式要二十二个。名字取第二个空格之后
的全部内容，所以名字里可以有空格、方括号、引号。`decodeSymbol` 是逆运算，格式不对返回 `undefined`
而不是半个符号 —— 错的行号比没有行号更糟。

### 4.3 revision

`revision` = 被解析**字节**的 SHA-256（不是解码后字符串：BOM、CRLF、孤立代理字节都改变
tree-sitter 看到的东西，因此也必须改变 revision）。`hash` = `revision.slice(0,16)`，只当缓存键。

`verifySymbolMap` 接受完整 revision 或 16 位 hash，比较永远对完整 revision 做。

### 4.4 分页

`offset` 数的是**符号**不是行。`omitted = total - scanned`，其中 `scanned` 是扫描到的符号下标 ——
所以 `name` 过滤时 `omitted` 会大于"剩余条数"，这是量纲，不是 bug。`name` 过滤**区分大小写**：
折叠大小写会让 `name: "get"` 连 `GetValue` 一起返回，比调用方要的宽，而工具 schema、双语文档、
蓝本包三方都是区分大小写的。

双闸：`limit` 行数（默认 512）与 `budgetBytes` 字节（默认 96 KiB，按编码后一行的真实字节 + 3 计费）。
只有一道闸时另一道能被绕过：长名字能撑爆字节闸，短名字能耗尽行闸。

---

## 5. 算法

### 5.1 为什么默认走剪枝行走而不是 S-表达式 query

`query.matches(root)` 遍历**每一个节点**，包括每个函数体内部。24 个真实文件上那是 16.6 ms，占冷
解析总成本的 30%。而符号提取要的三类节点全是声明式的：一个声明体内部不可能有读者想要的声明。

于是 `walkSymbols` 只进入「能装声明」的节点：`program`、`export_statement`、
`ambient_declaration`、`class_body`、`statement_block`、语句容器（`if`/`try`/`switch`…）、以及
`lexical_declaration`/`variable_declaration`（extended 档用）。出声明即停，代价正比于声明数而不
正比于文件大小。**3.02 ms vs 16.59 ms，5.5×。**

等价性是硬门槛。第一版严格剪枝跑出 0.44 ms 但漏了 12 个符号（6 个声明在函数体内，`ptc/worker.ts`
的 `const` 在 `try` 里）。补上语句容器后 40 个文件 256 个 core 符号 100% 对齐，0 漏 0 多。

extended 档仍走 query：`const f = () => {}` 可以出现在实参位置，那是表达式内部，正是剪枝不走的地方。

### 5.1b 声明不是一种节点，是两种写法（第五轮）

grammar 按「**有没有函数体**」拆节点，不按「是不是声明」拆。所以：

| 写法 | 节点 |
| --- | --- |
| `function f() {}` | `function_declaration` |
| `declare function f(): void` / 重载头 | `function_signature` |
| `class A {}` | `class_declaration` |
| `abstract class A {}` | `abstract_class_declaration` |
| `m() {}` | `method_definition` |
| `declare class` 里的 `m(): void` | `method_signature` |
| `abstract m(): void` | `abstract_method_signature` |

只认每对的左边，结果是**大纲比文件短而没有任何错误** —— 一个 `abstract class` 只剩一个孤儿方法，
`.d.ts` 里整族 `declare function` 一条不出。第五轮全部纳入。

两个连带问题：

- **`namespace N {}` 与 `module M {}` 不是同一个节点**：前者是 `expression_statement >
  internal_module`，后者是顶层 `module`。只加后者，现代写法一直不可见。walk 只在这一种表达式语句上
  进入（看唯一子节点），不进其余表达式。
- **query 必须按语法家族组装**。`abstract_class_declaration` 这些名字在 JavaScript grammar 里不存在，
  而 query 点名 grammar 不认识的节点是**编译失败**，不是少匹配几条。于是 `querySource(lang, tier)`
  负责拼装，JS 拿到的是去掉四个名字的版本 —— 一次共享的常量会让每个 `.js` 文件在第一次 extended
  调用时炸掉。

分发从「五个 Set 逐个查」换成**一张 `KIND` 表一次查**（`walk.ts`），因为这段代码每个被访问节点跑一次。

### 5.1c 一个物化的 `children` 值 1.3 ms

`namespace` 分支第一版写的是 `node.children.length === 1`。`children` 每次读都重新构造一个**含匿名
token** 的数组，而它跑在每个表达式语句上：24 文件语料冷启动 55.2 → 56.6 ms。改用原生的
`namedChildCount` / `firstNamedChild`（接口里是 optional，测试替身回退到 `children`）后回到 55.2 ms。
新增的五类声明因此是**零成本**的。

### 5.2 语法错误：扫描与恢复

tree-sitter 会解析坏文件，但它的错误恢复会把"从第一个错误到能重新同步"的整段吞进一个 `ERROR`
节点。第 40 行一个野大括号，41–900 行就全没了。

**错误扫描**只下钻 `hasError` 为真的子树。同一个 1,640 行文件上：全树遍历 37 ms → **0.046 ms
（790×）**，计数逐位相同。这是本项目最大的一次单点收益，因为它曾经是破损文件里最贵的一步 ——
比 parse 还贵。

**恢复**三段式（`engine.ts::recoverSymbols`）：

1. **只解析失败行所在的块**。主树已经把 `ERROR` 之外的符号都给了，重解析其余部分是纯成本。
2. **块边界取"第 0 列的顶层声明行"**。空行不行：类体里的空行会把 `class A {` 和方法切开，孤立
   方法片段是语法错误，整块作废 —— 实测段落切分恢复 28/150，声明切分恢复 130/150。
3. **广度优先**。每个候选块先试一遍再考虑二分，一个坏区域不能吃掉全文件需要的预算。

本轮加了第四条：**块内有错时，仍然取该块树里落在干净行上的符号**。行号可信性由一条过滤保证 ——
符号的 `[startLine, endLine]` 与块内 `ERROR`/`MISSING` 行区间相交就丢弃，因为那正是 `endLine`
被截断的地方。实测：40 处错误的语料从 52 个符号升到 **91 个**，代价 +2.7 ms；不变量测试钉死
"恢复出来的符号必须逐字段等于干净文件里的同一个符号"（0 例外）。

预算双闸：`chunks ≤ 512` + `lines ≤ min(200k, 行数×4)`。单个计数器不够：只算块数，一个坏区域能
把预算全花在二分上而 90% 的文件没被看过；`parser.parse` 的成本是文本量线性的，所以按行计才是
诚实的成本模型。

### 5.3 增量重解析

缓存存的不只是地图，还有**树**。revision 变了，先从新旧文本算出一段连续替换区间，对旧树执行
`tree.edit(edit)`，再把树交给 `parser.parse`：

| 场景 | 冷 | 改一行后 | 强制全量 | 加速 |
| --- | --- | --- | --- | --- |
| 1,640 行 | 13.5 ms | 7.9 ms | 13.8 ms | 1.7× |
| 8,720 行 | 79.1 ms | 43.9 ms | 79.8 ms | 1.8× |

单测 parse 本身：16,200 行改 1 行 **106 ms → 0.27 ms（397×）**。端到端只有 1.8×，因为 query /
walk 仍是全树遍历 —— 它现在才是大头。

**`tree.edit()` 是正确性要求，不是优化。** 不做 edit 直接 `parse(new, oldTree)`，节点结构对、字节
偏移是旧的，`node.text` 读到的是"现在位于旧偏移处的内容"：6 个类的夹具里每个方法名都变成邻行碎片
（`"method: 3\n}\n@"`）。中文注释夹具验证绑定按 UTF-16 code unit 索引，所以 `string.length` /
`charCodeAt` 就是正确原语，用字节偏移会在任何中文注释上漂移。

### 5.4 缓存

键 = `路径 \0 语言 \0 档位`。语言进键是因为同一个文件可以被当 `typescript` 或 `javascript` 映射，
只按路径做键不会报错，只会给一份"看起来对"的大纲 —— 最坏的缓存 bug，所以设计上排除。scoped
视图永不入缓存：它是文件的一个视图，不是文件的地图。

三条快路径，按代价从低到高：

1. `size` 与 `mtime` 都没变 → 直接返回（不读文件、不算哈希）。代价写进注释：同一 100 ns 刻度内
   两次写会当最新；对写方不是漏洞，陈旧 revision 会被 CAS 拒。
2. revision 相同、时间戳动了 → 刷新 stat 身份，下次走 1。
3. revision 不同 → 取旧树 + `edit` + 增量 parse。

本轮加的上限：**512 条 / 32 MiB 源码**，超了从最旧开始淘汰。每条目握着源码字符串和一棵原生树，
不设上限就是一个慢引信：跑几天的插件进程会给它映射过的每个文件留一棵树。

---

## 6. 性能模型

### 6.1 冷启动的钱花在哪（1,640 行 / 150 符号，`mapSource` 13.48 ms）

| 阶段 | ms | 占比 |
| --- | --- | --- |
| `parser.parse` | 8.11 | 60.2% |
| `walkSymbols` | 1.72 | 12.8% |
| 其余（读文件、UTF-8 解码、哈希、投影、GC） | 3.65 | 27.0% |

`parse` 在 tree-sitter 的 C 库里，**Rust 重写的上限是 1.44×**（`mapSource` 的 JS 侧中位占比 31%，
n=28，范围 0%–51%），因为 Rust 调用的是同一个 C 库。为了 44% 把三个 optional peer 变成 C 工具链
硬依赖、还要在 `unsafe_code = "forbid"` 的 native crate 旁边开洞，不划算。Rust 的价值在分发一致性，
不在速度。

`worker_threads` 并行也试过、被数据否掉：6 个 worker 跑 24 文件 **70–73 ms**，串行 39 ms。worker
启动 + 原生模块 `require` 约 60 ms，摊不平。

### 6.2 稳态

`getSymbolMap` 24 文件（472 KB / 188 符号）：冷 **55.2 ms**，第二次 **0.116 ms**（24 次命中，**477×**）。
单文件缓存命中后 **5 µs**。

### 6.3 端到端

走完 `invoke()` → 门禁 → 引擎 → 回执（24 文件，src-only，6,949 行，195 符号）：

| 口径 | 每文件 | 说明 |
| --- | --- | --- |
| 冷调用 | 2.18 ms | 含 parse |
| 热调用 | 181 µs | 缓存命中 |
| 引擎 + 门禁（进程内 `run()` 等价） | 23.5 µs | 差值是 `invoke()` 的策略解析、会话绑定与整份 outcome 的序列化 |

### 6.4 第四轮：围栏吃掉了 99% 的热调用

`credentialPath` 每次调用都把 home 下的 13 个后缀各做一次 `realpath`（不存在的路径还要递归解析
父目录，所以是 26 次系统调用）。实测 **1.88 ms**，而引擎只要 11 µs。它被**每一个**文件工具调用
支付，不只是 symbol_map。

改法：根列表按 `(home, DENY_ENV)` 记忆化，TTL 5 秒，`resetCredentialCache()` 可强制丢弃。候选路径
仍然每次解析（不缓存）。**1.88 ms → 0.181 ms（10.4×）**，热调用 2.07 ms → 0.32 ms。

TTL 的意义：唯一能在输入不变的前提下改变的东西，是"某个后缀在派生时不存在、之后被建成指向别处的
junction"。那个窗口最多 5 秒，而真正的凭据文件名（`id_rsa`、`credentials*.json`、
`service-account*.json`、`.env`）由独立的名称规则兜底。

这次改动第一版是错的：根存了大写原形，却拿小写化的目标去比，于是**一个都不匹配**，而名称规则把
大部分用例挡了下来，看起来像在工作。`test/credential-cache.test.mjs` 就是为这条写的 —— 它在没有
原生 worker 的机器上也跑，而原来的两个凭据套件在那里是 skip。

### 6.5 第五轮：锚的 `realpath` 是同一个错误的另一半

热调用剩下的 320 µs 里，还有一次 `realpathSync.native` 落在 `anchoredPath` 上。它解析的是**锚**
—— workspace 根、会话 cwd、tmp —— 全是宿主自己的目录，跟调用方传什么无关，所以它和凭据根列表
属于同一类：输入不变、结果不变、每次调用都重算。

| | 改前 | 改后 |
| --- | --- | --- |
| `anchoredPath` | 78.6 µs | **8.5 µs**（9.2×） |
| 进程内 `run()` 等价 | 108.2 µs | **23.5 µs**（4.6×） |
| 走完 `invoke()` 的热调用 | 320 µs | **181 µs**（1.8×） |

`credentialPath` **没有**跟着缓存，这个区别是刻意的：它解析的是调用方给的候选路径，而"授权后被
换掉的链接会失败关闭"正靠这一步。只剩它一个 `realpath` 之后，热调用的下限就是这个系统调用的价格。

同一个 TTL（5 秒）覆盖同一个风险：根被 junction 改指。`resetAnchorCache()` 可强制丢弃。

---

## 7. 与 OPS 原装工具的对比

同一份 24 文件语料，三种"找出这个文件有什么"的取法：

| 取法 | token | 占总读取 | 延迟 | 给得到什么 | 给不到什么 |
| --- | --- | --- | --- | --- | --- |
| `ops_read_files` 全文 | 105,284 | 100% | spawn，数十 ms | 一切 | —— |
| `ops_grep` 声明正则 | 5,390 | 5.1% | 0.38 ms（JS 等价） | 命中行 | 结束行、类型、层级、`const f = () => {}` |
| `ops_symbol_map` | 4,219 | 4.0% | 2.18 ms 冷 / 181 µs 热 | 名字/类型/起止行 | 源码、类型、跨文件 |

三句话：

1. **对全文：25.0× 更小。** 这才是它存在的理由，不是"比 read 快"。
2. **对 grep：只有 1.28×。** grep 是硬基线 —— 它只回命中行，先天就省。map 赢的地方是它多给的
   结束行、类型和层级，以及它不需要你先知道名字。
3. **真实工作流：map + 读回中位那个符号 = 19,999 token，是全文的 19%。** 也就是用 1/5 的钱拿到
   "看清结构 + 读懂一个函数"。

延迟方向上 map 慢 25×（冷）—— 但那 2.2 ms 相对于一次 `ops_read_files` 的进程启动是噪声，而
token 是稀缺资源。分界点在**全文约 2.8k token（60–100 行）**：短于此，地图的 ~150 token 固定头
反而更贵。

---

## 8. 全量审计（第四、五轮累计）

### 8.1 第四轮修掉的

| # | 发现 | 判据 | 处置 |
| --- | --- | --- | --- |
| A1 | 文件缓存无上限：每条目握着源码 + 一棵原生树，长会话是慢泄漏 | 读 `cache.ts` 无淘汰分支 | 512 条 / 32 MiB LRU，`stats().cachedUnits` 可观测；520 文件用例钉住 |
| A2 | 恢复整块丢弃带错的块，块里干净的那部分符号一起没了 | broken-40 恢复 52/150，且块内 `ERROR` 只遮住尾部 | 块内取干净行上的符号，`[start,end]` 与错误区间相交即丢；52 → **91** |
| A3 | 凭据围栏每次 1.88 ms，占热调用 99% | 分层计时 | 根列表记忆化（§6.4），1.88 → 0.181 ms |

### 8.2 第五轮修掉的

| # | 发现 | 判据 | 处置 |
| --- | --- | --- | --- |
| C1 | 五类"没有函数体"的声明静默消失：`abstract class`、`declare function`、重载头、`declare class` 的方法、`abstract method` | 41 个构造的覆盖探针：`abstract class D {abstract m(); n() {}}` 在 core 档返回**空**，extended 只剩孤儿 `m` | 五个节点名入表（§5.1b）；全仓 164 文件比对旧行走：**丢 0，增 4** |
| C2 | `namespace N {}` 不可见，而遗留写法 `module M {}` 一直可见 | 节点是 `expression_statement > internal_module`，walk 从不进表达式语句 | 只在这一种表达式语句上跳一层，其余仍不进 |
| C3 | 同一份文件两个档位两个答案：匿名 `export default class {}` 在 walk 里空、在 query 里吐方法 | 两档对照 | `class` 节点入表，两档一致：报方法、不编造类名 |
| C4 | 一旦把 TS 独有节点名写进共享 query，每个 `.js` 文件在首次 extended 调用时**编译失败** | `TSQueryErrorNodeType`，三套 grammar 逐一编译 | `querySource(lang, tier)` 按语法家族组装；测试断言 JS 源里不含那四个名字 |
| C5 | `anchoredPath` 每次对锚做一次 `realpath`，占进程内热调用 73% | 分层计时 78.6 µs / 108.2 µs | 锚按根记忆化，TTL 5 秒（§6.5），78.6 → 8.5 µs |
| C6 | `children` 物化：新增的 namespace 分支在每个表达式语句上构造一次含匿名 token 的数组 | 冷启动 55.2 → 56.6 ms | 改用 `namedChildCount`/`firstNamedChild`（接口 optional，替身回退），回到 55.2 ms |
| C7 | 测试文件 1,025 行，越过仓库 1000 行门禁 | `check-file-size` | 夹具与宿主桥拆到 `test/lib/symbol-map-fixtures.mjs`，873 行，断言一条没动 |

### 8.3 记录但没动的

| # | 事实 | 为什么不改 |
| --- | --- | --- |
| B1 | 破损文件里跨 `ERROR` 的符号 `endLine` 不可信（漏收尾括号的函数报 `1-20`，真实 `1-3`） | 截断是编数字，丢弃是丢名字。信号已由 `partial` + `syntaxErrors` + Native 投影的 best-effort 提示给出 |
| B2 | 10 个导出在仓库内零调用方：`writeSnapshot` `readSnapshot` `parseSnapshot` `decodeSymbol` `mapFiles` `buildSymbolMap` `cacheKeyOf` `poolStats` `parserConstructor` `displayPath`，合计约 150 行 | 这是对外 API 面的一部分（与蓝本包逐名对齐），删它是契约决定，不是清理 |
| B3 | `prune: true` 会把窗口外的符号也返回（`scope: '7-8'` 时多出 `make@10`） | 工具 schema 不暴露 `prune`，全链路走默认 `false`；作者已声明这两块要重写 |
| B4 | `stats()` 里 `revision` 与 `ops_stat` 同值未端到端独立验证 | 已由 `revision === sha256(文件字节)` 等价证明（e2e 每次调用都断言） |
| B5 | 回执里 `hash` 是 `revision.slice(0,16)`，纯冗余 | 已发布字段，删它要动 schema/文档/测试三方；连同三条默认值字段一共 29 token（9.4%），换不来一个契约变更 |
| B6 | npm 包里 docs 占 1.28 MiB（30%），符号地图本身 77 KiB（1.9%） | 不是本次改动引入的 |
| B7 | 匿名 `export default function () {}` 仍不可见 | 没有名字就没有可导航的行号，编一个 `default` 比空着更坏 |
| B8 | `lib/ptc/sdk.d.ts`（4,191 行 / 28,787 token）返回 0 条，因为它只有 `type`/`interface` | 契约正确但用户体验是误导，值得一条显式提示；那要动投影文本，留给作者 |

### 8.4 端到端验证补上的两件事

1. **`revision` 对齐磁盘字节**：`e2e.mjs` 每次调用都用 `createHash('sha256')` 独立重算并比对。
2. **契约落到行上**：每个符号的 `startLine` 回到文件里那一行，按类型核对它确实是
   `function` / `class` / 方法声明。195 个符号，0 例外。

---

## 9. 门禁与复现

```console
node scripts/build.mjs                    # 产物
npx tsc -p . --noEmit                     # EXIT=0
node test/run.mjs symbol-map              # all 47 checks passed
node test/run.mjs credential-cache        # all 3 checks passed
node test/run.mjs                         # 46 of 153 failed, 56 skipped
node scripts/validate-manifest.mjs        # 146/146
node scripts/check-file-size.mjs          # 458 files, longest 927
node bench/symbol-map/bench.mjs           # 16 s
node bench/symbol-map/e2e.mjs             # 13 s，契约 0 失败
```

`46 of 153 failed` 里 100% 是同一个原因：`test/lib/harness.mjs:106` 的 `icacls /setowner` 在本机
被拒（`已成功处理 0 个文件; 处理 1 个文件时失败`），套件在第一条断言前就抛错。与本功能无关，基线
数字与上一轮相同（上一轮 46 of 152 —— 152 加上本轮新增的 `credential-cache` 套件）。

**56 skipped** 是"没有原生 worker 二进制"（`native/target/release/dsh-ops-worker.exe`）。
一个套件**跳过不等于通过**，`DSH_OPS_REQUIRE_RUNTIME=1` 会把跳过变成失败。

---

## 10. 未决

1. **B1 的取舍**要先定"错行号 vs 没条目"哪个更坏，才能动。
2. **`prune` 语义**（B3）与 `mapSource` 的重写是同一件事，等作者。
3. **core 档的空地图**（B8）：值得一条显式提示（"no executable declarations; only types and
   interfaces"），但那要动投影文本。
4. **热调用剩下的 181 µs** 里约 70 µs 是 `credentialPath` 对候选路径的 `realpath`，那是安全属性，
   不建议换。
5. **回执固定头还能省 29 token（9.4%）**（B5 + 三条默认值字段），代价是一次契约变更，等作者。
