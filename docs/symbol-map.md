# symbol_map：内置符号表

`symbol_map` 是 `FILE_TOOLS` 里唯一在进程内作答的成员。它不 spawn `runtime/<platform>/dsh-ops-file`：一次 Tree-sitter 查询跑在已经握在手里的字节上，子进程的启动成本比查询本身还高。

## 内置位置

引擎和工具层都在宿主 `src/` 内，不再有 `packages/ops-symbol-map/`：

| 路径 | 内容 |
| --- | --- |
| `src/symbol-map/` | 引擎本体（`engine` / `query` / `grammar` / `snapshot` / `cache` / `files` / `walk` / `types` / `errors` / `index`） |
| `src/file/symbol-map.ts` | 工具层：参数归一、围栏、回执 |
| `src/file/reparse.ts` | reparse point 拒绝（与原生 worker 同一措辞） |

外部只从 `src/symbol-map/index.ts` 取符号，模块拆分是内部实现细节。

语法包仍然是 **可选 peer**，不是 `dependencies`：没有 C++ 工具链的机器必须能安装并启动插件。解析器在第一次使用时才加载，锚点顺序是 `<包根>/package.json` → `<包根>/vendor/deps/package.json`，可用 `DSH_OPS_SYMBOL_MAP_ROOT` 覆盖。缺语法包时返回 `EXECUTOR_UNAVAILABLE`，附安装命令。

## 工具名

- 原生名 `symbol_map`，公开名由 `publicToolName()` 给出（`ops_symbol_map`）。
- 注册表：`src/capabilities/registry.ts` 的 `fileOrder` 排在 `read_files` 之后，`availability: 'resident'`（与 `read_files` 一样常驻，不参与按需发现）。
- 参数（`src/capabilities/file.ts` 的 `PARAMETERS.symbol_map`）：`path`（必填）、`scope`（`"START-END"`）、`lang`、`offset`、`limit`、`name`、`extended`。

## 接线点

`src/file/worker.ts` 的 `invokeTrusted()` 在确认 session/cwd 之后、创建 `policyService` 之前分流：

```ts
if (tool === 'symbol_map') return invokeSymbolMap(ctx, args, exec, signal, config)
```

分支在「只为 spawn 服务的检查」之前，因为这里没有 spawn；`invoke()` 已经把结果会话和调用预算绑好，工具层不再重入 `withResultSession` / `withCallBudget`。

## fence 顺序

顺序本身就是安全属性，不能调换：

1. session 身份 + 绝对 `cwd`
2. 一次权威 policy 解析 + mode 白名单
3. 参数归一化，然后恰好一个绝对目标路径
4. 凭据围栏 —— **在锚定之前**，否则一个链接就能给密钥文件洗白
5. 锚定到 workspace/cwd/tmp，**不** realpath 调用方选中的父级

第 4 步必须在第 5 步之前：`anchoredPath` 可能返回一个不存在的路径，而 `credentialPath` 匹配的是**被请求的名字**；顺序反过来，`project/key -> ~/.ssh` 会先过锚点、再以锚点结果为名通过凭据检查。

锚定之后还有两道：`reparseEscape` 逐段 `lstat`（与原生 worker 的 `open_nofollow` 同义），以及一次 `realpathSync.native` 窄窗复核，把「实际会被读的路径」拉回真实路径再测一次包含关系与凭据。

全程同步：resolve 到 parse 之间不 `yield`（`readFileSync` + 惰性 `require` + 查询），所以不像 `invokeTrusted` 那样需要二次 policy 解析。一旦这条路径变成异步，二次解析必须一起回来。

## fileHash 语义

回执同时给两个指纹，分工不同：

| 字段 | 计算 | 用途 |
| --- | --- | --- |
| `revision` | 整份被解析字节的 SHA-256 | 权威身份；写工具的 `expectedRevision` 用这个 |
| `fileHash` | ≤100 KiB 直接复用 `revision`（零额外 IO）；更大时取头 50 KiB + 尾 50 KiB 的 SHA-256 | 便宜的轮询指纹 |

- `fileHashScope: "head+tail"` 只在后一种情况下出现；省略即 `full`。
- `fileHashBytes` 只在头尾字节数与文件字节数不同时出现。
- 解析与哈希之间文件可能被删或被独占：此时回退成 `revision` 并把 scope 标成 `full` —— 宁可少一个标记，也不因一次额外 IO 把成功解析判成 `IO_ERROR`。
- 头尾指纹抓不到「只改中段、头尾长度不变」的修改，这类改动由 `revision` 负责。

## 分页

- `limit` 缺省 **512** 行（`DEFAULT_LIMIT`），另有 96 KiB 的字节预算（`DEFAULT_BUDGET_BYTES`）：两个界各自独立，单靠一个都会被另一个绕过。
- `offset` 0 基；`nextOffset` 续页。
- `name` 过滤是**大小写敏感**的子串匹配；过滤后再分页，`total` / `omitted` / `nextOffset` 描述的都是过滤后的集合。

## 验证

```bash
npm run typecheck
node --experimental-strip-types -e "import('./src/file/symbol-map.ts').then(m => console.log(typeof m.invokeSymbolMap))"
```
