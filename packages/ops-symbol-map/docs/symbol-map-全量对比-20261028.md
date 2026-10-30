# ops_symbol_map · 全量对比（第五轮 · 2026-10-28）

> 这份文档回答三个问题：这一轮改了什么、和 ops 原装工具比差多少、五轮下来变成了什么样。
> 所有数字来自本机同一台机器、同一天、`bench/symbol-map/` 里的两条命令；不能复现的数字不写。
> 机器级漂移约 ±10%，所以只比同轮内的比值，跨轮比较都标注了「同轮比值」。

---

## 0. 一页结论

| 维度 | 数值 | 对手 |
| --- | --- | --- |
| token（24 文件 / 6,949 行 / 195 符号） | **4,219** | 全文 105,284（**25.0×**）· `grep` 声明正则 5,390（**1.28×**） |
| 冷调用（首见文件，含 parse） | **2.18 ms / 文件** | 全文读取要 spawn 进程，数十 ms |
| 热调用（缓存命中，走完 `invoke()`） | **181 µs / 文件** | 上一轮 320 µs（**1.8×**） |
| 引擎本身（`getSymbolMap` 命中） | **5 µs / 文件** | 门禁与投影占其余 |
| 破损文件（1 / 3 / 11 / 40 处错） | 14.0 / 14.7 / 23.4 / 37.3 ms | 符号 150 / 150 / 142 / 91 |
| 语法覆盖（41 个构造） | core 与 extended 只在 4 个 `const f = () =>` 用例上不同 | 改动前 5 个构造静默消失 |

一句话：**token 已经压到边界（符号本身占 62%，剩下的是身份行），延迟这一轮吃掉了门禁里最后一次
多余的 `realpath`。**

---

## 1. 这一轮改了什么

### 1.1 修掉：五个语法构造此前静默消失

这是符号地图最坏的失败形态 —— 不报错，只是大纲比文件短。全部实测于探针（41 个构造，逐条对照
`walk` 与编译后的 query）：

| 构造 | 语法节点 | 改动前 | 改动后 |
| --- | --- | --- | --- |
| `abstract class D { abstract m(): void; n() {} }` | `abstract_class_declaration` | core 全空；extended 只剩一个孤儿方法 `m` | `D:c` `m:m` `n:m` |
| `declare function f(): void` | `function_signature` | 空 | `f` |
| `.d.ts` 里的重载头 | `function_signature` | 只报有实现的那一个 | 每个声明各一条 |
| `declare class E { m(): void }` 的方法 | `method_signature` | 类在、方法全丢 | 都在 |
| `namespace N {}` | `expression_statement > internal_module` | 空（而遗留写法 `module M {}` 一直可见） | 都在 |

`abstract_class_declaration`、`function_signature` 这些名字**只存在于 TypeScript/TSX grammar**，
JavaScript grammar 里没有；而 query 一旦点名 grammar 不认识的节点，是**编译失败**而不是少匹配几条。
所以 query 源改成按语法家族组装（`querySource(lang, tier)`），JS 拿到的是一份没有这四个名字的源。

同一族里还有两个一致性问题，一起修了：

- 匿名 `export default class {}` 在 walk 里完全不可见，在 query 里却能吐出方法 —— 同一份文件两个档位
  两个答案。现在两边都报方法、都不编造类名。
- `class` 是匿名节点，不是 `class_declaration`；不加进表里，上面那条永远对不齐。

**没有回退。** 全仓 164 个 `.ts` 文件逐个比对旧行走与新行走：**丢 0 个，新增 4 个**（两个文件同时
写了重载头和实现，现在各算一条声明）。

### 1.2 修掉：门禁里每调用一次的 `realpath`

热调用 320 µs 里，`credentialPath` 与 `anchoredPath` 各做一次 `realpathSync.native`。前者必须做
（候选路径每次解析，正是"授权后被换掉的链接会失败关闭"那一步）；**后者解析的是锚** —— workspace
根、会话 cwd、tmp，全是宿主自己的目录，跟调用方传什么无关。

改成按根记忆化、TTL 5 秒、`resetAnchorCache()` 可强制丢弃。TTL 覆盖的唯一变量是"根被 junction
改指"，和凭据根列表用的是同一个取舍。

| | 改前 | 改后 |
| --- | --- | --- |
| `anchoredPath` | 78.6 µs | **8.5 µs**（9.2×） |
| 整个 `run()`（进程内） | 108.2 µs | **23.5 µs**（4.6×） |
| 走完 `invoke()` 的热调用 | 320 µs | **181 µs**（1.8×） |

这个收益不只属于 symbol_map：**每一个走锚定的文件工具都少一次 `realpath`。**

### 1.3 修掉：`children` 物化吃掉的 1.3 ms

