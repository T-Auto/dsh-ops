# 审计报告 — ops-symbol-map 20261029.4

范围：`ops_symbol_map` 并入 dsh-ops 后的第四轮审计。这一轮修的是「包在盘上、工具说没有」：
`dsh-ops/package.json` 的 `dependencies` 是 `null`，语法包只在包自己的 `optionalDependencies`
里声明过，所以任何一次清 `node_modules` 都会让工具报 `E_ENGINE_UNAVAILABLE`。

历史轮次：20261029.3（过滤后分页统计）、20261029（`realpath` 收口 + manifest + 512）见文末各节。

## 0. 本轮结论（20261029.4）

| 项 | 20261029.3 | 20261029.4 |
| --- | --- | --- |
| 语法包解析锚点 | 1（包根） | **2**（包根 → `vendor/deps`） |
| `pnpm install` 清空 nested 后 | `E_ENGINE_UNAVAILABLE` | 回退 `vendor/deps`，照常工作 |
| 第一锚点命中时的行为 | — | 逐字节不变，无额外 syscall |
| 回退发生时机 | — | 仅首次加载，不在每次调用 |
| `DSH_OPS_SYMBOL_MAP_ROOT` | 覆盖包根 | 仍优先于两个锚点 |

## 1. 缺陷：依赖是 `null`，于是重装就等于卸载

`grammar.ts` 原本只有一条锚点：

```ts
const anchor = path.join(override ?? PACKAGE_ROOT, 'package.json')
engine = createRequire(anchor)
```

这条锚点找的是 `dsh-ops/node_modules`。而 `dsh-ops/package.json` 的 `dependencies` 至今是
`null` —— 三个语法包从来没被写进宿主 manifest，只是手工装进去的。一次
`pnpm install --frozen-lockfile`、一次换机、一次 `rm -rf node_modules`，工具立刻变成
`EXECUTOR_UNAVAILABLE`，而 `vendor/deps` 里那份完好的副本一直没被看过。

改成按序试两个锚点：

```ts
const ENGINE_ANCHORS: readonly string[] = Object.freeze([
  path.join(PACKAGE_ROOT, 'package.json'),
  path.join(PACKAGE_ROOT, 'vendor', 'deps', 'package.json'),
])

function engineLoad(name: string): unknown {
  let last: unknown
  for (const chunk of engineAnchors()) {
    try { return chunk(name) } catch (error) { last = error }
  }
  throw last
}
```

`GRAMMAR_LOADERS` 的三个 thunk 与 `parserConstructor()` 的 `tree-sitter` 本体全部改走
`engineLoad`；`engineRequire()` 保留，但只作为第一锚点的快捷方式。`anchors` 缓存一次
`createRequire`，第二个锚点不在热路径上。

**为什么不改宿主 manifest**：那是上游仓库的事，要等合并、要过 review，而且下一次 `pnpm install`
仍可能按 lockfile 把它抹掉。让包自己带一份，代价是磁盘，收益是「重装之后什么都不发生」。

| 项 | 说明 |
| --- | --- |
| 第一锚点命中 | 与 20261029.3 逐字节一致，无额外 syscall |
| 回退代价 | 一次失败的 `require`（`MODULE_NOT_FOUND`）+ 一次成功，只发生在首次加载 |
| 错误保真 | 最后一个错误原样重抛，仍能区分「模块不存在」与「原生 binding 坏了」 |
| 平台 | `vendor/deps` 只带 win32-x64 prebuild；换平台要重裁一份，锚点不用改 |
| 类型检查 | `tsc --noEmit` 只报 `../paths.js`（本包是 source drop），`grammar.ts` 本身零语法错误 |

## 2. 结论（20261029.3）

| 项 | 20261028 | 20261029 |
| --- | --- | --- |
| `lstat` → `open` 窗口 | 敞开 | 一次 `realpath` 收口 |
| 语法包声明 | 无 manifest，靠手工 `npm i` | `optionalDependencies` |
| `limit` 缺省页大小 | 代码 512 / 文档 64 | 三处统一 512 |
| 热态延迟 | 0.06 ms | 0.18–0.20 ms |

## 2. 缺陷：`lstat` 与 `open` 之间的替换窗口

`reparseEscape` 从叶子逐级 `lstat` 到锚点，命中任何 symlink/junction 即拒。这道防线证明的是「检查的那一刻没有链接」，不是「读的那一刻不可能有链接」——中间把叶子换成 junction，`lstat` 仍报普通文件，`open` 已经跟到栏外。原装 Rust 用 `open_nofollow`，这一步在内核里是原子的；Node 的 `readFileSync` 没有等价物。

修法：`lstat` 之后补一次 `realpathSync.native(trusted)`，把「实际要读的」折回真实路径，再跑锚点包含判定与凭据判定。目标不存在时交给引擎报 `NOT_FOUND`，不在这里替它定罪。

