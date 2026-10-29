# ops_symbol_map — 只给行号的符号地图

> **20261029**：`lstat` 与 `open` 之间的窗口用一次 `realpath` 收口；补 `package.json`
> （语法包进 `optionalDependencies`）；`limit` 缺省页大小三处统一为 **512**（此前文档写 64）。
> 详见 [FIXES.md](FIXES.md)。

`ops_symbol_map` 是 dsh-ops 文件工具面上唯一在**进程内**作答的成员。它读一个 TypeScript /
TSX / JavaScript 文件，返回一份结构化大纲：函数、类、类方法的**名字、类型、起止行号**。
不返回源码，一个字节都不返回。

一个 6,949 行的 24 文件语料：

| 取法 | token | 相对全文 |
| --- | --- | --- |
| `ops_read_files` 全文 | 105,284 | 100% |
| `ops_grep` 声明正则 | 5,390 | 5.1% |
| **`symbol_map` 整份回执** | **4,219** | **4.0%** |
| `symbol_map` + 读回中位那个符号 | 19,999 | 19.0% |

调用一次的真实代价（走完 `worker.invoke` 到回执）：

| 口径 | 延迟 |
| --- | --- |
| 冷启动（首见文件，含 parse） | 2.18 ms / 文件 |
| 热调用（缓存命中） | 181 µs / 文件 |
| 引擎 + 门禁（进程内） | 23.5 µs / 文件 |

---

## 30 秒上手

### 1. 装 grammar（可选依赖，不是 dsh-ops 的依赖）

```console
npm install --legacy-peer-deps --no-save --ignore-scripts \
  tree-sitter@0.25.1 tree-sitter-typescript@0.23.2 tree-sitter-javascript@0.23.1
```

`--no-save` 不能省。省了会把 `tree-sitter` 写进 `package.json`，之后所有 `npm install` 都
`ERESOLVE`；`--legacy-peer-deps` 也不能省，grammar 包的 peer 范围还停在 `^0.21.1`。
Windows 下不需要 MSVC：`tree-sitter@0.25.1` 自带 `win32-x64` prebuild。
装完 48.9 MB（tree-sitter 4.9 + typescript 38 + javascript 6.0），这是本功能的真实安装成本。

引擎找不到 grammar 时不是崩溃，是一个可读的拒绝：

```
EXECUTOR_UNAVAILABLE  tree-sitter is not available to dsh-ops (…). Install the optional grammar
packages next to dsh-ops: npm install --legacy-peer-deps tree-sitter@0.25.1 …
```

`DSH_OPS_SYMBOL_MAP_ROOT` 可以指向另一个安装位置（bundle 把 dsh-ops 拷出 `node_modules` 时用）。

### 2. 调用

```jsonc
// 参数
{ "path": "src/panel/collect.ts" }                       // 全量大纲
{ "path": "src/panel/collect.ts", "scope": "40-160" }    // 只看一段
{ "path": "src/panel/collect.ts", "name": "render" }     // 按名字过滤（区分大小写）
{ "path": "src/panel/collect.ts", "offset": 40, "limit": 20 }  // 翻页，单位是符号不是行
{ "path": "src/panel/collect.ts", "extended": true }     // 追加 const f = () => {} 这类绑定
```

```jsonc
// 回执
{
  "status": "completed",
  "file": "src/panel/collect.ts",
  "lang": "typescript",
  "revision": "9f2c…64 hex…",     // 被解析字节的 SHA-256
  "hash": "9f2c…16 hex…",         // revision.slice(0,16)，缓存键
  "bytes": 24188,
  "partial": false,               // 文件有语法错误时为 true
  "total": 28,
  "offset": 0,
  "symbols": [                    // 一个符号一行，5 个 token
    "1-3 f alpha",
    "5-13 c Widget",
    "6-8 m render"
  ],
  "omitted": 0,
  "complete": true,
  "sandbox": { "mode": "read-only", "enforcement": "policy", "boundary": "in-process-symbol-map" }
}
```

`"12-40 m render"` = 起-止 类型 名称。`f` 函数 / `c` 类 / `m` 方法，起止行相同就只写一个数字。
名字是第二个空格之后的全部内容，所以 `[Symbol.iterator]`、`'quoted name'`、`#secret` 都能活着过去。

### 3. 校验快照还新不新

地图是**快照**。生成之后、读取之前文件被改过，行号就偏了。回执带 `revision`：

```js
import { verifySymbolMap } from './lib/symbol-map/index.js'
verifySymbolMap(receipt)   // { valid: true|false, reason: 'fresh'|'stale'|'missing', revision, expected, file }
```