新增的 `namespace` 分支需要看"节点的唯一子节点"，第一版写的是 `node.children.length === 1`。
`children` 是带匿名 token 的数组，每次读都重新构造，而它跑在**每个表达式语句**上 —— 24 文件语料
冷启动从 55.2 ms 涨到 56.6 ms。换成原生的 `namedChildCount` / `firstNamedChild` 后回到 **55.2 ms**，
也就把 1.1 的收益做成了零成本。

### 1.4 拆掉：测试文件越过 1000 行门禁

`test/symbol-map.test.mjs` 涨到 1,025 行，越过仓库上限。夹具与宿主桥（`GOOD` / `BROKEN` /
`withFixture` / `bridge`）挪到 `test/lib/symbol-map-fixtures.mjs`，测试文件回到 873 行，一条断言没动。

---

## 2. 与 ops 原装工具的全量对比

同一份 24 文件语料（`src/` 下的真实文件，6,949 行，195 个符号），四种"这个文件里有什么"的取法。
`read` 与 `grep` 的载荷按 `modes/native/ranges.ts` 与 `ops_grep` 的真实输出格式构造，token 用
`js-tiktoken` 的 `cl100k_base` 数真实字节。

| 取法 | token | 占全文 | 延迟 | 给得到 | 给不到 |
| --- | --- | --- | --- | --- | --- |
| `ops_read_files` 全文 | 105,284 | 100% | spawn 进程，数十 ms | 一切 | —— |
| `ops_grep` 声明正则（`^\s*(export )?(async )?(function|class) `） | 5,390 | 5.1% | 0.38 ms | 命中的那一行 | 结束行、类型、层级、`#secret()`、`const f = () => {}` |
| **`ops_symbol_map`** | **4,219** | **4.0%** | 2.18 ms 冷 / 181 µs 热 | 名字、类型、起止行 | 源码、类型系统、跨文件引用 |
| `symbol_map` + 读回中位那个符号 | 19,999 | 19.0% | —— | 结构 + 一个函数的实现 | 其余函数体 |

三句话：

1. **对全文 25× 更小。** 这是它存在的理由。不是"比 read 快" —— 它比 read 慢，慢 2.2 ms，代价是
   105 KB → 4.2 KB。
2. **对 grep 只有 1.28×。** grep 是硬基线：只回命中行，先天就省。map 赢的地方是多给的结束行与类型、
   以及对 `#secret()` / `[Symbol.iterator]()` / 箭头函数绑定这类 grep 正则抓不全的写法 —— 以及不需要
   你先知道名字。
3. **真实工作流是最后一行**：map 看清结构 + 只读回中位那个符号 = 全文的 19%。用 1/5 的钱拿到
   "结构 + 一个实现"。

**分界点**（同一轮实测，crossover 表）：全文约 **2.8k token（60–100 行）**。短于此，地图 ~150 token 的
固定头反而更贵；`synthetic-1k`（178 行）是 11.2%，`synthetic-5k` 是 5.7%，`synthetic-50k` 稳在 4.9%。

### 2.1 回执的固定头到底剩多少

一个 28 符号文件回执 308 token，其中 191 是符号本身，117 是固定头：

| 字段 | token | 说明 |
| --- | --- | --- |
| `revision` | 40 | 64 位十六进制 SHA-256，`ops_stat` 同值，可直接当 `expectedRevision` |
| `symbols`（28 条） | 191 | 每条 5 token，已是最小编码 |
| `sandbox` | 18 | 三个常量 |
| `hash` | 11 | `revision.slice(0,16)`，纯派生 |
| `file` / `bytes` / `partial` / `status` / `lang` / `total` / `offset` / `omitted` / `complete` | 37 | |

还能再省 **29 token（9.4%）**：`hash` 可由 `revision` 派生、`offset:0`/`omitted:0`/`complete:true`/
`partial:false` 都是默认值。**没做** —— 这四项都是已发布字段，删它要同时动 schema、双语文档、PTC
信封与测试四方，而 9.4% 换不来一个契约变更。记录在 §5。

---

## 3. 五轮下来

| | 第一轮 | 第二轮 | 第三轮 | 第四轮 | **本轮** |
| --- | --- | --- | --- | --- | --- |
| 24 文件地图 token | 5,322 | 3,207 | 3,207 | 4,226 | **4,219** |
| 占全文 | 4.73% | 2.82% | 2.82% | 4.0% | **4.0%** |
| 冷调用（`getSymbolMap` 24 文件） | 54.2 ms | 46.7 ms | 46.7 ms | 55.3 ms | **55.2 ms** |
| 热调用（进程内 `run()`） | —— | —— | —— | 108 µs | **23.5 µs** |
| 热调用（走完 `invoke()`） | —— | —— | —— | 320 µs | **181 µs** |
| 破损文件 1 / 3 / 11 / 40 处错 | 59.1 / 59.5 / 51.7 / 25.6 ms | 同左 | 13.9 / 14.3 / 21.9 / 33.9 | 同左 | **14.0 / 14.7 / 23.4 / 37.3** |
| 破损文件恢复符号（40 处错） | —— | —— | 52 | 91 | **91** |
| 语法构造静默漏报 | —— | —— | —— | 5 类 | **0** |
| 断言数 | 0 | 35 | 43 | 45 | **47** |