窗口从「两次 syscall 之间」收窄到「一次 realpath 之内」，代价是一次 `lstat` + 一次 `realpath`：热态 0.06 → 0.18–0.20 ms。原生侧同样要付这两个 stat，只是付在 Rust 里，所以这不是「进程内更慢」，是「同一件事在这里显式付」。

## 3. 缺陷：没有 manifest，语法包随时会消失

这份源码包此前没有任何 `package.json`。摊进 `dsh-ops/lib/symbol-map/` 后，三个语法包（`tree-sitter` / `-typescript` / `-javascript`）是手工装进宿主目录的。换机、重装、`pnpm install --frozen-lockfile` 都会抹掉它们，`symbol_map` 随即整条变成 `EXECUTOR_UNAVAILABLE`。

修法：声明 `optionalDependencies`。三个语法包都带原生编译，装不上时不该阻断整个安装；缺失时只有 `symbol_map` 不可用，`read_files` 等不受影响，回执的 `nextAction` 给出确切的安装命令。

## 4. 文档漂移：缺省页大小

`DEFAULT_LIMIT = 512`（`src/symbol-map/snapshot.ts:20`），工具 schema 的 `limit` 描述与 README 都写 64。调用方按 64 算分页会多切 8 倍，也就是多 7 轮往返。三处统一成 512。

## 5. token 账

符号表的价值是字节压缩，不是省调用：

| 取法 | token | 相对全文 |
| --- | --- | --- |
| 全文读（10 个 .js） | 97,950 B（撞 128 KiB 预算，没读完） | 100% |
| `symbol_map` ×10 | 6,853 B | 7.0% |

行格式 `"19-24 f failure"` 实测 6.8–7.3 token/符号。10 个文件的符号表约 7 个符号/文件、50 token，同等信息的 `read_files` 需要 3,700 token 一轮。

## 6. 残余风险

1. **目录链 TOCTOU**：`realpath` 复核收口的是叶子，父目录在 `realpath` 与 `open` 之间仍可被换。彻底消掉需要 `openat` 逐级下钻，Node 不暴露。
2. **`extended` 模式**：额外抓 `const` 箭头绑定，符号数会显著增加（512 上限照样生效）。
3. **`revision` 只在单次解析内自洽**：跨进程比对没问题，但它不证明文件在解析后没被改。

## 7. 验证

```
node check.mjs
SM manifest optionalDeps tree-sitter,tree-sitter-javascript,tree-sitter-typescript
SM realpath recheck true | inside import true
```

适配层实跑：`invokeSymbolMap` 三次调用分别 16 / 1 / 1 ms，8 个符号，`revision` 64 hex。

---

## 第十五轮（2026-10-30）：`name` 过滤后的分页统计 → 20261029.3

### 1. 现象

`ops_symbol_map {path, name: "f15", limit: 1}`，目标文件 200 个符号：

```json
{"total": 200, "symbols": ["16 f f15"], "omitted": 50, "complete": false, "nextOffset": 16}
```

命中的只有 1 条，回执却说还剩 50 条。调用方按 `nextOffset` 续页，翻到的全是被 `name` 排除掉的
符号 —— 一次"过滤"变成一串无用的往返。

### 2. 根因

`paginate()` 边扫边 `continue` 跳过不匹配项，但：

- `total` 取 `map.total`（未过滤的全量）；
- `omitted = total - scanned`，而 `scanned` 是**过滤之后**才推进到的位置。

两个口径混在一句减法里。`receipt()` 再把 `total` 覆盖回 `map.total`，即使 `paginate` 想报对也报
不出去。

### 3. 修法

先 `filter` 再分页：

| 字段 | 改前 | 改后 |
| --- | --- | --- |
| `total` | `map.total`（200） | **过滤后集合长度（11）** |
| `omitted` | `200 - 过滤位置`（50） | **`11 - 过滤位置`（10）** |
| `nextOffset` | 过滤位置 | 过滤位置（含义一致，但分母对了） |
| `offset` | 未过滤的第 N 个符号 | 过滤后的第 N 个符号（与 `nextOffset` 自洽） |

不带 `name` 时走原数组，零额外开销；带 `name` 时多一次 O(n) 引用过滤（200 符号 <0.01 ms）。

### 4. 回归

宿主 7 工具联合审计 75 项全过，symbol-map 相关 31 项覆盖：符号行格式、`fileHash` 小文件等于
`revision`、大文件 `head+tail`/`102400` 字节、头改/尾改敏感、批量 16/17 边界、`extended` 收箭头、
`.tsx`/`js`/`.mjs`/`.cjs`、`scope` 收窄与越界、`limit`+`nextOffset` 分页、junction 与凭据名拒绝、
空文件、BOM、非 UTF-8。
