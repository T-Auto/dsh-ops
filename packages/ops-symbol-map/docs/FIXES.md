# 本地修补 — ops-symbol-map 20261029.3

## S3 `name` 过滤后的分页统计自相矛盾（本次）

**现象**：`ops_symbol_map {path, name: "f15", limit: 1}` 在一个 200 符号的文件上回
`total: 200, symbols: ["16 f f15"], omitted: 50`。命中的只有 1 条，回执却说还剩 50 条 —— 调用方按
`nextOffset` 继续翻，翻到的全是被 `name` 排除掉的符号。

**根因**：`paginate()` 边扫边 `continue` 跳过不匹配项，但 `total` 取的是 `map.total`（未过滤），
`omitted = total - scanned` 里的 `scanned` 却是**过滤后**才推进的位置，两个口径混在一句减法里。
`receipt()` 又把 `total` 直接覆盖回 `map.total`，即使 `paginate` 想报对也报不出去。

**修法**：先 `filter` 再分页。`total` / `omitted` / `nextOffset` 全部落在过滤后的集合上；
`receipt()` 改用 `page.total`。`offset` 语义随之变成"过滤后的第 N 个符号"，与 `nextOffset` 自洽。

**实测**（200 符号，`name: "f15"`，`limit: 1`）

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `total` | 200 | **11** |
| `symbols` | `["16 f f15"]` | 同 |
| `omitted` | 50 | **10** |
| `complete` | false | false（11 条里确实还有 10 条） |

代价：带 `name` 时多一次数组 `filter`（O(n) 引用拷贝，200 符号 <0.01 ms）；不带 `name` 时走原数组，
零开销。

## S1 重解析点逃逸（严重）
## S1 重解析点逃逸（严重）

**位置**：`src/file/symbol-map.ts`（新增 `src/file/reparse.ts`）；编译产物 `lib/file/symbol-map.js` + `lib/file/reparse.js`

**现象**：五道围栏里，凭据围栏看的是**名字**，锚定看的是**词法路径**，两者都看不见内核在 open 时做的解析。工作区内放一个 junction 指向栏外：

```
ws/link -> K:/ai/.tmp/audit2/outside
path: "link/leak.ts"
```

名字里没有凭据关键字，词法上 `inside(workspaceRoot, ws/link/leak.ts)` 成立，于是 `statSync` + `readFileSync` 直接跟到栏外。实测返回 2 个符号（`leaked`、`Hidden`），文件内容来自工作区之外。原装 Rust 用 `open_nofollow` 拒绝这一类路径，这里是裸 `readFileSync`，等于没有这道防线。

**修补**：新增 `reparseEscape(abs, stops)`，从叶子逐级 `lstat` 到锚点（锚点自身检查、其父目录不检查——宿主自己的 profile 目录可能就是 junction）。命中即返回该组件，适配层返回 `PATH_RESTRICTED`，并把该组件 `realpath` 后再过一次凭据围栏：落到凭据根时返回 `CREDENTIAL_DENIED`，与原生同码。

```ts
const link = reparseEscape(trusted, sessionAnchors(policy, cwd))
if (link !== undefined) { /* 凭据复核 → PATH_RESTRICTED */ }
```

`PATH_RESTRICTED` 同时进 `PREFLIGHT`：拒绝发生在任何字节被读之前。

## 验证

| 用例 | 修补前 | 修补后 |
| --- | --- | --- |
| `link/leak.ts`（junction 指向栏外） | `completed`，2 个符号 | `PATH_RESTRICTED` |
| 同一路径，`danger-full-access` | 读到栏外 | `PATH_RESTRICTED`（原生同样拒绝） |
| 普通文件 `real.ts` | `completed`，3 个符号 | `completed`，3 个符号 |
| 深层真实路径（`…/dsh-ops/lib/file/ptc-inproc.js`） | ok | ok，无误杀 |
| 热态单次 | 0.06 ms | 0.20 ms |

热态多出的 ~0.14 ms 就是 6–9 次 `lstat`。这是替换路径上唯一为安全付的代价：原生同样每级 `symlink_metadata`，只是付在 Rust 里。

## 已知边界

- `anchoredPath` 仍然只 canonicalise 锚点，不 realpath 调用方的父目录——这是刻意的，配合 `reparseEscape` 之后两者互补：词法不动，重解析点单独拒。
- `authority-paths` 的锚缓存 TTL 5 s 保留：锚点是宿主所有，调用方改不动；`reparseEscape` 每次调用都重新 `lstat`，不共享缓存，因此不存在跨调用的陈旧窗口。

## R12 `lstat` 与 `open` 之间的窗口用 realpath 收口

**位置**：`src/file/symbol-map.ts`

**现象**：`reparseEscape` 走的是 `lstat` 链，真正读取由内核在 `open` 时解析。两者之间把叶子
换成 junction，`lstat` 报「普通文件」而 `open` 已跟到栏外——S1 的防线是「检查时没有链接」，
不是「读取时不可能有链接」。

**修补**：`lstat` 之后补一次 `realpathSync.native(trusted)`，把「实际要读的」折回真实路径，
再做锚点包含判定与凭据判定；不存在时交给引擎报 `NOT_FOUND`，不在这里替它定罪。窗口从
「两次 syscall 之间」收窄到「一次 realpath 之内」。热态代价 0.06 ms → 0.18–0.20 ms（多出的
就是这次 `lstat` + `realpath`，原生 Rust 侧同样要付，只是付在 `open_nofollow` 里）。

## R12 补 `package.json`：语法包改 `optionalDependencies`

**位置**：新增 `package.json`

