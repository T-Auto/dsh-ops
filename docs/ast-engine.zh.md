# AST 引擎

[English](ast-engine.md)

`src/ast/` 是 PR #443 引入的进程内 AST 引擎：枚举候选文件、定位符号、改写命中的子树、
审计结果，最后提交字节。它是仓库源码而不是独立的 npm 包，运行时只依赖根清单与锁文件里
固定为 0.51.0 的 `@ast-grep/napi`。

它**不是** PTC 执行内核。`src/ptc/` 仍然是 PTC 投影（类型化 SDK、Outcome 契约、worker
调用）；本引擎是宿主可以架在任一投影之上的工具提供方。当前仓库尚未接线——见“边界”。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/ast/inproc.cts` | AST 定位与改写；进程内引擎入口 |
| `src/ast/enumerate.cts` | 有界 walk / Everything `es.exe` 枚举及其缓存 |
| `src/ast/astdiff.cts` | 进程内语法审计（difftastic 的零 fork 替代） |
| `src/ast/stages.cts` | 大树与非 TS 语言使用的五段流水线 |
| `src/ast/pipeline.cts` | 编排、熔断、回滚 |
| `src/ast/safe-write.cts` | 快照校验、协作锁、独占临时文件、原子 rename |
| `src/ast/proc.cts` | 唯一的 `spawn` 出口：参数数组、CRLF/BOM/EOL 收口、`es.exe` 候选链 |
| `src/ast/reparse.cts` | 拒绝 symlink、junction 等重解析点 |
| `src/ast/engine-load.cts` | `@ast-grep/napi` 惰性解析的第二锚点 |
| `src/ast/tools.cts` | `tools_addition` 元数据与五个工具 handler |
| `src/ast/adapter.cts` | 宿主 Outcome 信封（completed / partial / rejected / error / unknown） |
| `src/ast/cli.cts` | `ops-ast` 命令行（locate / refactor）；没有 MCP stdio 出口——见“边界” |
| `src/ast/schema.json` | 五个 `inputSchema`，以纯数据随包分发 |
| `src/ast/agentbox.worker.cts` | 唯一执行落盘的进程；stdin JSON → 原子 rename |

## 构建

`npm run build` 将 `.cts` 源码（含 AgentBox worker）编译为 `lib/ast/*.cjs` 并生成
`.d.cts` 声明，`schema.json` 走统一资源复制。CommonJS 保住 worker 的 `__dirname` 拉起
方式与引擎现有的 `require` 消费方；插件其余部分仍是 ESM。

```console
npm ci --ignore-scripts
npm run build
node test/run.mjs ast-            # 只跑本引擎的套件
node lib/ast/cli.cjs --help
```

发布包导出 `dsh-ops/ast`、`dsh-ops/ast/inproc` 和 `dsh-ops/ast/tools`；`ops-ast`
可执行文件指向同一个编译后的 CLI。

## 测试与基准

十一套测试位于 `test/ast-*.test.mjs`，随常规门禁运行，一文件一进程，使用临时 fixture 树。
子进程对照使用固定开发依赖 `@ast-grep/cli` 0.51.0；测试直接解析平台二进制，兼容
`--ignore-scripts` 安装。基准位于 `bench/ast/`，不进入默认门禁，输出写在新的临时目录或
`PTC_BENCH_OUT`；其中若干项需要真实外部工具和通过 `PTC_TREE` 提供的只读语料。

## 外部工具

`es.exe`（Everything CLI）是可选的，只有 `everything` 策略会用到；`walk` 策略自足。
`strict` 对账与对照基准需要 `sg`。`difftastic` 可选：缺席时审计退回进程内行对齐，而不是
编造数字。工具缺失会被如实报告，不会被静默算作通过。

## 边界

五个 `ops_ast_*` 工具已经通过宿主路径在进程内应答：`src/execution/ast-inproc.ts` 由两条执行桥
（`src/execution/files.ts`、`src/execution/jobs.ts`）在任何 worker 启动与策略解析之前分派，
因此一次 AST 定位或改写不会拉起子进程。该适配层就是可信桥，按与原生 worker 相同的顺序施加
四道围栏：会话身份与绝对 cwd、一次权威策略解析加模式白名单、锚定之前的凭据防护、写意图必须
workspace-write。非 `danger-full-access` 下每个具名文件与枚举根都必须落在工作区或会话 cwd 之内
——按真实路径判断，指向外部的 junction 会被拒绝。

这里刻意不提供 MCP stdio 服务。原型阶段曾有，但独立 stdio 端点调用 handler 时不经过
沙箱策略、凭据防护与宿主授权——正是 dsh-ops 在 0.3.2 移除 FastCtx 及其 MCP 客户端时
要堵死的那条绕行路径。模型可见的工具面必须位于 `createHostTools`/`registerHostTools`
和可信桥之后，绝不能挂在宿主没有打开的套接字上。