把回执里的 `revision` 交给 `ops_edit_file` / `ops_write_file` 的 `expectedRevision`，写入方会做
compare-and-swap：快照过期就是一次干净的失败，不是一次静默覆盖。

---

## 目录

```
src/symbol-map/          引擎，10 个模块，2,005 行
  grammar.ts             懒加载 grammar + 进程级 Parser/Query 池
  query.ts               S-表达式，按语法家族组装（TS 独有的节点名不能进 JS 的 query）
  walk.ts                剪枝行走，默认热路径（比 query 快 5.5×），单张表分发
  engine.ts              解析 → 符号；错误扫描；破损文件的恢复
  cache.ts               文件级缓存：mtime 快路径、树复用、LRU 上限
  snapshot.ts            分页、符号编码、revision 校验、快照落盘
  files.ts               SHA-256、读文件、路径显示、scope 规范化
  errors.ts              错误码与描述
  types.ts               类型面（SyntaxTree 等是结构化接口，不 import tree-sitter）
  index.ts               对外出口
src/file/symbol-map.ts   工具适配层：门禁顺序、参数规范化、回执投影（215 行）
src/authority-paths.ts   锚定；锚的 realpath 按根记忆化，收益属于每个文件工具（71 行）
src/credential-policy.ts 共享的凭据围栏（根列表缓存，见 TECHNICAL §6.4）
test/                    47 + 3 条断言；夹具在 test/lib/symbol-map-fixtures.mjs
bench/symbol-map/        bench.mjs（引擎分阶段）· e2e.mjs（走真实 dispatch）
```

## 跑测试与基准

本包是 dsh-ops 源码树的一个切片：`test/` 与 `bench/` 里的相对导入（`../lib/...`、`../../lib/...`）
指向编译产物，所以下面的命令要在 dsh-ops 检出目录里跑，把本包的 `src/` `test/` `bench/` 覆盖进去，
先 `node scripts/build.mjs`。

```console
node test/run.mjs symbol-map          # 47 checks
node test/run.mjs credential-cache    # 3 checks，不需要 grammar 与 worker
node bench/symbol-map/bench.mjs       # 16 s，引擎分阶段 + token + 破损 + 增量
node bench/symbol-map/e2e.mjs         # 13 s，invoke() → 回执，外加契约断言
```

`e2e.mjs` 不是只看时间：它把每个符号的 `startLine` 回到磁盘上那一行核对是不是声明、核对
`revision === sha256(文件字节)`、核对缓存调用与冷调用给出同一份符号表、核对回执里没有源码片段。
任何一条不成立就 `exit 1`。

## 已知边界

1. **只认 8 个扩展名**：`.ts .mts .cts .tsx .js .mjs .cjs .jsx`。其他扩展名要么显式 `lang`，要么
   `UNSUPPORTED_DOCUMENT`。
2. **语法层不是语义层**。`interface`、`type` 不是符号，所以 `lib/ptc/sdk.d.ts`（4,191 行）返回 0 条
   —— 符合契约，但对调用方是误导：文件里确实没有可执行声明。注意 `declare function`、重载头、
   `abstract class`、`declare class` 的方法签名**都是符号**（第五轮补上，此前静默消失）。需要跨文件
   引用就接着用 `ops_grep`。
3. **破损文件的行号可能越过错误区**。主树对 `ERROR` 节点内部的符号给出的 `endLine` 不可信（实测
   一个漏了收尾大括号的函数会报 `1-20` 而真实范围是 `1-3`）。回执里 `partial: true` 和
   `syntaxErrors` 是这件事的信号，Native 投影会打印 `[positions recovered best-effort]`。
4. **core 档只认声明**。`const handler = async () => {}` 要 `extended: true`；它在 `src/ptc/index.ts`
   上从 1 条变 15 条，差值不是 bug，是档位。
5. **工作区外的绝对路径照读**。这条分支没有可 confine 的 root；`ops_inspect_local_file` 同样不
   confine 绝对路径，所以是 parity，不是缺口。

## 版本

本包是 **dsh-ops 0.5.0 的一组分片**，不是独立 npm 包：它依赖 `src/file/worker.ts` 的分派点、
`src/authority-paths.ts` 的锚定、`src/permissions.ts` 的模式白名单。要打补丁进仓库：

```console
git diff HEAD -- src/symbol-map src/file/symbol-map.ts src/authority-paths.ts \
  src/credential-policy.ts test/symbol-map.test.mjs test/credential-cache.test.mjs \
  test/lib/symbol-map-fixtures.mjs bench/symbol-map > symbol-map.patch
```