**现象**：这份源码包此前没有任何 manifest。把它摊进 `dsh-ops/lib/symbol-map/` 后，语法包
（`tree-sitter` / `-typescript` / `-javascript`）靠手工 `npm i` 装进宿主目录；换机、重装、
`pnpm install --frozen-lockfile` 都会把它们抹掉，`symbol_map` 随即整条变成
`EXECUTOR_UNAVAILABLE`。

**修补**：声明 `optionalDependencies`（三个语法包都带原生编译，装不上时不该阻断整个安装），
并在回执的 `nextAction` 里给出确切的安装命令。语法包缺失时依旧只让 `symbol_map` 不可用，
`read_files` 等工具不受影响。

## R12 默认页大小文档纠偏

代码里 `DEFAULT_LIMIT = 512`（`src/symbol-map/snapshot.ts:20`），工具 schema 的
`limit` 描述写的是「Default 64」，README 也照抄。调用方据此算分页会多切 8 倍。三处统一成 512。

## S2 `fileHash`：头尾各 50 KiB 的快速变更指纹

**位置**：`src/symbol-map/files.ts`（新增 `FAST_HASH_WINDOW` / `fileFingerprint`）、`src/file/symbol-map.ts`（`fingerprintOf` + 回执三字段）、`src/symbol-map/index.ts`（导出）

**动机**：调用方要判断"这份地图还算不算数"，原本只有两条路 —— 比 `revision`（要整文件 SHA-256，且只在解析时顺带算过）或者重读全文。前者在缓存命中时拿不到，后者代价与文件大小成正比。

**实现**：

```ts
export const FAST_HASH_WINDOW = 50 * 1024

export function fileFingerprint(absolute, size, revision) {
  if (size <= FAST_HASH_WINDOW * 2) return { hash: revision, scope: 'full', bytes: size }
  const fd = fs.openSync(absolute, 'r')
  try {
    const headLength = Math.min(FAST_HASH_WINDOW, size)
    const tailLength = Math.min(FAST_HASH_WINDOW, size - headLength)
    const hash = createHash('sha256')
    hash.update(readAt(fd, 0, headLength))
    hash.update(readAt(fd, size - tailLength, tailLength))
    return { hash: hash.digest('hex'), scope: 'head+tail', bytes: headLength + tailLength }
  } finally {
    fs.closeSync(fd)
  }
}
```

三个设计点：

1. **不超过双窗口就不读盘**。`bytes <= 100 KiB` 时头尾已经覆盖全文，`revision` 本来就是整个 buffer 的 SHA-256，复用即可 —— 小文件的 `fileHash` 精确等于 `revision`，零额外 IO，回执也不带 `fileHashScope`。
2. **`readAt` 处理短读**。哈希途中文件被截短时 `readSync` 返回 0，按实际长度收尾，不抛 `ERR_OUT_OF_RANGE`。
3. **失败不传染**。`fingerprintOf` 捕获所有异常并回退成 `{ hash: revision, scope: 'full', bytes }`：一次额外 IO 出错，不能把本来已经成功的符号表判成 `IO_ERROR`。

**回执新增字段**（`fileHash` 在最外层，与 `symbols` 分页无关）：

```jsonc
{ "fileHash": "…64 hex…", "fileHashScope": "head+tail", "fileHashBytes": 102400 }
```

`fileHashScope` / `fileHashBytes` 只在头尾模式下出现，常见的小文件回执一个字节都不多。

**实测**（`node test-filehash.mjs`，20 条断言）：

| 场景 | 结果 |
| --- | --- |
| 60 B 文件 | `fileHash === revision`，无额外字段 |
| 366 KB / 9000 行 | `scope: head+tail`、`bytes: 102400`、与 `revision` 不同源 |
| 头改 | `fileHash` 变 |
| 尾改 | `fileHash` 变 |
| 中段改（等长，第 4500 行） | `fileHash` 不变，`revision` 变 —— 刻意取舍，由 `revision` 兜底 |
| 4 MB 文件 | 指纹 0.18 ms，只读 100 KiB |
| 文件在解析后被删 | 回退 `revision`，不报错 |

**代价**：>100 KiB 的文件每次调用多一次 open + 两次 pread（合计 100 KiB）。9000 行那档实测解析 161 ms，指纹部分在噪声内。

## 20261029.4 · 双锚点解析

### S3 语法包重装即丢，包却在盘上

`dsh-ops/package.json` 的 `dependencies` 是 `null`，三个语法包只以 `optionalDependencies` 的形式
声明在**本包**里。一次 `pnpm install` 或任何清 `node_modules` 的动作都会让
`dsh-ops/node_modules/tree-sitter*` 消失，工具随即报 `E_ENGINE_UNAVAILABLE` —— 而此时
`vendor/deps` 里那份完好的副本一直没被看过。

`grammar.ts` 从单锚点改成按序试两个：

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
`engineLoad`；`engineRequire()` 保留但只作为第一锚点的快捷方式。`anchors` 缓存一次
`createRequire`，第二个锚点不在热路径上。

| 项 | 说明 |
| --- | --- |
| 第一锚点命中 | 行为与 20261029.3 逐字节一致，无额外 syscall |
| 回退代价 | 一次失败的 `require`（抛 `MODULE_NOT_FOUND`）+ 一次成功，只发生在首次加载 |
| 最后一个错误 | 原样重抛，仍能区分「模块确实不存在」与「原生 binding 坏了」 |
| `DSH_OPS_SYMBOL_MAP_ROOT` | 优先级高于两个锚点，语义不变 |
| 平台 | `vendor/deps` 只带 win32-x64 prebuild；换平台要重新裁一份，锚点不用改 |

**验证**：`tsc --noEmit` 只报 `../paths.js`（本包是 source drop，不含 `src/paths.ts`），
`grammar.ts` 本身零语法错误。