> token 与符号数跨轮不可直接相减：语料本身就是仓库里这 24 个文件，它们每轮都在变（本轮
> `walk.ts` 从 144 行涨到 210 行）。第一、二轮的下降是真的（对象编码 → 行编码，固定头 283 → 152），
> 第三轮之后是平的。

五轮里真正改变量级的只有三件事：

1. **符号编码**（对象 → `"12-40 m render"`）：−40% token，交叉点从 62 行降到 25 行。
2. **剪枝行走替换 query**：`query.matches` 16.6 ms → `walkSymbols` 3.0 ms（5.5×），且让首次调用
   不必编译 query。
3. **错误扫描只下钻 `hasError` 子树**：37 ms → 0.046 ms（790×）。破损文件从"比干净文件慢 5 倍"
   变成慢 1.7–2 倍。

Rust 重写的上限这一轮重测是 **1.45×**（JS 侧中位占比 31%，n=28）—— 因为 `parse` 在 tree-sitter 的 C
库里，Rust 调用的是同一个库。不值得为它把三个 optional peer 变成 C 工具链硬依赖。

---

## 4. 审计：这一轮核过但没动的

| # | 事实 | 判据 | 为什么不改 |
| --- | --- | --- | --- |
| B1 | 破损文件里跨 `ERROR` 的符号 `endLine` 不可信（漏收尾括号的函数报 `1-20`，真实 `1-3`） | broken 语料逐条比对干净版本 | 截断是编数字，丢弃是丢名字。信号已由 `partial` + `syntaxErrors` + Native 投影提示给出 |
| B2 | 10 个导出在仓库内零调用方，约 150 行 | `grep` 全仓 | 对外 API 面的一部分，与蓝本包逐名对齐，删它是契约决定 |
| B3 | `prune: true` 会把窗口外的符号也返回 | `scope:'7-8'` 时多出 `make@10` | 工具 schema 不暴露 `prune`，全链路走默认 `false`；作者已声明这块要重写 |
| B4 | 回执 `hash` 冗余（`revision.slice(0,16)`） | §2.1 | 已发布字段，见 §2.1 |
| B5 | 匿名 `export default function () {}` 仍不可见 | 无名字可报 | 没有名字就没有行号可导航，编一个 `default` 是更坏的选择 |
| B6 | `interface` / `type` 不是符号，`lib/ptc/sdk.d.ts`（4,191 行 / 28,787 token）返回 0 条 | 该文件只有 `type`/`interface` | 契约正确但对调用方是误导，值得一条显式提示；那要动投影文本，留给作者定 |
| B7 | `parse` 占冷启动 79%，在 C 库里 | 分阶段计时 | 这是 Rust 重写天花板 1.45× 的来源，也就是"没有可优化空间" |

---

## 5. 边界

1. **只认 8 个扩展名**：`.ts .mts .cts .tsx .js .mjs .cjs .jsx`。
2. **语法层不是语义层**：不知类型、不知跨文件引用，定位到符号后用 `ops_grep` 找引用。
3. **core 档只认声明**：`const handler = async () => {}` 要 `extended: true`（`src/ptc/index.ts` 上
   1 条 → 15 条）。这是档位定义，不是漏。
4. **工作区外的绝对路径照读**：该分支没有可 confine 的 root，与 `ops_inspect_local_file` 是 parity。
5. **热调用剩下的 181 µs** 里约 70 µs 是 `credentialPath` 对候选路径的 `realpath` —— 那是安全属性，
   不建议换。

---

## 6. 复现

```console
node scripts/build.mjs                    # 产物
node test/run.mjs symbol-map              # all 47 checks
node bench/symbol-map/bench.mjs           # 16 s：分阶段、规模、破损、增量、缓存、Rust 上限
node bench/symbol-map/e2e.mjs             # 13 s：走完 invoke()，外加契约断言
npx tsc -p . --noEmit                     # EXIT=0
node scripts/validate-manifest.mjs        # 146/146
node scripts/check-file-size.mjs          # 458 files ≤ 1000 lines（最长 927）
```

`e2e.mjs` 不是只看时间：每个符号的 `startLine` 回到磁盘那一行核对是不是声明（195 个，0 例外）、
`revision === sha256(文件字节)`、缓存调用与冷调用同一份符号表、回执里没有任何一行源码。任一不成立
就 `exit 1`。
