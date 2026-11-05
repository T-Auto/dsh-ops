# AST 引擎：`ops_ast_locate`、`ops_ast_refactor`、`ops_ast_audit`

三个按语法树（而非文本）读写源码的工具。它们**在进程内**作答：一次针对已在内存中的字节做
Tree-sitter 解析，比启动 native worker 更便宜，因此不启动子进程，也不经过 confinement 环节。

English: [ast-engine.md](ast-engine.md)

## 为什么放在进程内

`ops_grep` 与 `ops_replace` 已经覆盖文本搜索与字面替换。结构化工具的价值只在于**知道节点种类**——
能区分定义与引用，也能区分空白改动与语义改动。这件事就是对一个小文件做一次解析，实测约 0.5 ms；
走 native worker 路径要多付一次进程启动（约 30–50 ms）。

引擎自身不做隔离。native worker 路径执行的每一道围栏，这三个工具同样执行，顺序也相同：

1. 权威的会话身份与绝对 cwd；
2. 一次 `sandboxPolicy.resolve()` 调用，随后校验其 mode 是否在白名单内；
3. 对每个调用者点名的路径——`file`、`beforeFile`，以及 `roots` 的每一项——先过凭证围栏，再过锚定检查；
   先判词法路径，再判解析出的真实路径；
4. **遍历同样剪枝凭证目录**：逐参数围栏看不到目录遍历，所以遍历本身跳过这些树，候选清单在读取任何
   文件之前再过滤一次；
5. 写意图（`ast_refactor` 且 `mode: "apply"`）要求 `workspace-write`，且只有工作区可以接收写入：
   会话 cwd 是读范围而非写授权，工作区之外的 cwd 不能为一次提交背书。

`@ast-grep/napi` 在第一次 `ast_*` 调用时加载，绝不在启动期加载。加载失败时这三个工具返回
`EXECUTOR_UNAVAILABLE`，插件其余功能不受影响。

## `ops_ast_locate`

在会话 cwd 以下的树里，按精确标识符查找符号定义。这里的“定义”指函数、类、方法、构造函数，以及值为函数的声明；
裸的 `const NAME = 1` 不算定义，返回零命中——那种查找用 `ops_grep`。

| 参数 | 含义 |
| --- | --- |
| `symbol` | 必填。精确标识符，例如 `locateSymbol`。定义优先于引用。 |
| `file` | 只搜一个文件，而不是整棵树。 |
| `roots` | 搜索根，相对会话 cwd，且必须在其内部。默认即 cwd。 |
| `ext` | 扩展名，例如 `["ts","py"]`。默认覆盖所有已注册语言。 |
| `limit` | 1–500 条，默认 5。 |
| `body` | `false` 只给签名，`true` 给整个节点，或给出行数。 |
| `continuation` | 扫描被截断时返回的不透明游标，续扫时其余参数必须保持不变。 |
| `skipDirs` | 永不进入的目录名，例如 `["dist","vendor"]`。 |

返回 `hits[]`（`file`、`lang`、`lines`、`signature`，可选 `body`），以及 `scanned`、`truncated`、
`pruned`、`continuation`。被 `limit` 截断的遍历报 `truncated: true`：此时列表不是完整命中集。预筛后候选超过 48 个时只解析前 48 个；此时 `pruned: true` 会明说，
而不是悄悄返回一个过短的列表。

## `ops_ast_refactor`

用 ast-grep 模式与重写模板做结构化改写。

| 参数 | 含义 |
| --- | --- |
| `pattern` | 必填。带元变量的 ast-grep 模式，例如 `console.log($A)`。 |
| `rewrite` | 必填。替换文本；`$A` 展开为匹配到的元变量。 |
| `mode` | `preview`（默认）只回报计划、不写盘；`apply` 才写。 |
| `detail` | 附带每个文件的结构差异。 |

回执带 `matched`、`planned`、`remaining`，被 `limit` 截断的运行会说明自己留下了多少工作，而不是看上去做完了。
`apply` 用 `O_NOFOLLOW` 打开每个目标一次，通过该描述符读取字节，并在 rename 前拒绝 inode 已变化的目标
（`E_STALE`，不覆盖任何内容）；目标变成链接时拒绝而不是跟随。
每个文件一次原子替换：写入同目录临时文件、fsync、再 rename。BOM、行尾与权限位在提交时从真实文件
读取，绝不取自调用方。**属主、ACL、xattr 与硬链接不保留**：rename 发布的是新 inode，本引擎刻意
不搬 native worker 那套元数据处理。第一次写入成功后
再失败，会返回 `effectState: "partial"`，并在 `filesApplied` 里列出已经提交的文件，因此重试不会悄悄产生重复编辑。

## `ops_ast_audit`

比较同一个文件的两个版本。`file` 与 `beforeFile` 都必填，都相对会话 cwd。返回 `formatOnly`、
`nodesBefore`、`nodesAfter`、`nodesChanged`。

`formatOnly: true` 表示改动**只有空白**。注释本身是一个节点，增删注释会被算作结构改动——工具如实
报告，不去猜意图。它从不写盘。

## 错误

失败是返回值，带 `error.code`、`error.effectState`、`error.retryable`，从不抛出。

| 错误码 | 含义 | 可重试 |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 缺少必填参数，或该名字不是 AST 工具。 | 否 |
| `POLICY_DENIED` | 只读会话下执行 `apply`，或点名路径在工作区与会话 cwd 之外。 | 否 |
| `PATH_RESTRICTED` | 点名路径经 junction/symlink 解析后落在工作区之外。 | 否 |
| `CREDENTIAL_DENIED` | 点名路径命中凭证围栏。 | 否 |
| `EXECUTOR_UNAVAILABLE` | 无会话身份、无策略服务，或 `@ast-grep/napi` 未加载。 | 否 |
| `E_STALE` | 计划与提交之间文件被改动，未写入任何内容。 | 否 |
| `E_NO_MATCH` | 未找到定义；`continuation` 可续扫截断的扫描。 | 换查询后可 |
| `E_BINARY` / `E_ENCODING` | 该文件不是 UTF-8 文本。 | 否 |
| `E_ROOT_OUTSIDE` | `roots` 中某项离开了会话 cwd。 | 否 |
| `RESULT_UNKNOWN` | 引擎失败且没有确定的回执。应先核对后置状态。 | 先核对 |

## 呈现面

这三个名字只发布在 **Native** 呈现面。PTC 输出是给沙箱代码按严格类型 schema 读取的，而它们没有
声明任何 PTC 投影：从 PTC 代码里调用 `ops_ast_*` 会看到“没有这个工具”，而不是一个类型不对的工具。
