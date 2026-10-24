# Changelog

All notable changes to this package are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Stop `dsh-ops-hide-official` from blocking a `run_code` (PTC) scope when `replaceTools` is set. That scope presents one program entry, and the selected counterparts are SDK functions rather than owned native providers, so readiness could never be proven and every PTC session failed prompt assembly with `READINESS_BLOCKED` as soon as one tool was selected. Readiness is now judged on the assembled surface: a scope that really kept a selected official tool still fails closed, while a collapsed scope's transport is not gated and the selected official names stay refused there.
- 修复 `dsh-ops-hide-official` 在设置 `replaceTools` 后阻塞 `run_code`（PTC）作用域的问题。该作用域只呈现一个程序入口，所选替代工具是 SDK 函数而非已拥有的 native provider，就绪状态永远无法成立，只要选择了一项工具，每个 PTC 会话的提示词组装都会以 `READINESS_BLOCKED` 失败。现在改以装配出的表面判定：真正保留了所选官方工具的作用域仍然失败闭合；折叠作用域的 transport 不再被门禁阻塞，所选官方工具在该作用域内仍被拒绝。
- Make the Windows CI leg non-blocking while keeping it running on every event (#316): split `validate` into blocking `validate-posix` (Linux x64, macOS arm64) and `continue-on-error` `validate-windows`, and keep `ci-required` from depending on any `continue-on-error` job, so the aggregate neither waits for nor fails with the slowest leg. On `main` after #307 the Windows leg takes 527 / 529 s — up from 482 s before #307, because `npm ci` now downloads the 411 MB Windows Bash payload — against 136–139 s (Linux) and 168–182 s (macOS). `scripts/check-workflows.mjs` now enforces "every blocking job in the aggregate, no non-blocking job in it" and that the aggregate's failure loop names exactly the blocking jobs, so a job cannot stay in `needs` but escape judgement; the Windows result is a signal to act on, not a merge gate.
- 将 CI 的 Windows 腿改为非阻塞、但仍每次触发都运行（#316）：把 `validate` 拆成阻塞的 `validate-posix`（Linux x64、macOS arm64）与 `continue-on-error` 的 `validate-windows`，并让 `ci-required` 不依赖任何 `continue-on-error` job，聚合既不等待也不随最慢的一腿失败。`main` 在 #307 合入后实测 Windows 腿 527 / 529 秒（#307 之前 482 秒，因为 `npm ci` 现在要拉 411 MB 的 Windows Bash 载荷），Linux 136–139 秒、macOS 168–182 秒。`scripts/check-workflows.mjs` 现在强制“每个阻塞 job 都在聚合里、聚合里没有非阻塞 job”，并要求失败判定循环里的 job 集合与阻塞集合完全相等，避免 job 留在 `needs` 却逃过判定；Windows 结果是待处理的信号，不是合并门禁。
- Bound each `ops_replace` output to the same 32 MiB UTF-8 byte ceiling as file writes. Check expansion with overflow-safe arithmetic for the entire plan before constructing replacement content or publishing any file, including dry runs; an over-limit target returns `OUTPUT_LIMIT` with no file changes (#330).
- 将 `ops_replace` 的每个文件产出限制为与文件写入相同的 32 MiB UTF-8 字节上限。在构造替换内容或发布任何文件前，使用检查溢出的算术核验整个计划，dry-run 使用相同口径；任一目标超限即返回 `OUTPUT_LIMIT`，不修改任何文件（#330）。
- Anchor a POSIX-style absolute `workdir` on Windows sessions (#318). bash itself writes `/d/…` for `D:\…` and models follow that spelling, but the `/`-rooted form slipped past the `driveRooted` escape in `sessionWorkdir` and reached the executor unchanged, where Node's `fs` read it against the *host process's* current drive: with no such directory there, a path that exists was reported as `must be an existing directory`; with a decoy directory there, the command ran in the wrong tree with exit 0. The drive-letter form (`/d/x`, `/d`) is now mapped onto `D:\x` and anchored and validated like any other absolute path; a drive-less POSIX absolute (`/`, `/tmp/x`) is refused with the reason and the accepted spellings, so nothing silently falls back to an unrelated drive. Forward-slash UNC (`//server/share`) keeps its passthrough, `\child` and `D:child` keep their #180 anchoring, and POSIX sessions are unchanged.
- Windows 会话上的 POSIX 风格绝对 `workdir` 现在正确锚定（#318）。bash 自身把 `D:\…` 写作 `/d/…`，模型也沿用这种写法；但 `/` 开头的形态躲过了 `sessionWorkdir` 里为 `\child` 设的 `driveRooted` 分支，原样到达执行器后被 Node 的 `fs` 按**宿主进程当前盘**解读：那里没有目录时，明明存在的路径被报成 `must be an existing directory`；那里恰有同名目录时，命令会在错误的目录里 exit 0 静默执行。现在带盘符的写法（`/d/x`、`/d`）会映射为 `D:\x`，与其它绝对路径走同样的锚定与校验；无盘符的 POSIX 绝对路径（`/`、`/tmp/x`）被显式拒绝并说明原因与可接受写法，不再静默落到无关盘符。正斜杠 UNC（`//server/share`）维持原样透传，`\child` 与 `D:child` 保留 #180 的锚定语义，POSIX 会话行为不变。
- Preserve caller-installed tool precedence after the required private MSYS `usr/bin`, before optional bundled `ucrt64/bin` and `cmd` programs (#364). Clarify that `script_path` always uses Bash. Supply empty stdin through a closed pipe instead of Windows NUL, retaining EOF semantics while avoiding the reported MSYS fd-0 device initialization condition (#372).
- 保持用户自行安装工具的优先级：仅必要的私有 MSYS `usr/bin` 在前，可选的 `ucrt64/bin` 和 `cmd` 排在用户 PATH 后（#364）。明确 `script_path` 始终使用 Bash。空 stdin 改用立即关闭的管道，保留 EOF 语义并避免报告中的 MSYS fd-0 设备初始化条件（#372）。
- Add concise, field-level help to discoverable core file-tool input schemas, including quoted glob-array examples, regex/literal distinctions, search defaults and preview semantics. Keep resident `read_files`, validation constraints and runtime behavior unchanged; improved guidance does not guarantee model-generated JSON correctness (#328).
- 为按需发现的核心文件工具输入 schema 补充简短字段说明，包括带引号的 glob 数组示例、正则与字面量的区别、搜索默认值和预览语义。常驻 `read_files`、校验约束和运行时行为不变；改善指引不代表保证模型生成的 JSON 一定正确（#328）。
- Report unsupported update locks as `LOCK_UNSUPPORTED` instead of a misleading `REVISION_CONFLICT`; actual writes on filesystems without the required lock support remain refused (#326).
- 文件系统不支持所需更新锁时返回 `LOCK_UNSUPPORTED`，不再误报 `REVISION_CONFLICT`；此类文件系统上的实际写入仍然被拒（#326）。

- Restore UNC directory enumeration for `ops_glob`, `ops_grep` and directory-level `ops_replace`: enumerate through the validated display path, verify before and after that it still names the opened directory, and report `PATH_CHANGED` instead of a possibly complete empty result (#326).
- 恢复 `ops_glob`、`ops_grep` 与目录级 `ops_replace` 的 UNC 目录枚举：通过已校验的 display 路径枚举，并在枚举前后校验它仍指向已打开的目录；目录被替换时返回 `PATH_CHANGED`，避免将替换后的目录误报为完整结果（#326）。
- Use `ops_bash`'s description as the host job label, and include the same label in background/promoted results and their rendered text (#322). Keep command/script/default fallbacks for internal callers without a description; document migration from the retired OPS background tools to host job controls.
- `ops_bash` 使用任务说明作为宿主 job 标签，后台及超时转后台的返回值和显示文本同时带上该标签（#322）。内部调用未提供说明时保留命令、脚本路径及默认名称回退，并补充旧 OPS 后台工具迁移到宿主任务控制的说明。
- Keep `ref://` result references usable on Linux hosts whose sandbox runs workers under bwrap (#337). bwrap gives workspace-write children a private tmpfs over `/tmp`, so the PTC worker behind `ops_result` never saw the session cache that the host keeps below `tmpdir()`: every page returned `REFERENCE_EXPIRED`, and the session purge silently left the cache behind. The worker argv now binds exactly that one private (0700, owner-checked) cache directory back in, for page/put and for the session purge. Landlock, Seatbelt, Windows and read-only bwrap are unchanged.
- 修复 Linux 宿主沙箱走 bwrap 时 `ref://` 结果引用不可用（#337）：bwrap 给 workspace-write 子进程挂了私有 tmpfs `/tmp`，`ops_result` 背后的 PTC worker 看不到宿主放在 `tmpdir()` 下的会话缓存，于是每次分页都报 `REFERENCE_EXPIRED`，会话清理也悄悄把缓存留在原地。现在 worker 的 argv 只把这一个私有（0700、校验属主）缓存目录重新绑定进去，分页/写入和会话清理都覆盖。Landlock、Seatbelt、Windows 与只读 bwrap 行为不变。
- Classify Native file and `ops_result` outcomes in the OPS TUI sidebar from bounded, replayable presentation metadata rather than compact model text. Preserve PTC child JSON handling and exclude paths, content and error messages from the metadata; cover the producer and consumer in always-on tests and the real dsh-TUI host loop (#339).
- OPS TUI 侧栏通过有界、可重放的展示元数据识别 Native 文件工具和 `ops_result` 的业务结果，不再尝试解析面向模型的精简文本。保留 PTC 子调用的 JSON 处理，元数据不含路径、正文和错误消息；补充 CI 必跑的生产/消费回归及真实 dsh-TUI 宿主闭环测试（#339）。
- Distinguish ordinary nonzero Bash exits (`failure.code: EXIT_CODE`, `retry: after-input-change`) from interrupted or unavailable execution. Keep failed command status and unknown side effects, but let callers inspect output and correct inputs instead of categorically forbidding another command. Timeout, cancellation, signal death and execution refusals retain their existing retry guidance (#331).
- 将 Bash 正常结束但退出码非零（`failure.code: EXIT_CODE`、`retry: after-input-change`）与执行中断或执行器不可用区分开。保留失败状态和副作用未知，不再一概禁止再次调用，而是指导先检查输出并修改输入；超时、取消、信号终止和执行拒绝的重试语义不变（#331）。
- Retry a quarantined Bash IPC generation with a bounded backoff (100/200/400/800/1000 ms, about 2.5 s in total) instead of stranding it on the first refusal. On Windows a freshly written generation can stay un-renamable for about 1.5 s — observed up to 1.64 s: the same rename that raises `EPERM` at +2 ms succeeds later, from another process too, so a single attempt turned a recovery the cache would have finished a moment later into "could not be quarantined" and failed the `bash-ipc` suite with it (#352). The budget is deliberately above that worst measured sample; only `EPERM`/`EBUSY`/`EACCES` are retried, and the publish rename uses the same helper.
- 隔离 Bash IPC generation 时改用 100/200/400/800/1000 ms 有界退避重试（累计约 2.5 秒），不再因第一次拒绝就把缓存搁置。Windows 上新写入的 generation 约 1.5 秒内不可改名——实测最坏到 1.64 秒：同一条 rename 在 +2 ms 报 `EPERM`、稍后成功（换进程同样如此），单次尝试会把本可稍后完成的恢复变成 "could not be quarantined"，`bash-ipc` 套件也随之变红（#352）。预算刻意高于这一最坏样本；只对 `EPERM`/`EBUSY`/`EACCES` 重试，发布用的 rename 走同一助手。

- Relicense the current distribution as MIT. FastCtx was removed in 0.3.2, so the composite `MIT AND Apache-2.0` statement no longer describes the code; earlier releases keep their own notices, and FastCtx's Apache-2.0 text and required attribution remain in `licenses/fastctx/` and `NOTICE` for them.
- 当前发行版改为 MIT 许可。FastCtx 已在 0.3.2 移除，复合 `MIT AND Apache-2.0` 不再描述现有代码；早期版本保留各自声明，FastCtx 的 Apache-2.0 文本与要求转载的归属仍保留在 `licenses/fastctx/` 与 `NOTICE` 中。

## [0.4.1] — 2026-10-20 — Update locks stop leaving files behind

- Stop the update lock from leaving `.dsh-ops-update-*.lock` sidecars behind (#319). The writer that takes the lock removes it on release, and only after proving the name still leads to the inode it locked, so a waiter that opened the old inode can never publish under it. A published write, a request refused after the lock and a directory-wide `replace` now leave the directory exactly as they found it; a sidecar left by a killed writer is not a stuck lock — the next write of that name binds to it, publishes under it and removes it.
- 更新锁不再在目录里遗留 `.dsh-ops-update-*.lock`（#319）：持锁的写者在释放时删除它，并且先确认名字仍指向自己锁住的 inode，因此打开过旧 inode 的等待者不会在它上面发布。成功写入、拿锁之后被拒的请求、整目录 `replace` 都不再留下痕迹；被硬杀的写者留下的边车不是死锁——下一个同名写入会锁定它、用它发布并删除它。

- Restore `ops_bash` background jobs. The tool read the host `jobs` registry at definition time and then required `ctx.get('jobs')` to be identity-equal at call time; a tracked Cordis service returns a fresh traceable proxy on every read, so the comparison could never hold and every `run_in_background` call failed with `EXECUTOR_UNAVAILABLE` while the schema still advertised the parameter, and a foreground timeout killed the command instead of promoting it. Bind the registry once through `ctx.inject(['jobs'], …)`, exactly as the host's own bash tool does, and pass it into the definition; re-register when the service mounts or unloads. Regression tests cover the tracked-service proxy, background admission, and timeout promotion.
- 恢复 `ops_bash` 的后台任务能力。原实现定义工具时读取一次宿主 `jobs` 注册表，执行时要求 `ctx.get('jobs')` 与它身份相等；Cordis 的被跟踪服务每次读取都返回新的 traceable proxy，比较永远不成立，于是 schema 声明了 `run_in_background` 却必然报 `EXECUTOR_UNAVAILABLE`，前台超时也只会杀进程而不会转后台。改为像宿主自带 bash 一样经 `ctx.inject(['jobs'], …)` 只绑定一次注册表并传入工具定义，服务挂载/卸载时重新注册；补了被跟踪服务代理、后台受理与超时升级的回归测试。

- Restore extended attributes before the replacement's final mode, so a read-only file keeps its `user.*` attributes and macOS stops reporting `com.apple.provenance` unrestored on every `0400` replace. The mode matrix now carries a user attribute, so the order is asserted on every host rather than only where macOS supplies that attribute for free (#324).
- 恢复扩展属性时改在写入最终模式之前进行，只读文件不再丢失 `user.*` 属性，macOS 的 `0400` 替换也不再报告 `com.apple.provenance` 未恢复；模式矩阵用例改为携带用户属性，使该顺序在所有平台都受断言约束，而不只依赖 macOS 自带的属性（#324）。
- Stop inventing audit references for new batch validation failures that occur before a job is saved, and for synchronous failures before worker creation. Preserve worker-provided references, existing resume identities and recovery ids for interrupted or ambiguous execution; no additional worker calls are made (#78).
- 新批次在审计记录创建前发生已确认的校验失败，或工作进程创建前同步失败时，不再返回不存在的审计引用。保留 worker 返回的引用、已有 resume 标识，以及执行中断或状态不明时的恢复标识；不增加 worker 调用（#78）。
- Validate the selected profile CLI before both dry-run and execution (#100): reject missing or unusable launchers and missing Node bin targets, preserve PATH lookup and Windows PATHEXT/batch launchers, and apply Windows command-script path checks during preview. Dry-run never executes the candidate or changes the profile.
- 在安装/卸载的预演与实际执行前共用 CLI 静态检查（#100）：拒绝缺失或不可用的启动文件及缺失的 Node bin 入口，保留 PATH 查找与 Windows PATHEXT/命令脚本，并在预演时同样检查 Windows 命令脚本路径。预演不启动候选程序、不修改 profile。

- Fix the generated `ops_load_sdk` declaration (the builder still keyed on the pre-rename `sdk` name), cover the rename alias plus the `select:` and SDK request paths with tests, and align the catalogue facts in the current docs (20/18/15, 242 tokens/1101 bytes) with a docs guard (#302).
- 修复生成的 `ops_load_sdk` 声明（构建脚本仍按改名前的 `sdk` 判定）、为改名别名与 `select:`/SDK 请求路径补测试，并把当前文档的目录事实（20/18/15、242 tokens/1101 bytes）对齐并加守护（#302）。
- Account for existing append-log and new-session header bytes before admitting queued panel events, with bounded pending data and physical-stop behavior. Recover persisted caps without appending further events or duplicate markers. If opening the log fails, stop that capture without appending or replacing existing output. JSON parse losses now mark capture degraded and usage incomplete while preserving valid records and totals.
- 面板恢复先计入已有追加日志或新会话头部的字节，再接纳排队事件，保留有界待写数据与实际停止语义；恢复已封顶日志时不再追加事件或重复的封顶标记。日志初始化失败后停止该会话的采集，不再追加或替换已有输出。JSON 解析丢失的记录现在会标记采集降级、用量不完整，同时保留有效记录及其合计。
- Add `dsh-ops panel [--serve] [dir] [--port <n>]`: serve one capture directory and the shipped viewer on loopback, preselect the newest valid report, offer the other valid reports for switching, refuse malformed reports and paths outside the directory, and document the capture-directory `.gitignore` and drag-and-drop fallback (#257).
- 新增 `dsh-ops panel [--serve] [dir] [--port <n>]`：在回环地址上服务一个采集目录与随包查看器，默认选中最新有效报告并列出其它有效报告供切换，拒绝格式错误报告与目录外路径，并补充采集目录的 `.gitignore` 与拖拽回退说明（#257）。

- Require one CI run per pull request: the PR template now asks for the URL of the `CI required` aggregate run triggered by the pull request's own `pull_request` event, and the contributing guides document how to confirm it (`gh run list --branch <branch> --event pull_request`, the PR checks tab), the fork path from #150, the `action_required` approval for first-time fork runs, and the admin-only repository setting that makes `CI required` a required check (#303). Documentation and process only; no workflow or runtime behavior changes.
- 每个 PR 必须有一次 CI 运行：PR 模板改为要求贴出由 PR 自身 `pull_request` 事件触发的 `CI required` 聚合 run URL；贡献指南说明如何确认（`gh run list --branch <branch> --event pull_request`、PR checks 页）、#150 的 fork 路径、首次 fork 运行的 `action_required` 批准，以及把 `CI required` 设为必需检查的 admin 仓库设置（#303）。仅文档与流程变更，不改工作流与运行时行为。
- Rename 0.4.0 tools for consistent `verb_noun` naming: `read_many`→`read_files`, `table_read`→`read_table`, `doc_read`→`read_docx`, `pdf_read`→`read_pdf`, `sdk`→`load_sdk`, `discover`→`discover_tools`; merge `edit_many` into `edit_file`. Old raw names in user profiles are silently migrated.
- 将 0.4.0 工具重命名为一致的 `verb_noun` 形式：`read_many`→`read_files`、`table_read`→`read_table`、`doc_read`→`read_docx`、`pdf_read`→`read_pdf`、`sdk`→`load_sdk`、`discover`→`discover_tools`；`edit_many` 合并入 `edit_file`。用户配置中的旧名会静默迁移。
- Enable the shell row by default on all three supported platforms: Windows runs the pinned Bash payload declared by the main package, Linux/macOS run the distribution's Bash (overridable with `config.bashPath`), and PowerShell stays host-managed.
- shell 行恢复为三个受支持平台默认开启：Windows 使用主包声明的固定 bash 载荷，Linux/macOS 使用发行版自带 bash（可用 `config.bashPath` 覆盖），PowerShell 仍由宿主管理。
- Restore the Windows Bash npm optional payload: the main package declares `@dsh-ops/bash-win32-x64@0.2.1` in `optionalDependencies`, so npm install brings the pinned PortableGit (GNU bash 5.3.15); `bash-runtime`/`provision-shells` and the runtime settings pages remain the selection and repair path. POSIX keeps the system Bash and PowerShell stays host-managed.
- 恢复 Windows bash 的 npm 可选载荷声明：主包在 `optionalDependencies` 中声明 `@dsh-ops/bash-win32-x64@0.2.1`，npm 安装即带固定版本的 PortableGit（GNU bash 5.3.15）；`bash-runtime`/`provision-shells` 与运行时设置页保留为选择与修复路径。POSIX 继续使用系统 bash，PowerShell 仍由宿主管理。
- Name the shell tool by its published name in the tooling policy: the routing heading and the "prefer for command execution" line said `bash` while the registry publishes `ops_bash`, so the model was shown a tool it could not call. The result row already resolved through `publicToolName()`. Reported in #298 with 15 `unknown tool "bash"` calls in one session.
- 工具策略改用真实发布的工具名指代 shell：路由标题与「优先用于执行命令」此前写 `bash`，而注册表发布的是 `ops_bash`，等于在提示词里教模型调用一个不存在的工具（结果行本来就经 `publicToolName()` 解析，没有写错）。#298 记录了一次会话里 15 次 `unknown tool "bash"`。
- Prepare the 0.4.0 candidate version across owned npm/plugin and Rust workspace metadata without dependency changes. Audit paired release, usage, component, SDK, discovery and manual-validation documentation; record the explicitly approved benchmark scope and retain historical failures separately from functional CI. No release/tag is created.
- 将自有 npm/插件与 Rust workspace 版本统一为 0.4.0 候选，不变更依赖；同步双语发布、使用、组件、SDK、发现和手动验收文档。记录明确批准的基准范围并保留历史失败，不以功能 CI 代替验收，不创建发布或 tag。
- Apply the confirmed acceptance scopes: BM-01 gates against OPS 0.3.x with official-reader comparisons reported separately; BM-03 gates file/discovery schemas while retaining startup Bash, exact full-inventory readiness and separate full totals. Preserve historical failed evidence.
- 按已确认的验收范围判定：BM-01 以 OPS 0.3.x 为准，官方读取器比较单列；BM-03 仅约束文件/发现 schema，保留启动 Bash、完整目录就绪校验及单列完整总量。历史失败证据保持不变。

- Compact each fully returned Native range's metadata receipt by removing its repeated notice label; keep exact source text, full revisions, continuation/EOF facts and the aggregate notice.
- 删除 Native 完整返回范围的逐文件元数据回执中重复的提示标签；保留精确正文、完整版本标识、续读/文件结束事实及汇总提示。

- Fetch baseline Git history in full CI gates, optional benchmark smoke and the release gate so exact 0.3.1 provenance checks work on fresh checkouts.
- 完整 CI 门禁、可选基准冒烟与发布门禁获取基线 Git 历史，确保全新检出能校验 0.3.1 的精确来源。

- Include each activated document reader in scoped routing guidance; validate real document receipts in the PTC API coverage suite.
- 在作用域路由中显示已激活的文档读取工具，并用真实文档回执验证 PTC API 覆盖。

- Keep table coverage honest beyond EOF and after metadata changes. Fresh PTC bundle pools follow
  the implemented catalogue; saved explicit operator pools remain unchanged.
- 表格超出 EOF 时只统计实际跳过的行，文件变化后不声明页面完整；新 PTC 允许池遵循实现目录，保留已保存的显式选择。

- Complete the strict TypeScript source migration and disable JavaScript compilation. Reject unimported JavaScript source during packaging while preserving published `.js` paths.
- 完成严格 TypeScript 源码迁移并关闭 JavaScript 编译；打包时拒绝未导入的 JavaScript 源码，保持发布的 `.js` 路径不变。

- Type central configuration validation, deferred profile migrations, and the remaining TUI/background entries strictly; retain their emitted paths, defaults, validation errors and lifecycle behavior.
- 将中央配置校验、延迟 profile 迁移及剩余 TUI/background 入口迁为严格 TypeScript；保留产物路径、默认值、校验错误及生命周期行为。

### Type the component host entry (#261, 16/16)

- Migrate the root component entry to strict TypeScript using public Cordis and Agent types; preserve configuration validation, scoped registration, shell denial and teardown behavior.
- 将根组件入口迁移为严格 TypeScript，使用公开 Cordis 与 Agent 类型；保留配置验证、作用域注册、Shell 拒绝与卸载行为。

### Type profile delegation and session temporary directories (#261, 16/16)

- Migrate profile commands and private temporary-directory helpers to strict TypeScript, preserving official CLI delegation and per-session path behavior; narrow malformed manifest data before use.
- 将配置档委托命令与会话临时目录辅助函数迁移为严格 TypeScript，保留官方 CLI 委托及会话路径行为，并在使用前验证 manifest 数据。


### Strict authority types ([16/16])

- Migrate credential fences, trusted path anchors and permission failures to strict TypeScript without changing emitted entrypoints or authority decisions. Preserve worker effect facts during denial normalization and assert typed host modes/unknown-input narrowing.
- 将凭据围栏、可信路径锚点和权限错误迁移为严格 TypeScript，保持生成入口和权限决策不变；拒绝归一化保留 worker 效果事实，并验证宿主模式及未知输入的类型缩窄。

### Require benchmark readiness and valid controls (#261, 16/16)

- Block startup scoring when any default Native tool is missing, duplicated or unexpected. Require successful allowed-read controls and exact effect-free denial codes, and independently decode Native source text before comparing bytes. Keep all fixtures, defaults and acceptance thresholds unchanged.
- 默认 Native 工具缺失、重复或多出时阻塞启动评分；要求允许读取对照成功、拒绝代码与无副作用事实正确，并独立解码 Native 正文后再比较字节。不改变夹具、默认值及验收阈值。

### Preserve literal backslashes in Native source lines (#261)

- Share a reversible source-line encoder across compact and general Native output so literal backslash sequences cannot be confused with tabs, control characters or Unicode separators. Canonical data and ordinary ASCII line output remain unchanged.
- 紧凑与通用 Native 正文共用可逆行编码，区分字面反斜杠序列、制表符、控制字符和 Unicode 分隔符；规范数据和普通 ASCII 行输出不变。

### Add opt-in real-host acceptance evidence (#261, 16/16)

- Run BM-01–05 with a scripted provider, exact 0.3.1 and pinned official comparators, immutable sensitivity fixtures, visible-content assertions, numerical lossless lower bounds and JSON/Markdown reports. Manual cross-platform CI uploads failed and blocked evidence; no paid model calls or default gate changes.
- 新增真实宿主 BM-01–05 按需基准、独立基线及不可变敏感性夹具；保留准确正文断言、无损字节下界和失败/阻塞证据，不调用付费模型，不改变默认门禁。

### Keep credential denial paths private (#261, BM-05)

- Omit denied paths and matching policy roots from shared preflight refusal messages while retaining rejection codes, effect state and no-retry guidance for Native and PTC.
- 凭据预检拒绝不再返回被拒路径与匹配规则；保留 Native/PTC 的拒绝代码、无副作用状态及禁止重试指引，权限边界不变。


- Check collected subprocess readers explicitly; absent output after execution remains unknown and retains PTC audit identity. 显式检查子进程输出读取器；运行后缺失输出时保留未知副作用及 PTC 审计标识。

- Type the confined Bash and workspace-preparation boundaries; reject malformed IPC proxy receipts before staging a runtime. 严格类型化受限 Bash 与工作区准备边界；代理收据格式错误时，在暂存运行时前明确拒绝。

- Add optional bilingual browser settings pages for replacement selection, discovery pools and explicit Bash/host PowerShell runtime plans. Preserve the default legacy file row; custom pages require a client carrier and unload when it is disabled.
- 新增可选双语浏览器设置页面，支持逐工具替换、发现池及显式 Bash/宿主 PowerShell 运行时计划。默认保留旧文件行；自定义页面需要客户端承载行，关闭承载行即卸载页面。
- Add an opt-in offline settings-carrier migration with exact host composition checks, original-file backups, atomic writes and recovery. The normal upgrade retains legacy file-row names and settings.
- 新增可选离线设置承载行迁移：精确验证宿主配置合成结果，备份原文件，原子写入并支持恢复。常规升级仍保留旧文件行名称与配置。

### Type panel capture and persisted records (#261, 16/16)

- Migrate panel collection to strict TypeScript while preserving queued-stop, issued-I/O waiting and explicit sealing. Count malformed persisted fields and mark incomplete capture without corrupting valid text or usage totals.
- 将面板采集迁移为严格 TypeScript，保留排队停止、等待已发起 I/O 与显式封存；错误的持久化字段计入 malformed 并标记不完整，不破坏有效正文或用量总计。

- Add discovery as the seventh bundle row; preserve existing named row overrides. Fresh defaults enable shell on every supported platform and leave panel/TUI/replacements off. Enabling a fresh panel row starts capture; explicit legacy capture:false stays inert. Provide builtin validated file/PTC/TUI configuration.
- bundle 新增第七行 discovery，保留已有带名称行覆盖。首次安装三个平台默认启用 shell，panel/TUI/替换默认关闭；启用新 panel 行即采集，旧配置 capture:false 保持不采集。补充文件/PTC/TUI 内置校验配置。

- Stop panel collection and queued filesystem work when its row or capture switch is disabled; wait for issued I/O without scheduling a final fold. Expose validated capture settings through the host editor.
- 关闭 panel 行或采集开关时停止采集及排队文件操作，等待已开始的 I/O，但不触发最终归并；宿主编辑器提供严格校验的采集设置。

- Preserve raw shell configuration through settings validation so ordinary startup and profile reload do not interpret normalized defaults as explicit inputs.
- 设置校验保留原始 shell 配置，避免启动和配置重载将规范化默认值误认为显式输入。

### Connect runtime settings actions to the host gateway (#261)

- Add typed, package-owned gateway descriptors for runtime inventory, Bash selection and explicit install/remove/PowerShell-upgrade previews. Execute only current one-use plans through host subprocess governance; preserve cancellation and partial-effect facts.
- 通过宿主网关提供运行时清单、Bash 选择和显式安装/删除/PowerShell 升级预览；仅执行有效的一次性计划，并保留取消和部分副作用信息。

### Validate and persist host settings forms (#261)

- Expose shell executor, discovery pool/always-loaded and per-tool replacement fields through detached settings descriptors and existing validators. Accepted changes persist through the host profile writer and reload the row; stale/invalid writes preserve the profile.
- 为 shell 执行器、发现允许池/常驻项和逐项替换提供宿主设置描述及既有校验；成功保存后重载对应行，版本过期或无效配置不会改写文件。

- Drain release-gate stdout and stderr concurrently so a full diagnostic pipe cannot deadlock verification; retain both streams and failing exit codes.
- 发布门禁并行读取 stdout 和 stderr，避免诊断管道写满后验证死锁；保留两路完整输出及失败退出码。

- Require exact OPS-owned Native definitions for selected official replacements, including same-schema ownership changes; preserve fail-closed provider requests while discovery completes startup readiness. Move the replacement boundary and config validator to strict TypeScript.
- 所选官方替代工具必须是 OPS 拥有的确切 Native 定义，schema 相同的所有权变化也会重新校验；发现组件可完成启动就绪检查，普通提供方请求仍严格拒绝未就绪状态。替代边界和配置校验器迁移为严格 TypeScript。

### Select official read/search replacements individually (#261)

- Replace blanket hiding with `replaceTools: []`: explicitly select reviewed `read`, `glob`, or `grep` alternatives. Unselected tools remain visible without warning lists; only selected counterparts are required for scoped readiness.
- Legacy `strict`, `scope`, and `additionalOfficialTools` remain validated but inert. Document argument/coverage differences and exclude write/edit because their CAS contracts differ. Validated built-in row forms are available; optional browser multi-selects use the explicit client carrier described above.
- 官方工具改为通过 `replaceTools: []` 逐项选择 `read`、`glob`、`grep` 替代流程；未选工具保持可见且无警告列表，只校验所选替代工具的作用域就绪状态。
- 旧 `strict`、`scope`、`additionalOfficialTools` 仅校验不生效；文档说明参数与覆盖差异，写入/编辑因 CAS 契约不同而不提供替换。内置行表单已提供严格校验；可选浏览器多选通过上文的显式客户端承载行启用。

### Leave PowerShell with its host (#261)

- Remove the PowerShell npm payload dependency, shell payload release assembly and automatic
  host executor overlay. Existing host settings, Windows PowerShell 5.1 and legacy copies stay intact.
- Add a strict TypeScript manager and `upgrade-host-pwsh` CLI with preview by default,
  explicit WinGet execution, honest exit/cancellation effects and restart/custom-path guidance.
- 移除 PowerShell 载荷依赖和宿主执行器覆盖；新增默认预览、显式执行的宿主升级命令，
  保留已有设置及旧副本，并说明取消后的未知副作用、重启与自定义路径要求。

- Return host-compatible Bash argument failures as values with stable retry/effect metadata; interrupted or failed running commands require read-only inspection before replay. Bash 参数失败返回结构化值；运行后的未知副作用禁止自动重试。

- Cancel queued job starters when host admission fails after accepting the run hook; never retry that call in the foreground. 宿主接受任务启动回调后若准入失败，取消排队启动且不转为前台重试。

### Type the shell execution and host boundary (#261)

- Migrate the new shell executor, host contract, approvals, jobs and session integration to strict
  TypeScript. Validate the published definition against the pinned SDK with type-only imports;
  retain existing emitted paths. The remaining adapters are also strict TypeScript in the completed source migration.
- 将 shell 执行器、宿主契约、审批、jobs 和会话集成迁为严格 TypeScript，以仅类型宿主导入校验公开定义；保持发布路径，剩余适配器也已完成严格迁移。

### Make Windows Bash an explicit optional runtime (#261)

- Add Bash status/install/remove and Git/managed selection commands. Removal previews by default,
  removes only receipt-marked managed versions, and refuses linked managed directories.
- Remove the automatic Bash npm payload dependency and release payload assembly. Build, CI and
  release gates explicitly acquire a pinned fixture, or validate an operator-provided offline one.
- 新增 Bash 状态/安装/删除及 Git/受管理副本选择；删除默认预览，仅移除有收据的非链接目录。移除自动 npm 载荷与发布组装，构建和门禁显式获取固定 fixture 或验证离线提供的副本。

### Reuse host Bash approvals and background jobs (#261)

- Require command descriptions and return host foreground/background/promoted result kinds, with
  120-second defaults and 600-second caps. Reuse host jobs for background work and foreground
  timeout promotion, host per-call approvals for wider access, and host subprocess governance.
- Recheck session authority after approval and confinement; retain absolute executable selection,
  verified Windows IPC compatibility, honest partial enforcement and fail-closed runtime errors.
- Keep script_path, graceMs and includeDiagnostics as documented OPS compatibility extensions.
- 必填命令描述，复用宿主前台/后台/提升结果、jobs、单次审批及 subprocess；默认 120 秒、上限 600 秒。审批与约束后重检权限，保留绝对执行器、IPC 兼容校验、如实部分约束及失败拒绝；script_path、graceMs、includeDiagnostics 为明确的 OPS 兼容扩展。

### Preserve Bash cancellation through pending confinement preparation (#261)

- Bash execution exposes one live handle for observation and settlement. Cancellation settles
  pending sandbox preparation immediately, and a late provider response cannot start a command.
  The first timeout or caller cancellation remains the reported stop cause.
- Bash 使用同一活动句柄观察和收敛；取消立即终止等待中的准备，迟到响应不能启动命令，保留最先发生的超时或取消原因。

### Type optional TUI projections and panel rendering (#261, 16/16)

- Compile bounded activity, attention, diagnostics and injected rendering under strict TypeScript;
  preserve readonly metadata, separate running/settled facts and packaged viewer paths without UI dependencies.
- TUI 与面板辅助模块严格类型化，保留只读元数据、运行/完成状态区别与资源路径，不新增 UI 依赖。

### Type Rust toolchain discovery and source builds (#261, 16/16)

- Compile Cargo discovery and explicit locked build helpers under strict TypeScript with checked
  toolchain inputs, output callbacks and numeric completion codes; retain the shipped CLI paths.
- Rust 工具链解析与显式锁定构建改为严格类型，检查输入、文本回调及退出码，发布 CLI 路径不变。

### Type the confined PTC worker boundary (#261, 16/16)

- Compile PTC policy, confinement, runner diagnostics and receipts under strict TypeScript; retain
  per-call authorization and unknown effects with audit identity when worker output is invalid.
- PTC 桥使用严格权限、限制执行与诊断类型；非法 worker 输出保留未知副作用及审计标识。

### Type the trusted Native worker boundary (#261, 16/16)

- Compile host policy, observations and Native worker invocation under strict TypeScript; reject
  non-object arguments before spawn and retain unknown effects for malformed process results.
- Native 桥使用严格宿主类型；非对象参数在启动前拒绝，非法进程结果保留未知副作用且不误记成功读取。

### Type worker resolution and Native runtime ownership (#261, 16/16)

- Compile worker discovery and Native lifecycle as strict TypeScript; preserve runtime .js paths,
  provenance checks and scoped teardown, and reject calls before runtime initialization.
- worker 解析与 Native 生命周期改为严格 TypeScript，保留发布路径和权限边界，未初始化调用返回明确失败值。


### Expose scoped DOCX paragraphs (#261, 15b/16)

- Add discoverable Native main-body paragraphs and typed PTC outcomes with explicit excluded content,
  safe prefixes on unsupported content, stable-scan-only continuation and scoped reference recovery.
- DOCX 的 Native/PTC 按需启用，明确正文范围与排除内容；缺口保留安全前缀且不伪造续取。

### Read bounded PDF text pages with honest coverage (#261, 15d/16)

- Read a documented classic-xref/standard-font PDF subset into page text and individual runs,
  with explicit exclusions, per-stream/page/aggregate limits and no OCR or layout claims.
- Preserve preceding complete pages on unsupported content, keep totals/revision conditional
  on stable full scans, and capture full pages before bounded reference spill.
- Publish discoverable-only Native PDF text and typed PTC page/run outcomes, retaining source scope,
  safe failed prefixes, forward stable-scan continuations and reference recovery metadata.
- 新增受限 PDF 文本页及 run 读取，明确排除内容和累计预算；保留此前完整页，
  仅完整稳定扫描提供总数/修订，复用只读权限与无损引用，不声称 OCR 或阅读布局。Native/PTC 按代理按需启用，保留正文缺口与类型化页数据。

### Add bounded PDF container foundation (#261, 15c/16)

- Validate a restricted classic-xref PDF grammar, exact object boundaries and bounded
  values/references before extraction; verify actual Flate output, checksum and terminator.
- Reuse the reviewed exact compression dependency without new packages. The PDF reader uses
  this foundation; the container validator alone makes no complete-text claim.
- 新增有界传统 xref PDF 容器基础，校验对象边界、引用与实际解压；复用已核验压缩依赖，
  不新增依赖包，PDF 读取器已接入此基础，容器校验本身不声明文本完整。

### Add bounded DOCX main-body worker observations (#261, 15b/16)

- Read strict DOCX main-body paragraphs and table coordinates with explicit excluded-content
  scope, bounded ZIP/XML processing, honest partial results and lossless reference spill.
- Pin ZIP/XML dependencies with defaults disabled; preserve their original license notices and
  exact release-date review. Legacy DOC, unsupported content and external resolution are refused.
- 新增有界 DOCX 正文段落/表格坐标读取，明确排除内容及部分扫描；固定经日期核验的 ZIP/XML
  依赖并保留许可，拒绝旧版 DOC 与不支持内容，复用权限、nofollow 和无损引用恢复。

### Add bounded CSV/TSV worker observations (#261, 15a/16)

- Add an ops-documents workspace crate with strict UTF-8/UTF-16 CSV/TSV decoding, positional
  string cells, physical line ranges, bounded row pages and safe preceding rows on parse failures.
- Separate complete physical scans from requested pages and reference capture; reuse no-follow,
  credential, readonly and automatic-spill boundaries without new external dependencies.
- Expose discoverable-only Native rows and typed PTC cells with full-scan-only continuations; retain
  safe prefix data beside non-resumable parse/scan gaps and preserve authority and reference metadata.
- 新增有界 CSV/TSV worker 读取，严格解码、保留原字符串与物理行范围；错误保留此前有效行，
  并分别报告扫描、分页和引用捕获完整性，不新增外部依赖。通过发现/SDK 按代理在下一步骤启用；解析缺口保留前缀且不伪造续取。

### Compact fully returned Native file ranges (#261, BM-01)

- Use exact numbered multi-file bodies, quoted shared parent paths and one full-revision/continuation receipt per file. Preserve canonical metadata and diagnostic output for clipped, failed or uncertain ranges; update current-context repeat suppression for compact line labels.
- 多文件范围以紧凑行号、带引号的共享父目录及完整版本/续读提示展示；规范数据不变，截断、失败及不确定覆盖保留诊断信息，当前上下文去重同步支持新行号格式。

### Deduplicate Native reads with current-context evidence (#261, 10/16)

- Replace repeated line bodies only when the exact successful prior read is present in the latest completed ordinary model request and every file is freshly revalidated. Keep revisions, coverage, paging notices and canonical values. Compaction, redaction, authority changes and uncertain evidence restore full output.
- Native 单文件和多文件重读仅在当前模型请求包含此前准确正文且每个文件重新验证后省略重复行；保留版本、覆盖范围、续页提示和规范数据，压缩、脱敏、权限变化或证据不足时恢复全文。

### Keep Native startup to the bounded multi-file reader (#261, 9/16)

- Publish `ops_read_many` from startup (raw name `read_many`, later renamed `read_files`); make the single-file/hex reader, search, mutations and Native result paging discoverable. Routing describes only published tools, and the trial explicitly loads its advanced operations.
- Measure compact file/discovery schemas at 242 tokens; the integrated full Windows Bash/jobs provider order is 660 tokens (catalogue order 661). The earlier full-surface 400-token requirement failed; the operator subsequently approved a file/discovery-only budget with startup Bash and full totals retained.
- Native 启动仅常驻多文件读取器；单文件/hex、搜索、修改与引用分页按需加载。路由仅描述已发布工具；含 Bash 的完整工具面曾超过原400-token门禁；操作者随后批准仅对文件/发现小计设预算，保留 Bash 启动常驻与完整总数。

### Publish progressive tools before the next real provider snapshot (#261, 7–8/16)

- Activate pending Native and PTC selections at the owning session’s committed step end, before the pinned host captures the next provider schema. Drain owned publication during ordinary assembly without replacing host methods; mark internal probes to avoid recursive waits.
- Verify Native startup, immediately following discovery, same-call SDK isolation and next-request PTC loading through the real AgentLoop with a scripted provider. The exact test-only loop dependency `0.2.0-rc.2` was published 2026-09-29.
- 修复真实宿主先组装后 pre-step 导致多延迟一轮的问题；会话提交步骤结束后发布，在下一供应商请求前完成本插件队列，保持当前 SDK 快照与作用域隔离。

### Expose canonical PTC outcomes and generated declarations (#261, 7/16)

- Wrap PTC canonical data in discriminated completed/partial/failure outcomes with stable effects
  and retry guidance. Safe continuations describe read-only retrieval without replaying mutations.
- Generate and ship type-only `dsh-ops/ptc-sdk` declarations from the same catalogue/output schemas;
  verify status narrowing, argument shapes and real worker receipts with the pinned host validator.
- PTC 返回可收窄的规范结果信封；安全续取只描述只读操作，绝不重放修改。构建并发布同源类型声明，
  保留参数、覆盖范围、副作用和重试约束。

### Load scoped PTC SDKs progressively (#261, 7/16)

- PTC owns typed file, batch and result APIs independently of the Native file row. Start with the reader, result storage/pager and SDK loader; requested advanced APIs publish only at the next agent step.
- Keep per-agent allowed pools and always-loaded selections, Native/both isolation, owned registration handoff and structured Outcome failures.
- PTC 独立提供类型化文件、批处理与引用 API；高级 SDK 按代理在下一步骤加载，支持允许池和始终加载配置，并保持 Native 隔离及结构化失败。

### Page stored references from Native file tools (#261, 6d/16)

- Add a Native page/release projection of the shared ops_result capability, independently owned by
  the file row. PTC retains put and typed data; Native descendants of PTC agents keep page-only schemas.
- Bind paging to current session cwd (or explicit original root), authority and visible producer.
  Preserve source/capture facts and tagged JSON chunks; bounded display never advances past omitted rows.
- 新增文件组件独立提供的 Native 引用分页/释放能力；PTC 保留 put。分别报告页面、原始操作与捕获完整性，
  保持会话、权限与生产工具可见性检查，显示截断时要求原偏移重试。

### Bound shared calls and expire session references (#261)

- Share two active/eight waiting worker slots across Native/PTC, recheck authority after admission,
  and cap worker execution at 30 seconds. Bind private result storage to the live host session and
  current permissions; cancel and settle calls before authority-respecting cache cleanup.
- Native/PTC 共用有界调用队列与 30 秒上限；引用绑定活动会话与当前权限，会话结束后按权限清理缓存并保留审计数据。

### Read multiple file ranges and apply atomic multi-edits (#261)

- Add read_many with 1-32 independently reported UTF-8 ranges in one worker call, current-session
  paths, credential preflight, per-file revisions/errors and explicit pending-file/line recovery.
- Add edit_many as a single-file atomic CAS edit operation with short receipts. Bound escaped
  read output using actual metadata bytes; an incomplete line retains its offset and hex guidance.
- 新增多文件范围读取与单文件原子多段编辑；逐文件报告版本、错误及未读范围，保持权限边界与短回执。

### Spill oversized canonical output into bounded session snapshots (#261, 6b/16)

- Preserve a useful head and original operation root, execution facts and mutation effects while
  storing requested file/search rows as bounded, losslessly reconstructable tagged JSON records.
- Keep original scan coverage separate from stored-page and capture completeness; quota rollback
  never leaves partial logical JSON. Cache errors remain separate from business effects.
- Authorize trusted cache roots independently of business write roots, preserving no-follow,
  credential and readonly boundaries; reference pages never create nested references.
- 大结果保留有界开头与原始根目录，并以可无损重建的分块引用缓存请求范围；区分扫描、捕获和
  分页完整性，缓存失败不覆盖业务副作用，缓存专用授权不扩大业务写入范围。

### Add private session snapshot references (#261, 6a/16)

- Add trusted-envelope `ref://session/tool/uuid` storage with 10 MiB snapshot and 100 MiB session
  quotas, serialized LRU, physical byte accounting, no-follow objects and separate durable audits.
- Recheck live authority/producer scope on access; default TTL follows session lifetime. Bounded
  pages never nest references. Readonly reads leave storage unchanged; guarded purge preserves
  the lock and audit namespace and reports partial cleanup honestly.
- Preserve Windows private-temp capability isolation; real confined create/reopen/readonly and
  foreign-session denial assertions cover the protected cache ACL.
- 新增可信信封内的会话引用，单结果 10 MiB/会话 100 MiB、序列化 LRU、物理字节计量与独立审计。每次检查活动权限/生产工具，默认会话生命周期，不嵌套引用；只读不改存储，清理保留锁与审计并如实报告部分失败，Windows 私有临时目录 ACL 有真实隔离回归。

### Discover advanced tools in the requesting Native scope (#261, 8/16)

- Add `dsh-ops/discovery` and `ops_discover`: deterministic allowed-pool selection, a 1-5 per-call cap, and always-loaded choices. Publish pending capabilities only at the next model-step boundary, with scope isolation, permission withdrawal and owned cleanup.
- Coordinate overlapping discovery rows and exact Native ownership with progressive PTC publication. Preserve unrelated external registrations and same-scope file handoff; include current batch reads/edits and the Native reference pager.
- 协调重叠发现行、Native 精确归属和渐进式 PTC 发布，保留外部注册与同作用域文件交接；纳入现有批量读写及 Native 引用分页器。
- Add pinned schema token measurement and real Cordis/native-worker lifecycle checks. The current discovery entry alone measures 94 cl100k_base tokens; this is not the full default surface. The real PDF next-request assertion is part of BM-04.
- 新增按需发现组件与 `ops_discover`：允许池、单次 1-5 项上限和始终加载选择；仅在下一模型步骤挂载，并保证作用域隔离、权限变更撤销及卸载清理。
- 新增固定分词器的 schema 计量和真实 Cordis/原生 worker 生命周期测试；当前发现入口为 94 cl100k_base tokens，不代表完整默认面；真实 PDF 下一请求断言由 BM-04 验证。

### Render Native file results as bounded, readable text (#261)

- Show file headings and physical line numbers, concise mutation receipts, and explicit
  completion, paging, metadata, effect and retry notices. PTC execution data stays unchanged.
- Bound Native content blocks to 64 KiB after escaping, with recovery guidance when the
  display is clipped. Preserve Unicode pairs, grep context line numbers and glob path results.
- Reject invalid UTF-8/unsupported text encodings with `ERR_INVALID_ENCODING` and binary-reader
  guidance; verify identical physical-LF counts and unmodified write bytes across projections.
- Native 文件结果改为带物理行号的有界文本，保留分页、元数据、副作用与重试提示；PTC 数据不变。
  转义后最多 64 KiB，截断时明确提示；非法编码返回 `ERR_INVALID_ENCODING`，不进行有损替换。

### Centralize capability metadata and prepare typed kernel contracts (#261)

- Move policy and file/PTC contracts to TypeScript, with one capability catalogue for names,
  ownership, presentation availability, concurrency and schemas. Existing registrations, tool
  descriptions and output rendering remain compatible.
- Add typed Outcome, search coverage and result-reference contracts plus explicit error/retry
  policies for subsequent adapter slices. Incomplete searches cannot claim a known total.
- Pin Node 22 declarations and check valid/invalid contracts in the regular test runner.
- 统一能力名称、归属、呈现、并发及 schema 目录；策略和文件/PTC 契约迁为 TypeScript，加入 Outcome、搜索覆盖、结果引用及错误/重试类型，固定 Node 22 声明并验证正反类型用例。

### Report search coverage and validate continuation state (#261)

- Search reports distinguish scan coverage from page delivery, count skip reasons, and omit full
  totals after unreadable, encoding, size or execution-budget gaps. Bounded rescan continuations
  reject changed queries, authority and observed filesystem state; incomplete traversals require
  a narrower fresh query. Search retains physical LF accounting and bounded output prefixes.
- 搜索区分扫描与分页，统计跳过原因，遇读取/编码/大小/预算缺口不提供全量总数；重扫续取校验查询、权限与文件状态，不完整遍历要求缩小新查询，保留物理 LF 行号和有界前缀。

### Version the one-shot worker request protocol (#261)

- Send strict v1 requests with per-call IDs, component provenance, and enforced deadline/output
  budgets while retaining existing host authority checks and canonical success results. Reject
  malformed envelopes before effects; interrupted or oversized mutation receipts never imply no
  effects. Keep explicit v0 decoding for benchmark compatibility with bounded transport defaults.
- 单次 worker 请求采用严格 v1、调用 ID、组件来源及执行/输出预算；副作用前拒绝错误信封，修改执行后中断/超限不假装无副作用，保留有界 v0 解码供基准兼容。

### Split the native kernel into workspace crates (#261)

- Extract protocol, file, search, batch, and result-storage crates while retaining the one-shot
  worker and existing authority, metadata, no-follow, and audit rules. Test the complete Cargo
  workspace and include every path dependency in published source packages.
- Include workspace crates and platform metadata adapters when checking for stale benchmark workers.
- 拆分协议、文件、搜索、批处理和引用存储 crate，仍按调用启动并保留权限、元数据、nofollow 与审计；完整 Cargo workspace、发布源包及基准陈旧检查均包含路径依赖和平台元数据适配器。

### Build plugin source into the existing JavaScript package layout (#261)

- Move plugin source to `src/` and introduce the TypeScript build with JavaScript migration
  support. `lib/` becomes generated output; package exports and component entry paths stay the
  same. Component assets are copied alongside the emitted JavaScript.
- Build before verification and packaging, and document the build step for direct suite runs
  and source installations in both contributor guides. Published packages keep shipping `lib/`
  without `src/`; this toolchain slice does not change tool behaviour.
- 源码移至 src、构建到既有 lib 路径并复制资源，验证和打包前先构建；发布包保留 lib 不含 src。初期 JavaScript 迁移支持现已在第 16 步移除，全部插件源为严格 TypeScript/TSX。

### Earlier file-tool compatibility repairs retained in 0.4.0

These entries record the earlier eleven-tool baseline; the current catalogue, Native text projection and SDK surface are described above. 以下保留早期十一工具基线修复；当前目录、Native 文本投影与 SDK 以上方 0.4.0 条目为准。

- All eleven file argument schemas render concrete types in the pinned host SDK.
  Bounds unsupported by that SDK are explicit descriptions backed by native validation;
  required fields, enums and edit shapes remain. Native glob now enforces its advertised
  limit and grep rejects unknown output modes. Legacy inspect offset 0 remains supported.
- Grep counts through the candidate set even after its page fills, while materializing
  only the requested window. `total`, `matched`, `omitted` and `complete` no longer claim
  that a prefix is a complete multi-file search. Read failures prevent completion;
  non-UTF-8/oversized candidates are reported as `skippedFiles`. Each page rescans, so this
  is a correctness repair, not a scan-speed claim. Existing traversal bounds still apply.
- Inspect's model view shares a homogeneous page's path once, without mutating the raw
  execution/PTC result or removing revision, pagination or truncation metadata. Worker
  byte-budget pagination and long-single-line continuation are unchanged.
- Routing distinguishes `summary` aggregate totals, `count` per-file counts and `content`
  matching text; defaults are unchanged. The native guide no longer advertises removed
  inspect aliases or exception-only handling for file-tool failures.

These changes do not establish net model token savings; no billing/cache A/B is claimed.

### Inspect routing matches the native surface (#68)

The paired component routing tables no longer advertise multiple ranges, arbitrary
encodings or PDF text for `ops_inspect_local_file`. The historical 0.2.x manual
checklist now labels those file cases explicitly as historical; current inspection
is single-path, bounded UTF-8 text or hex. A contract regression checks both tables.

### The 0.3.2 real-machine findings, fixed (#204, #235, #236, #237, #240)

This is the earlier adapter repair history. In 0.4.0 the public Bash adapter returns schema-valid failure values for invalid arguments; its contract above supersedes the legacy thrown-refusal behavior below. 以下是旧适配器修复历史；0.4.0 公开 Bash 对无效参数返回符合 schema 的失败值，上方契约取代下文旧抛错方式。

Four findings from the 0.3.2 Linux x64 session run in #204. Three are behaviour changes, and
each one is pinned by a suite that would fail without it.

- **`ops_bash` argument errors are refusals again (#235, F1).** A regression in the 0.3.2
  delivery stack folded *every* thrown error from the session wrapper into a value, so an
  invalid argument came back as a value that did not satisfy the output schema and the host
  reported `returned invalid output` — the caller never saw `invalid workdir: …`. Argument
  validation now raises a typed refusal (`BashArgumentError`, `code:
  INVALID_BASH_ARGUMENT`) that the wrapper re-throws with the field named, while a runtime
  failure is still folded into a value — and a folded value now carries the full
  `BASH_OUTPUT_SCHEMA` shape (`status`/`timedOut`/`timeoutMs`/`stdout`/`stderr`). A
  suite asserts both halves.
- **A relative `workdir` is resolved against the session workspace (#237, F3).** It used to
  be passed through verbatim, so `.` or `sub` was resolved by the helper process's own
  working directory: commands ran in the wrong directory *without an error*. Relative paths
  now anchor to `session.header.cwd` (absolute paths unchanged, empty or whitespace still
  falls back to the session directory, and on Windows a drive-relative path resolves against
  the session's drive or is refused). A workspace that disappeared is reported as
  `invalid workdir: must be an existing directory, got <session directory>`; a spawn ENOENT
  whose `workdir` is gone no longer wears the "missing bash payload" remedy.
- **`ops_glob` reports a real modification time (#236, F2).** `details.modified` returned the
  file's *byte count* (`symlink_metadata().len()`), which also made `sort: "modified"` a
  size sort. It is now milliseconds since the Unix epoch — the same quantity and unit
  `ops_stat` reports as `modifiedMs`, and `null` when the filesystem cannot report one —
  and `sort: "modified"` orders newest first, stably, so equal timestamps keep the walk's
  path order. `bytes`, `sort: "path"` and the pagination envelope are unchanged.
- **The credential fence is documented by what it does (#240, F6).** The module comment
  claimed the fence was on *reads only* while the write path, the `copy`/`move` destination
  and `replace` were refused as well, and the refusal text told a writer not to *read*
  credentials. The comment, the refusal message and the configuration reference now state
  the real reach (path-based: reads, writes, and copy/move destinations; a `.env` cannot be
  created either), and a suite asserts the wording, the refusals and the documented reach
  together.
- **The update-lock sidecar is declared behaviour (#240, P5).** Published writes retain a
  persistent 0-byte `.dsh-ops-update-<sha256(lowercased name)>.lock` beside the target;
  unlinking it could let concurrent writers lock different inodes for the same name.
  The lifecycle and residual refusal cases are documented in `docs/native-ptc.md`.

### Refuse single-file requests before creating the update sidecar (#244, #240, #204 P5)

- The credential fence also refuses removal, including under `danger-full-access`;
  troubleshooting records that `.env` cannot be created through the ops tools.
- Single-file requests rejected by pure snapshot checks (revision, edit planning, proposed
  size, destination absence) now fail before taking the lock. Authoritative checks still run
  under the lock when needed. `write_file`/`edit_file` dry runs skip the lock entirely.
- A concurrent change or publication failure after locking can still leave a sidecar, and
  `replace` can leave one per selected candidate even if its match budget is refused.
  Persistent sidecars are never unlinked automatically; the cooperative lock identity is preserved.

### `strict` official-tool hiding no longer blocks session readiness (#238, #207)

**Behaviour change.** `dsh-ops/hide-official` used to treat *any* presented official
tool without a registered OPS equivalent as fatal, so enabling the row with
`strict: true` on a stock desktop profile killed the session at assembly
(`READINESS_BLOCKED (EXECUTOR_UNAVAILABLE)` naming 48 tools). That condition is gone:
the component now takes over only the **shell / file / ptc** faces, and `strict` means
"hide inside those faces only what has a reviewed replacement".

- Official tools outside the three faces (delegation, teams, jobs, sessions, MCP, media,
  scheduling, goals, terminal, `workflow`, `skill`, `web_search`, `web_fetch`,
  `ask_user_question`, `read_image`, `present`, …) are **left visible** with one aggregated
  warning that names every tool and says it is out of scope. An `additionalOfficialTools`
  entry for an out-of-scope tool is warned about and ignored; it never fails readiness.
- An **in-scope** official tool without a registered equivalent (today `write`, `edit`,
  `str_replace_editor`, `run_code`, and the non-retained shell commands) is **left visible**
  and named in the same warning. `read`/`glob`/`grep` remain hidden because they map to
  `ops_inspect_local_file`/`ops_glob`/`ops_grep`.
- The only remaining fail-closed case is an **explicit** `additionalOfficialTools` request
  for an in-scope tool that has no equivalent: `READINESS_BLOCKED
  (HIDING_REQUEST_UNSATISFIABLE)` names the tool and both ways out (remove the name, or
  disable the row). Infrastructure failures (missing host tool API, incomplete OPS file
  surface, a mask that cannot hide an own-scope registration) still block that scope.
- `hide-official` remains a **disabled opt-in row**; the default surface is unchanged.
  Tests feed the exact 48-tool surface reported in #207 to the real host and assert that
  assembly resolves, all 48 tools stay visible, and the warning names them.

### The `hide-official` takeover scope is explicit, with a `scope` switch (#239)

**New key.** `dsh-ops/hide-official` gains `scope: takeover | extended | off`.
`takeover` is the default, so every existing row keeps the 0.3.2 behaviour exactly.
The scope itself is now data: `TAKEOVER_MANIFEST` in `lib/official-tool-hiding.js`
lists every pinned official tool name (all 63) and both dynamic official prefixes
as `tool -> face -> OPS equivalent -> reason`, marking the ones this component
deliberately does **not** take over. `TAKEOVER_SCOPE`, `takeoverFace`,
`takeoverEquivalent` and `isHideable` are derived from it; tests fail if a row is
deleted, if an equivalent drifts from the reviewed registry in
`official-tool-catalog.js`, or if the table in `docs/component-reference.md` /
`docs/组件参考.md` stops matching the manifest.

- `scope: takeover` (default) — hide only manifest rows inside shell/file/ptc that
  have a reviewed equivalent; everything else stays visible with the aggregated
  warning, and an out-of-scope `additionalOfficialTools` entry is warned about and
  ignored. Unchanged.
- `scope: extended` — the takeover scope becomes the manifest plus every name in
  `additionalOfficialTools`. A promoted name is judged by the same in-scope rule,
  so one with no reviewed equivalent fails closed with the same executable way out
  instead of being ignored.
- `scope: off` — the row takes over nothing: no hiding, no warning, no readiness
  gate. It neutralizes the row without editing `disabled`.
- The component card text (`locale/en.json`, `locale/zh.json`) no longer claims
  that incomplete replacements refuse prompt assembly; it now describes the
  three-face scope and the single fail-closed case.
- The configuration and component references document the hidden set, the
  kept-visible set with reasons, and one copy-paste row per `scope` value.

### A repository-only benchmark harness, merged from #103 and #183 (#205, #173)

- `bench/` is one cross-platform harness with two measurement modes and one JSON data
  contract. It is repository-only: `files` does not carry `bench/`, no release build
  touches it, no default CI run executes it, and `npm run bench:*` outside a checkout
  fails with exit 2 instead of a dead path.
- The model-free tool-level comparison is adopted from #103 (@OldLigant): its
  `MATCH / MISMATCH / EXPECTED_DIFFERENCE / EXPECTED_REJECTION / UNSTABLE` state machine,
  strictly created (never overwritten) reports, and the fixed size-boundary fixture corpus.
- The model-driven token A/B skeleton is adopted from #183 (@Richeir): pass-drop before
  cost, per-task pairing, the geomean summary and the archive of the raw evidence.
- #183 is merged into this history: its branch is an ancestor of the merge that landed the
  consolidated harness, so its commits are part of `main` even though its superseded
  artifacts (`bench/lib/fixtures.mjs`, `test/bench.test.mjs`, `bench/platform/win-ab.bat`)
  were replaced by the split fixtures, the per-slice suites and the cross-platform CLI.
- #103 is merged into this history the same way: its branch is an ancestor of the merge that
  landed the consolidated harness, so its commits are part of `main` while its superseded
  artifacts (`bench/measure.mjs`, `bench/files.mjs`, `bench/fixtures.mjs`, `bench/results/*`,
  `test/file-bench.test.mjs`) were replaced by `bench/tools/**` and the opt-in smoke job.
- Git-level credit for both: the harness entered `main` as a **rewrite** (each slice
  re-implemented the source pull requests), so this entry's commit carries
  `Co-authored-by:` trailers for @OldLigant and @Richeir.
- This set follows #173's intent: local performance measurement. Timings are printed as
  human evidence, never adjudicated; a cost direction is read only when the paired,
  both-sides-passing delta clears the A/A noise floor.

### Platform defaults confirmed by the operator (#170)

- PTC enhancement is enabled by default (`defaultEnabled: true`, no disabled bundle row).
  This changes the published 0.3.0/0.3.1 opt-in baseline, but does not force PTC presentation:
  native/hybrid sessions do not acquire batch/result tools or their scoped guidance.
- Shell stays enabled on Windows, Linux and macOS. Strict official-tool hiding stays opt-in.
  Existing explicit profile choices are not migrated or overwritten; users can disable the
  PTC component explicitly. Enabling the component does not raise filesystem permissions.
- The catalog's POSIX shell-default claim now agrees with the bundle/manifest. No unsupported
  `defaultEnabledPlatforms` field or platform `!!js` expression is needed.
- No token saving is claimed. The pinned-host declaration-cost check is recorded in
  `docs/ptc-cost.md`: PTC-only added 4,671 prompt characters in the isolated Windows sample;
  native/hybrid added zero. This is not a tokenizer or net-usage measurement. #145/#148
  comparisons require equal-task usage/latency/retry evidence before claiming savings.

### PTC paging and discoverability (#171, #160)

- Default enablement is decided separately in #170. Enabled PTC-only scopes
  receive batch/result usage guidance; native/hybrid scopes do not inherit that guidance or tools.
- Argument schemas use the pinned host's supported JSON Schema subset, retaining numeric limits
  as descriptions and native validation. Actual host SDK rendering is tested against `unknown`.
- Result pages expose expiry, sourceTotal and stable ordered-row contentHash before projection or
  filtering. Hashes are observations, never authority. First/last/beyond-end pages, invalid IDs,
  ownership, expiry, release and oversized rows have executable assertions, including real run_code.
- Expired references return `REFERENCE_EXPIRED` with release/reobserve guidance; batch audit pages
  have `expires: null` and cannot be released. Current authority and PTC presentation are rechecked
  before execution; changed authority never silently reuses the producing request's permissions.

### Safety and atomicity (#168)

- Darwin nonempty extended ACLs now fail closed with `METADATA_UNSUPPORTED` before staging.
  APFS cloning alone is not an exact ACL guarantee; deny-delete entries also prevent safe
  staging rename/unlink. Use a dedicated metadata-aware tool for ACL-bearing files; changing
  DSH permissions is not a repair. Plain files still require supported metadata-preserving cloning.

- Replacement receipts hash observed bytes, not a second racy read. Cooperating writers retain
  the persistent path lock across CAS and atomic publication. Later-file failures retain
  `effectState: applied` when earlier files have changed; receipt output is bounded before writes.
- Only trusted host anchors are canonicalized; descendant links remain subject to native
  no-follow validation. Session temp paths never fall back to the shared root.
- Windows replacement preserves supported owner/group/DACL/basic metadata through the existing
  metadata crate. Darwin requires metadata-preserving cloning. Unsupported metadata returns
  `METADATA_UNSUPPORTED` with repair guidance, not permission-selector advice.
- `CREDENTIAL_DENIED`, `PATH_RESTRICTED`, `AUTHORITY_CHANGED` and `EXECUTION_RESTRICTED` distinguish
  credential/path fences, changed authority and OS execution restrictions from actual DSH denials.
- This cut retains four public file tools. The seven additional tools and end-to-end
  `expectedRevision` acceptance belong to #167; the shared revision primitive is tested here.
  Locks serialize cooperating OPS writers, not unrelated programs. Cross-compilation is not
  macOS/Linux runtime acceptance; repeated macOS/APFS concurrency remains an acceptance gate.

- Tools trial: `node scripts/tools-trial.mjs` calls every published tool on a real host and prints a
  per-tool table; CI runs it in a separate, non-required `tools-trial` job.
- Documentation now matches the shipped 0.3.1 surface (no behavior change): the component reference
  describes `ops_inspect_local_file` as the bounded UTF-8/hex reader it implements (not multi-range,
  extra encodings or PDF), calls `ops_replace` a literal replacement, states that read-only refuses
  replacement including its dry run, and names the session's private temporary directory as the
  workspace-write fence; the Chinese reference is kept in sync. `docs/schema-measurement.md` and
  `docs/schema-current.json` are marked as the historical 0.2.x FastCtx snapshot, and the READMEs
  mark the DOC/PDF, web-search and crawl4ai-style tools as roadmap items instead of shipped ones.

### The pwsh overlay commits into the live config reference instead of restarting the host row

`mountBundledPwsh()` applied its reversible overlay with `entry.fiber.update(...)` on the official
`pwsh-sandbox` row, at mount and again at unmount. On an ACTIVE row that call is a full dispose/reload:
restarting the host's executor swaps the `shell` service provider, every `inject('shell')` consumer is
rebuilt, and reconstructing `permission-presets` over a loaded session still carrying the durable `auto`
preset throws — which bricks the permission service and, through the per-call auto-review hook, every
tool in the instance (#29, #104, #129; deepseek-harness discussion #9882).

`pwshPath` is a volatile config field and the owning executor re-reads it before every command, so the
overlay now commits the value into that live reference — through the same
`Symbol.for('cosmokit.volatile.write')` channel the loader's own `updateVolatile()` writes on — and the
unmount restores the owner's latest declared value the same way. Neither `Entry.update()` nor
`Fiber.update()` is called, the owner's stored raw config is never touched, and the takeover and its
revocation both take effect without restarting anything.

The shells and hardening suites now assert the in-place contract, including that the owning row's
`update()` is never invoked.

### The config-update marker goes to the profile patch, and never to the composed tree

`mountConfigUpdates()` persisted its one-time marker with `entry.parent.tree.write()`, an API that
writes the **whole composed tree** back into the profile root file. The loader documents that file
as an empty entry list and resets it on boot, so the baked copy carried other plugins' rows —
`ui-theme`'s `preference`/`fontSize` above all — which echoed the previous value back into the
settings scope and made the theme and font size bounce (dark → system → dark); on a desktop profile
the baked rows made the whole bundle fail to mount on the next start, silently (#91, #108).

The marker now goes through `configEditor.edit()`, so it lands in the active profile's patch layer,
leaves every other row alone, is validated as a whole candidate before anything reaches disk, and
preserves comments and `!!js` expressions. `EntryTree.write()` is never called again, and the suite
installs it as a tripwire that throws if anything reaches for it.

When the editor is unavailable, or refuses the save, the migration simply stays in effect for that
activation: no tree write, no fallback write, no error in the boot path, and the notice is emitted
once per process rather than once per activation. Combines #138 (the patch-layer channel) with #136
(the in-memory-only discipline).

### Breaking: the FastCtx background component is removed

The `dsh-ops/background` component and everything that existed only for it are gone. The file,
shell and PTC components behave exactly as before.

- **Removed tools**: `ops_run`, `ops_run_background`, `ops_job_output`, `ops_job_list`,
  `ops_job_kill`. For a long-running process, use the host `pwsh` tool's `run_in_background`, or
  detach inside an `ops_bash` command (`nohup ... & disown`).
- **Existing profiles keep loading.** A `dsh-ops/background` row left in a profile loads as a no-op
  stub: it accepts any config, publishes nothing, and logs one warning that the row can be deleted.
  The bundle patch no longer inserts the row, and the manifest no longer declares the component,
  its prompt section, or the `fastctx` tool namespace.
- **Configuration update 2.** `serverName`, `enableShellTools` and `toolCallTimeoutMs` were read
  only by FastCtx. They stay accepted and type-checked, so rows written by earlier bundles (every
  file row carried `enableShellTools: false` and `toolCallTimeoutMs: 300000`) keep validating, but
  they are no longer resolved, and `configUpdateVersion: 2` removes them from each saved
  `dsh-ops`, `dsh-ops/shell` and `dsh-ops/file` row once. A row already at version 1 keeps a later
  manual `allowSystemShellFallback: true`; the bundle patch no longer writes the keys.
- **CLI**: `resolve`, `status` without `--profile`, `build` and `provision` are removed and exit 2
  with the command that replaces each. `ladder` now reports the native worker (`worker` in
  `--json`, resolved by the same `resolveWorker()` the file component uses) instead of a FastCtx
  runtime, and its `levels` are `{ files, bash, pwsh }`. `uninstall --yes` still removes
  `<DSH_HOME>/dsh-ops` (including a FastCtx runtime an earlier version provisioned), and
  `--purge-fastctx` still removes the leftover `~/.fastctx` state.
- **Public `dsh-ops/policy` exports**: `BACKGROUND_TOOLS` and `SHELL_TOOLS` are removed;
  `ladderLevels()` returns `{ files, bash, pwsh }`, and `renderToolingPolicy()` no longer takes
  `enableShellTools`.
- **Packaging**: `vendor/fastctx/`, `packages/fastctx-win32-x64/`, the optional dependencies
  `@dsh-ops/fastctx-win32-x64` and `@fastctx/darwin-arm64`, the `build:rust`, `provision` and
  `status` npm scripts, `scripts/measure-schemas.mjs`, and the FastCtx build in CI and in
  `scripts/build-platform-packages.mjs` are removed; a release now publishes the two shell payload
  packages. `lib/paths.js` now holds `PACKAGE_ROOT` and `dshHome()`.
- **Licensing is unchanged.** The composite `MIT AND Apache-2.0` statement and FastCtx's required
  attribution are kept verbatim; FastCtx's license text and upstream notice moved from
  `vendor/fastctx/` to `licenses/fastctx/`.

### Fixed

- The inherited-root workspace-preparation test (#43) matched only the built-in Administrator's
  SDDL alias `LA`, so it failed for any other account; it now matches the current user's SID, or
  `LA` when that user is RID 500.

## [0.3.1] — 2026-10-16 — Cross-platform native tools

Exact release targets: **win32-x64, linux-x64, darwin-arm64 (Apple Silicon)**. Intel Mac, Windows ARM64 and Linux ARM64 are not supported. Bash/PowerShell binary payloads remain pinned Windows-only optional dependencies. POSIX uses host Bash; PTC remains opt-in. Final build/test evidence is linked in docs/release-0.3.1.md.

### Integrated macOS and release hardening

- Merge #67 and #81 with their commit histories; include #69 path-alias handling and #107 Windows short-path validation.
- Keep strict release closure over all three worker targets, receipt/hash/architecture checks and mandatory Windows IPC.
- Create replacement temporary files privately, clear inherited Linux ACLs when absent on the original, sync after metadata restoration, and serialize cooperating updates with a stable path lock.
- Enforce credential policy per traversed file and batch source, not only on the initial path.

### Linux x64 adaption

- Build and verify the native worker on `x86_64-unknown-linux-gnu` as a first-class target: `cargo build --release --locked`, `cargo test`, the full `npm run verify` with `DSH_OPS_REQUIRE_RUNTIME=1` (30 suites, no skip counted as a pass) and `npm run verify:release`. `npm run build:ptc` now stages the Linux worker beside the Windows one, each with its own receipt, and the release checks reject a missing or corrupt artifact for any target the package carries.
- Keep the platform paths separate instead of compromising both: directory `fsync` and metadata reapplication on POSIX, `MoveFileExW` publication on Windows, chosen per `cfg` rather than papered over with one behaviour that would be wrong on both.
- Derive platform facts when a suite runs instead of from the host it happens to be on: mount and filesystem fixtures are resolved at run time, no tool is parsed for `LC_MESSAGES`-dependent wording, and whole-suite skips are declared per platform (2 on Linux) rather than counted as passes.
- Close the release gate over the targets a checkout actually staged, so a Linux-only build passes and `DSH_OPS_REQUIRE_ALL_TARGETS=1` states the multi-platform claim; the closure message names the staged platform instead of assuming Windows.
- Document the Linux route end to end in `docs/linux-build.md` and `docs/linux构建.md`: build, stage, `npm pack`, `dsh plugin add ./dsh-ops-0.3.1.tgz`, and the gate commands with their expected output.
- Add 11 boundary suites that run on both platforms: grep across lines, replace metadata, output byte budget, update lock, hex offsets, argument and runtime diagnostics, release scope, PTC provenance, and the Linux argument/attribute suites.

### Credential reads are refused, and the write surface is the session's own

Taken from WTStarMark's PR #40, which found that DSH's filesystem layer does not fence credential
paths: a tool that reads any OS-readable file could hand a model the operator's keys and tokens.

- The file tools now refuse to read a credential location, by default and before the worker is
  spawned: `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `.docker/config.json`,
  `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc` and the DSH credential stores, plus
  `id_rsa`/`id_ed25519`-style keys, `*credentials.{json,yaml,ini}` and `service-account*.json`
  wherever they live. The refusal names the fence and the way out; a row can opt out with
  `denyCredentialReads: false`, and `DSH_OPS_DENY_READ` can only ever *widen* the list (an absolute
  entry is used as written, a relative one is resolved below the home).
- A traversal skips those directories by identity, so `ops_glob` cannot name a private key below one
  and `ops_grep` cannot match inside one — the match text never enters a result. Covered by
  `test/credential-fence.test.mjs`, which runs the same call with and without the skip.
- The shared system temp is no longer endorsed as a `replace`/batch write root: the session's own
  `dsh-ops-session-<id>` directory is, created lazily with mode `0700`. The host sandbox grants the
  whole of `/tmp` to workspace-write on Linux, so endorsing it here would let one session replace
  another's temporary files; this fence is deliberately narrower than the kernel's grant.
- A directory that holds one binary file no longer fails a whole `ops_replace`: the text files around
  it are still edited, the binary is reported through `skipped` and `skippedPaths`, and the previous
  behaviour (refusing the entire call with an error that named no file) is gone.

### Review follow-ups (@Haoming9527, #81)

- An inherited `LC_ALL` silently un-pinned the message locale. POSIX resolves `LC_ALL` before
  `LC_MESSAGES`, so on a host that sets it — a `zh_CN.UTF-8` desktop commonly sets nothing else — the
  English pin that keeps the host's `denialSignatures` matching never took effect, and a sandbox
  refusal was reported as a generic command failure (measured here before the fix:
  `LC_MESSAGES="zh_CN.UTF-8"`). `shellEnvOverrides` now neutralizes the inherited override (an empty
  value is "unset" to the C library) and carries its **encoding** intent forward as `LC_CTYPE`, which
  a host that stated its own ctype keeps. `LC_ALL=C` was not an option: it would make commands read
  UTF-8 input as bytes.
- The profile CLI fallback was Windows-only in shape: with no package-based CLI to resolve it
  selected `dsh.cmd` and launched it through `cmd.exe`, so on Linux the call died as
  `spawnSync cmd.exe ENOENT` even with an executable `dsh` on PATH. The fallback is now
  platform-aware, and the `cmd.exe` wrapper is only used on Windows.
- The Windows update lock blocked the worker's own read. Windows `LockFileEx` denies access to a
  locked range through *any* other handle, including one the same process opens, and the revision
  check re-read the target after taking the lock — so an ordinary, uncontended `replace` failed
  there with a lock violation. Linux cannot show this, because `flock` is per open file description.
  The worker now reads the current bytes through the lock handle, so nothing reopens the target
  between the check and the publish. `docs/windows-verification.md` carries the W1g case.
- Debris cleanup deleted files that merely shared a prefix. The sweep matched
  `.<name>.dsh-ops-` and removed anything that began with it, which took an operator's
  `.notes.txt.dsh-ops-personal-backup` and, for a target named `foo`, the *live* temporary file of a
  different target (`foo.dsh-ops-bar`). A leftover must now be the whole shape this writer creates:
  the tail has to parse as the v4 UUID `atomic_write` generates.
- A single long line could exhaust the worker's memory. In the content modes the grep path built one
  text item per match *before* `limit` was consulted, so a 32 KiB line matched by `pattern: "a"`
  copied that line 32 768 times and the call aborted under a memory cap instead of returning its
  first item. Matches are counted in one non-allocating pass and materialized in a second pass
  bounded by the page; `matched`/`total` stay exact, because they report what was counted.

### The shell component on Linux: the host's own bash, under a mandatory sandbox

Taken from WTStarMark's PR #40, which designed the same capability as a separate opt-in
`dsh-ops-linux` component. It lives in `dsh-ops/shell` here: `dsh-ops/file` already gives Linux the
four file tools, so a second component publishing the same four would be two names for one surface.
The capability is taken; the duplicate component is not.

- On POSIX the resolver answers from `config.bashPath`, then `PATH`, then `/bin/bash`,
  `/usr/bin/bash`, `/usr/local/bin/bash`, and never provisions a plugin-owned shell: a distribution
  bash is tied to that distribution's libc and architecture, so a second copy would add supply-chain
  and licensing burden without solving anything. `allowSystemShellFallback` is the Windows gate on
  reaching past the pinned payload; with no payload on POSIX the host bash *is* the rung, so the flag
  is not required there. Windows is unchanged — same config, same `disabled`.
- `dsh-ops provision-shells` refuses on a POSIX host and names `config.bashPath`, instead of failing
  on an empty pin table: the pinned payload is the Windows one.
- Confinement is not weakened by the new rung. A confined command reaches the host sandbox first, and
  an unavailable or unusable confinement result is refused with no command executed; read-only still
  publishes no command tool.
- The FastCtx job lane is **not** widened by it: `lib/tools.js` resolves that lane with `posix: false`,
  because the lane is Windows-only in 0.3.1 (its payload and IPC proxies are), so a host bash cannot
  make it publish job tools on a platform nothing here has verified.
- The manifest now states each component's platforms — `dsh-ops-shell` and `dsh-ops-file`: win32 +
  linux; `dsh-ops-background`: win32 only — and `npm run validate:manifest` fails if a Linux claim
  rides along (61 checks).
- Covered by `test/linux-shell.test.mjs` (a real `ops_bash` execution through the host bash, the
  refusal under unusable confinement, and the two lanes being one decision apart), by a
  spawn-environment assertion in `test/mount.test.mjs` that fails if the job-lane fence is removed,
  and by `test/shells.test.mjs`, whose Windows-doctrine cases now name their platform instead of
  inheriting the host's.

### Native worker boundary fixes

- Preserve file identity across `ops_replace`. The replacement is published as a new inode, so the target's mode, owner, POSIX ACL and user extended attributes are now captured before the write and reapplied before publication. Previously a `0600` file came back world-readable (typically `0664`) and a `0755` script lost its execute bit. A mode or ACL that cannot be reapplied aborts the call with nothing published; on restore, an owner or attribute that cannot be put back is reported in `items[].metadataWarnings`, while `items[].metadata` reports what was kept. Covered by `test/file-metadata.test.mjs`.
- Make `ops_grep`'s `multiline` match across lines. It previously only changed what `^` and `$` anchored to while still matching one line at a time, so a pattern containing `\n` could never match and the call answered `matched: 0` without an error. `^`/`$` keep their per-line meaning, context lines still apply, and behaviour without the flag is unchanged. Matching the whole file at once also adds one zero-width match after a final newline, so that position is no longer reported as a line of its own: `$` answers once per line, not once per line plus one, and no match lands on a line the file does not have. Covered by `test/grep-multiline.test.mjs`.
- State what the shared parameter names mean, without changing the behaviour they name: `replace`'s `pattern` is a literal substring while `grep`'s is a regular expression, and `maxReplacements` is a ceiling that refuses the whole operation rather than truncating it. The refusal now names the match count, the ceiling and how to raise it instead of blaming the pattern.
- Bound every response by encoded bytes as well as by lines, so a single long line can no longer fail a read outright; `bytesTotal` and `truncatedInLine` report where that applies. The hex view of `ops_inspect_local_file` now reads the first row of the file instead of starting at the second.
- Hold an exclusive lock across the read-check-publish window of `ops_replace`, so concurrent replacements cannot silently lose a write: a peer now receives `REVISION_CONFLICT` rather than reporting a change it did not keep. Covered by `test/replace-concurrency.test.mjs`.
- Bound the debris a hard kill leaves behind. The next writer of a file reclaims its own `.<name>.dsh-ops-*` leftovers, which a `SIGKILL` cannot clean up at the point they are created, and a directory `fsync` that fails after a successful rename reports `effectState: "applied"` with a `nextAction` that says not to repeat it, rather than `"none"`.
- Refuse a native worker that exists without its execute bit, naming the path and the mode, instead of failing later as a bare `EACCES` from `spawn`. The resolver's "unavailable" error lists the candidates it tried, a missing or malformed `provenance.json` is named as an incomplete stage, and `node bin/native-runtime.mjs check` on a package missing a declared platform explains both ways forward instead of raising a raw `ENOENT`.

## [Unreleased]

- Drain release-gate stdout and stderr concurrently so a full diagnostic pipe cannot deadlock verification; retain both streams and failing exit codes.
- 发布门禁并行读取 stdout 和 stderr，避免诊断管道写满后验证死锁；保留两路完整输出及失败退出码。

### Read-only sidebar navigation

- Add focused all/running/anomaly filters and local retained-metadata pages. Preserve unfiltered session totals, continue long diagnostics, clamp pages on resize/live settlement and release key handlers on unmount. No tools, result-page fetches, history reads or persistent preferences are added.

### Aggregate sidebar anomaly alerts

- Add constant-memory, explicitly all-session anomaly badges without opening the panel or changing focus. Count only accepted settlements; acknowledge notifications with focused `a` without changing tool/session facts. Keep observer and badge failures isolated and respect the host-owned panel ID.

### Native sidebar source integration

- Add opt-in real Rust worker → OPS file runtime → DSH AgentLoop/committed Session → admitted TUI coverage, with a scripted model and owned temporary workspace. Keep source-test registration separate from Windows release support and production PTC/confinement acceptance.

### Sidebar result diagnostics

- Distinguish native file/PTC business refusals, errors, previews, partial settlement and unknown effects from transport returns. Parse only bounded native JSON envelopes, retain no result bodies, and leave shell/spilled output unconfirmed. Show omitted details without fetching them and warn against blind retries after unknown effects.

### Optional dsh-TUI sidebar

- Add disabled-by-default `dsh-ops/tui`, with its own admission manifest and no TUI/React runtime dependency. It observes current-session tool events through a bounded store, uses the host UI kit, and releases its panel and listeners on unload. No tool, prompt, command, polling, profile write or focus change is added.

### Read-only activity projection

- Add an internal bounded projection of live OPS native/PTC tool events for optional UI consumers. It stores no tool arguments or result bodies, isolates sessions, and labels normal transport returns neutrally rather than claiming business success. Existing components do not enable observation or change their tools.

### Payload trust

Found while reviewing what runs *before* it is trusted. Independent of the workspace-preparation
fix; see that entry for the `PSModulePath` scope note.

- Never hand a spawned child the host environment implicitly. Child processes now receive an
  **allow-list** (`lib/env.js`): paths, identity, scratch space, locale and proxy variables survive;
  everything else is withheld. The previous shape-based deny-list (`KEY|PASSWORD|SECRET|TOKEN`) let
  `SSH_AUTH_SOCK` (which authorises the host's SSH keys) and `DATABASE_URL` (usually carrying a
  password) through. `probeBinary` also defaults to the scrubbed environment — it **executes** a
  candidate that may have come from `PATH`, so handing it the full environment made the check a
  credential-delivery mechanism.
- Judge the cached confined-Bash runtime with one function on both the cached and the cold path, and
  keep the two anchors that live **outside** the writable cache (the IPC proxies against the
  in-package receipt) separate from two **in-domain consistency checks** (the patched MSYS runtime
  and `bash.exe`, both compared against the source payload). Folding all four into the stat
  comparison lets a tampered `opsipc.dll` through on both paths. A generation that fails
  verification is **quarantined and rebuilt** rather than refused forever — one bad write used to
  brick the bash tool until the host restarted — and the quarantine is bounded to two generations.
- Isolate every teardown callback (`lib/teardown.js`): one throwing disposer no longer strands the
  rest of a capability withdrawal or a tool unpublish, and `ptc`'s publication gate is released in a
  `finally` instead of wedging shut.
- Compare the native-worker candidate path with `path.resolve` + case folding rather than a path
  **substring**, so `…\RUNTIME\…` can no longer skip receipt verification.
- Report a `PATH`-sourced FastCtx on the success path; behaviour is unchanged (same-user, not a
  privilege boundary).

### Workspace preparation

- Prepare a `workspace-write` root whose path is an **8.3 short name** instead of refusing it as a
  junction or symlink. Windows generates a short name wherever a path component does not fit 8.3, so
  a host whose temporary directory is one — GitHub's `windows-latest`, or any machine whose user name
  is longer than eight characters — could not prepare any workspace under it. The check now judges
  the path it was given, and that path's ancestors, for reparse points, rather than comparing the
  given path with its resolved form: a short name changes one into the other with no link involved.

### A host outside the matrix skips the worker-driven suites instead of crashing

`lib/ptc/runtime.js` gains `tryResolveWorker()`, the non-throwing form of
`resolveWorker()`: the support matrix is still checked in one place, and the result is
either the resolved file or a complete reason clause. `test/permissions.test.mjs` and
`test/ptc.test.mjs` use it to leave through `skipSuite` (exit 77) when the host cannot
answer, where the first of them previously threw while the module was still loading and
the second failed a load-time existence check. `DSH_OPS_REQUIRE_RUNTIME=1` turns either
absence into a failure rather than a green run, and a supported host with the worker
built runs every check exactly as before.

### Windows verification follow-ups, and a lock-sidecar assertion

A Windows x64 verification of the 0.3.1 boundary work (2026-10-16) closed most of its own
findings in the release itself — the update lock no longer touches the target, credential
directory names are matched case-insensitively on every host, and `sync_directory` is
`#[cfg(unix)]`. What is still wrong here is the checklist, not the code:

- **`docs/windows-verification.md` carried expectations the report disproved.** The manifest
  count is 59, not 58 (the tree that removed the FastCtx and background components dropped two
  checks); the PE path needs its `.exe`; the L2 hex text is space-separated; a Windows host
  skips three suites rather than two (`linux-shell` joins the two POSIX-only ones) and reports
  24 passed + 3 skipped out of 27, not 27 + 3 out of 30; W1e's measured code is `IO_ERROR`
  (os error 32), not `ACCESS_DENIED`, so the expectation is the structured *shape* rather than
  one code; and the update-lock note now describes the sidecar, which is what the code takes.
  The note that a DSH sandbox cannot answer the checklist at all — `workspace-write` cannot
  spawn the worker, `danger-full-access` cannot let it create its replacement — and the Windows
  build prerequisites are recorded with it.
- **The lock sidecar is asserted invisible.** `test/linux-args.test.mjs` plants a
  `.dsh-ops-update-<hex>.lock` and checks that `glob`, `grep` and a directory-wide `replace`
  never select or edit it — on every host, because the rule that keeps it out is
  platform-independent.
- **No product half remains.** The report's other finding was that a `.cmd` candidate was probed
  with `CreateProcess`, which refuses a launcher script with `EINVAL`. That probe (`probeBinary`
  in `lib/binary.js`) is gone with the background component, and the surviving `.cmd` launch
  path, `lib/profile-install.js`, already goes through `%ComSpec%` with `/d /s /c` and
  `windowsVerbatimArguments`. So this is a documentation change plus one test.

### The ladder's POSIX worker stand-in has to be executable

`test/bin.test.mjs` seeded its worker stand-in with a plain 0644 text file, on the stated grounds
that "an explicit worker path is not provenance-checked". That holds for provenance but not for
the execute bit: `resolveWorker` refuses a non-executable explicit `binaryPath` by mode on POSIX
(report L12, unchanged by the refactor), and the ladder report now goes through it. The stand-in
therefore resolved to `{resolved: false}`, which failed two expectations — `worker.resolved` and,
through `ladderFor`'s publish rule, `levels.files`. Windows passed only because that check is
`platform !== 'win32'`, so the gate was red on Linux and macOS alone.

The two cases that assert the worker rung now seed an executable stand-in, and the report's
refusal path gained the coverage the mistake had been hiding: on POSIX, a `binaryPath` naming a
non-executable file must come back `resolved: false` with the resolver's own "is not executable
(mode 0644)" reason and no file tools published.

### The gate script, after review: Windows can be green, and a missing tool exits 2

`scripts/verify-gate.mjs` set `DSH_OPS_REQUIRE_RUNTIME=1` on every host. `test/run.mjs` turns any
skip into a failure under that variable, and Windows has three suites that skip by platform
(`file-metadata`, `linux-attributes`, `linux-shell`), so the script could never be green there —
its own allowed-skip table was unreachable. It is now set on the POSIX hosts only, and Windows
keeps its protection through the skip set: anything skipped outside that list fails. The script
also asserts the suite total it expects per platform (27), because a suite that stopped being
collected is not a pass, and a tool that is not installed now exits `2` ("this host cannot answer
the gate") instead of waiting on a `close` event that a failed `spawn` never emits.

The documentation caught the same drift it exists to prevent: `docs/verify-locally.md` promised
`61` manifest checks in two places, and `docs/windows-verification.md` still described the ladder
as failing rather than skipping where no worker resolves, and credited the Windows numbers to a
sandbox that cannot run the gate at all.

## [0.3.0] — 2026-10-14 — Windows x64 native tools and PTC

Release scope: **Windows x64 only**, targeting DSH 0.2.0-rc.2. macOS arm64 is
added after this release (see [Unreleased]); Linux/ARM64 are not shipped or
claimed. The package includes the native Rust worker, Windows Bash IPC proxies,
receipts and matching source; payload dependencies remain 0.2.1.

### Permission alignment

- Follow the latest authoritative three-mode session policy for fixed file operations; allow OS-readable external paths, reject read-only replacement, fence workspace writes to DSH writable roots in the host and native worker.
- Execute fixed trusted file operations using the same policy-fence threat model as DSH fs-sandbox, with no-follow native paths and subprocess governance. Arbitrary Bash/PTC code retains OS confinement; no fail-open fallback.
- Prepare owned Windows workspace roots before outer run_code/pwsh launch using directory-only current-user WRITE_OWNER, with DACL backups and no recursive grants, owner changes or denial removal.
- Publish Bash in confined modes and resolve policy at each execution. Report authorization denials with required/current mode and explicit user-action guidance, separately from executor initialization failures.
- Add real Modify-only workspace/provider coverage for native replace, batch copy/move/remove, readonly pages, mode changes and Node worker startup.
- Fix restricted Windows x64 Bash initialization with verified installation-relative IPC proxy binaries and a private MSYS copy. Preserve original payloads, DSH token SIDs and filesystem confinement; adapt only new private pipes and pagefile-backed process trackers. Matching DLL hashes are mandatory; no unconfined fallback.
- Add real pure-PTC Node runtime/SDK tests for Bash command, script_path, pipelines, workspace writes, outside denial and downgrade to read-only. Desktop GUI acceptance remains pending restart.

### Missing Bash payload diagnostics

Issue #20 reported that a profile installed from a registry which does not carry the platform payload package is told only to "repair the profile installation" — advice that cannot repair a package the registry never had. #16 asked for the same case to reach the README. Both are addressed below; no release is cut here.

- Give a platform-package miss a machine-readable cause (`no-manifest` / `not-declared` / `not-installed` / `incomplete-tree`) and render the remedy from that cause instead of matching on the detail text, so a wording change cannot silently route the answer to the wrong branch.
- A missing payload now names the registry as the likely reason and points at `dsh-ops provision-shells --bash` — which bypasses the registry, fetches the pinned upstream release, verifies its sha256 and writes a receipt — rather than the `repair the profile installation` wording. (#20)
- A corrupt payload tree keeps its repair wording and offers the same command as the alternative, so the two shapes stay distinguishable and each names an action that fits it.
- Split the spawn-time `ENOENT` result by `source` (`bundled` / `provisioned` / `config` / `path`), each naming the action that actually applies, instead of one sentence for all of them.
- Document the mirror case in all three READMEs: the measured mirror readings and date, the conditional wording, the cmd and PowerShell proxy forms, the profile-side `ladder` check, and the explicit rejection of `allowSystemShellFallback: true` as a workaround. (#20, Refs #16)

These fixes are included in 0.3.0; the three Windows payload dependencies are unchanged.

### Native file reconstruction and PTC enhancement

- Replace the file component's FastCtx `inspect_local_file`, `grep`, `glob` and `replace` surface with an independent Rust worker and one canonical `path` contract.
- Add DSH-native policy/sandbox/subprocess mediation for file calls, fail-closed executor checks, session-cwd resolution, cancellation and structured canonical results.
- Add bounded UTF-8 inspect/hex, glob traversal, Rust-regex grep, and CAS-protected dry-run/atomic replacement with no-follow and special-object rejection.
- Keep FastCtx only behind the disabled background component; remove file-component runtime discovery, MCP handshake and file-tool fallback.
- Update manifest, prompt guidance, provenance and composition tests to prove the native namespace is separate from the optional FastCtx background namespace.
- Retain the opt-in `dsh-ops/ptc` batch/result capabilities and their existing runtime gates.


- Add opt-in `dsh-ops/ptc`: two structured capabilities, `ops_batch` and `ops_result`, with no FastCtx or shell dependency.
- Share independent safe Rust core for preflighted copy/move/remove, content verification, protected/no-follow paths, write-ahead per-item manifests and conservative resume.
- Add scoped expiring result references, byte/quantity-bounded pages, field/equality projection and operation-reference consumption without widening authority.
- Follow original DSH enforcement levels (including Windows partial ACL confinement), enable no-write read-only reference pages, and allow explicit external roots under danger-full-access without confinement.
- Stage checksum-verified Windows x64 worker and Bash IPC proxy binaries; release checks reject missing artifacts. No install-time downloads/compilation; owned-workspace WRITE_OWNER preparation is runtime-only, backed up and non-recursive.
- Extend the existing PTC simulation suite with original DSH sandbox/subprocess provider acceptance: workspace copy, read-only page, outside-write denial and full-access outside-root operation.
- Execute through DSH policy + native process confinement + subprocess cancellation; standard/native and hybrid/both scopes receive no PTC-only definitions.
- Keep business code separate from one three-scenario simulation suite using the real Rust worker and real Cordis/tools/prompt registration.
- Target native Windows/macOS/Linux; Windows runtime acceptance and Linux/macOS compile checks are recorded separately from pending on-platform sandbox tests. Legacy payloads remain unchanged.
- Keep each component icon inside its exported manifest directory; fix the PTC Plugin Manager metadata error caused by the parent-relative icon path, with coverage in the existing manifest suite.
- Source builds use `npm run build:ptc` and `npm run build:bash-ipc`; published 0.3.0 artifacts are Windows x64 only. macOS arm64 support is added after this release (see [Unreleased]). See `docs/native-ptc.md`.

## [Unreleased] — Bash workdir spawn diagnostics

- Validate `ops_bash` `workdir` as an existing directory before spawning, so a missing, file-valued or inaccessible working directory is reported as an explicit `invalid workdir` error (naming the stat error code when access, not existence, failed) instead of the bash-payload ENOENT remedy; a directory deleted between the check and the spawn still falls back to that remedy. The two ENOENT causes cannot be told apart after the fact: Node puts no `cwd` on the spawn error, and the host's Windows runner maps missing program and missing directory onto one code. The session layer now resolves empty or whitespace `workdir` placeholders to the session directory like an omitted value, instead of letting them fail the spawn. Covered by `test/shells.test.mjs`. (#33)
## [Unreleased] — Workspace preparation

- Write the workspace root's DACL through its own handle (`SetKernelObjectSecurity`) instead of path-based `SetAccessControl`. The added ACE is directory-only, so no descendant needs a new ACL, but the path-based write made Windows walk and re-propagate the whole subtree, and the cost grew with workspace size. Measured on 50,000 files: 18.65 s → 4.30 s cold, versus 3.86 s for 10 files; the warm `ready` path is unchanged. The root DACL is byte-identical to before (control flags including `AI`, existing ACEs, the added `WRITE_OWNER` ACE), and descendant ACLs are untouched. Guards, backup receipt, verification and rollback are kept; rollback uses the same handle-based write. (#43)
- Raise the preparation timeout from 10 s to a 120 s safety net, and never end the error at the colon: a timeout names the limit, the workspace, that the ACL state is unknown and where the receipt is; a non-zero exit names the exit code, elapsed time and the script's stderr (or stdout, or `(no output)`).
- Restore `test/permissions.test.mjs`: a merge resolution had dropped the two closing lines of the root-only preparation test, so the suite failed to parse and none of these tests ran. Add the expensive real-world shape as a regression test: a workspace root that inherits its ACL (`D:AI`, no explicit ACEs) keeps its auto-inherited flag and inherited ACEs, gains one directory-only `WRITE_OWNER` ACE, and leaves descendants untouched.
- Start Windows PowerShell 5.1 with `-ExecutionPolicy Bypass` for the package's own `prepare-workspace.ps1`. Without it, the Windows client default (`Restricted`) refused the script, so every `run_code` / `pwsh` / `bash` / `pwsh_persistent` / `bash_persistent` call in a workspace-write session failed. The flag applies to that one child process; Group Policy still takes precedence. Covered by running the real script under a process-scope `Restricted` policy. (#66)
- Name the cause of a failed preparation instead of the blanket "(not a user permission denial)": an execution-policy refusal (now only possible through Group Policy, with that remedy), a workspace folder that does not meet the `WRITE_OWNER` prerequisite (with the script's reason), an executor that could not start or timed out, or otherwise the exit code with the script's output. Document that preparation runs as the current user before sandbox confinement.

## [Unreleased] — bashPath restricted-mode diagnostics

- Document that `bashPath` (and any system bash) works only in `danger-full-access`: read-only and workspace-write run only the pinned MSYS whose IPC compatibility proxies were verified. The policy itself is unchanged and still fails closed. (#42)
- Replace the restricted-mode `This MSYS version has no verified DSH IPC compatibility build. Rebuild the matching proxies` error with one that names the executable and where it came from, says the refusal is by design and not an authorization denial, and gives real next steps: remove `bashPath` to use the bundled or provisioned pinned bash, or ask the user to switch to `danger-full-access`. The signal-pipe runner-failure message gains the same next step.
- `ops_bash` now says plainly that it has no per-call `sandbox_permissions` escalation when a model passes `sandbox_permissions` / `justification`.
- `dsh-ops ladder` reports `restricted: { compatible, reason }` for the resolved bash, read-only and without copying anything, and drops the stale "bash requires a full-access session" line.
## [Unreleased] — File tool placeholder arguments

- The native file tools (`ops_inspect_local_file`, `ops_grep`, `ops_glob`, `ops_replace`) now drop `null` values and empty `""`/`[]` placeholders for *optional* fields at the plugin's own execute entry before the worker runs, so strict tool-call adapters that fill every schema field no longer trip `path`/`encoding`/`view` validation; required fields, `replacement: ""`, `false` and `0` are forwarded unchanged and real conflicts still error; the caller's argument object is not mutated. (#19)

## [Unreleased] — Background job argument strictness

- Check the background tools' arguments (`ops_run_background`, `ops_job_output`, `ops_job_list`, `ops_job_kill`) against FastCtx's own published schema before the owned-job check, so a mistyped or missing `job_id` is reported as `invalid arguments: unknown key "id"` or `missing required field "job_id"` instead of "This job was not started by this session on the current connection." The ownership check itself is unchanged and still decides every call whose arguments are well formed; no argument error reaches the server. Covered by `test/jobs-args.test.mjs`. (#14)

## [Unreleased] — Optional bash input placeholders

- Treat empty/whitespace/null command and script_path values as absent, so adapters that fill optional inputs do not block a valid command or script. Keep rejecting two non-empty inputs and unknown argument keys before spawn.
- Explain empty placeholders in the parameter descriptions and error recovery; `/dev/null` is not an empty placeholder.
## 0.2.9 — Bug fixes

Bug-fix-only release for issues reported against 0.2.8 and the 0.2.6/DSH 0.2.0-rc.2 combination:

- Skip the Windows `%SystemRoot%\\System32\\bash.exe` WSL distribution launcher during system PATH fallback, so an explicitly enabled fallback selects a real Git for Windows/MSYS bash instead of silently moving commands into WSL. (#12)
- Enforce `ops_bash`'s closed argument schema at runtime and reject undeclared keys such as `run_in_background` before spawning. (#10)
- Persist the one-time legacy shell-fallback migration without calling `Entry.update()` or remounting the plugin. This avoids competing with Desktop profile reloads when configuration is edited, while preserving the safe runtime value and the raw loader row. (B站评论区报告)

No new tools, components, configuration keys, or runtime capabilities are included. The three Windows payload dependencies remain pinned to `0.2.1`.

## [Unreleased] — Tool descriptions and result contract

- Rewrite the native file-tool descriptions to match what the worker enforces: `ops_glob.pattern` and the `glob` filters of `ops_grep`/`ops_replace` are arrays of globs matched against relative paths (`*.md` is top level only, `**/*.md` any depth, `!` excludes; a positive entry is required for `ops_glob` only), `ops_grep` has no `include` field, and `ops_replace.pattern` is literal text, not a regex. (#44)
- State the result contract precisely, in the descriptions and the prompt section, only for published tools: file tools, `ops_batch` and `ops_result` resolve failures as `status: "error"|"rejected"` values and never throw; `ops_bash` resolves command failures as values and throws only for invalid arguments or an unavailable executor. Drop the stale PTC note about catching errors from "legacy ops_* tools".
- Add `status: "completed"|"failed"` to `ops_bash` results (additive; `completed` only for a clean zero exit with no error, permission refusal, signal or timeout).
- Pin the `ops_grep`/`ops_glob`/`ops_replace` parameter keys against their descriptions, and prove the documented behaviour against the real worker.

## [0.2.6] — Owned MCP client lifecycle

- Track only plugin-owned MCP clients and terminate their exact serve processes on explicit Node process exit; never enumerate or kill shared runtime-host processes.
- Force the existing FastCtx identity-aware parent watcher on for spawned serve clients, even if FASTCTX_NO_PARENT_WATCH=1 was inherited. Forced-owner termination and stdin EOF are covered against the published binary.
- Make close immediate for pending requests and idempotent for concurrent callers; wait for the same shutdown and bound force-kill escalation. Close a live child whose reply stream reaches EOF.
- Preserve shared-runtime leases until the final component releases them. Retain all 0.2.5 fixes and the one-time config migration; no Rust/runtime payload changes or context-compaction beta.

## [0.2.5] — Stable safety and verification hotfix

- Default `allowSystemShellFallback` to false in code and the shipped shell row. Ambient PATH/well-known bash discovery requires explicit opt-in; configured and plugin-owned shells still work.
- Run a one-time startup config self-check per owning row: disable legacy explicit fallback before executor resolution, submit write-back with configUpdateVersion 1 through the loader, and preserve later manual opt-ins. Keep all upgrade modifications in lib/config-updates.js.
- Bind FastCtx to the resolved bash or a disabled executor sentinel; with no approved executor, do not publish background commands. Key shared runtimes by executor policy to prevent one component's fallback choice leaking into another.
- Restore `npm run verify` against the current PNG icon, independent components, scoped command permissions, prompt tables, registry ownership and unload lifecycle. Fail on mount deadlines and bound each suite to 120 seconds.
- Map the main package explicitly to the unchanged three payload packages at 0.2.1 and clarify historical Release assets/checksums and verification records.
- Exclude the context-compaction beta branch entirely: no compaction component, dependency, code or bundle row.

## [0.2.4] — Independently toggled components

- Split the market bundle into shell (on), file (on), and background (off) rows with exported per-component titles, descriptions, icons and locales.
- Publish five tools by default, nine with background enabled. Stop publishing duplicate foreground ops_run. Preserve the bash/PowerShell 7 routing and the object-root bash schema.
- Own separate prompt sections for each component; visibility and shutdown withdraw only the matching guidance/tools. Do not append to AGENTS.md.
- Share one ref-counted plugin-owned FastCtx connection for file/background. Drain in-flight calls and attempt to kill only remembered owned jobs when background stops; report cleanup failures.
- Replace the unconditional bundle pwshPath override with a runtime-only official config lifecycle overlay; shell OFF recomputes the executor's current owning raw config without persisting changes.
- Document release-age version selection and the limits of token savings. No host/vendor implementation, old regression suite, or Actions changes.

## [0.2.3] — Strict-argument guidance and display metadata

- Add one routing-section reminder: `ops_* arguments are strict: pass only declared fields.` Keep FastCtx's portable schema subset and runtime guards unchanged.
- Use `dsh-ops` as the display title in both locales and align package/install descriptions with the maintainer's Windows bash, PowerShell 7, and Rust tools wording.
- Replace the display icon with the maintainer-provided image, resized without cropping to a 256×256 PNG (119,677 bytes), below the official host's 256 KiB limit.
- Reuse all three runtime payload dependencies at 0.2.1; preserve the 0.2.2 bash object-root schema fix.

## [0.2.2] — Bash parameter schema hotfix

- Fix `ops_bash` parameters to use a JSON Schema object root with `properties`, `required: ['command']`, and `additionalProperties: false`. The previous field map was forwarded unchanged by the official host and rejected by the model API before tool execution.
- Reuse the three published Windows runtime packages at exact version 0.2.1; only the main plugin package changes.
- Validate the exported schema through the official host tool registry without calling a model. Registry installation and shell version probes alone did not verify this boundary in 0.2.1.

## [0.2.1] — Windows payload packaging — published

Published to the public npm registry on 2026-10-08 as `dsh-ops@0.2.1` with
`@dsh-ops/fastctx-win32-x64@0.2.1`, `@dsh-ops/bash-win32-x64@0.2.1` and
`@dsh-ops/pwsh-win32-x64@0.2.1`. Packed sizes and registry digests:
[docs/release-0.2.1.md](release-0.2.1.md).

- Assemble complete digest-verified PortableGit/bash and PowerShell 7 runtime packages instead of metadata-only pins; inject all three Windows x64 runtime dependencies in the publish artifact.
- Add explicit-profile install/status/uninstall delegation to the official DSH manager; map tui to dsh-tui and use Desktop's installation-owned CLI.
- Resolve the pwsh dependency from the plugin package under pnpm isolation.
- Make the default README Chinese and add a concise English translation.
- Materialize PortableGit's hardlinked paths during assembly: npm rejects hard links with E415, so the shell packages publish regular files with identical bytes.
- Fix credential selection: the first publish attempt used an unrelated local npm token and received E403. The maintainer's explicitly selected bypass credential was accepted; the earlier attribution of that failure to the maintainer's token was wrong.
- Known unresolved item: complete corresponding-source delivery for the GPL/LGPL components in the PortableGit inventory was not collected or reviewed, and no source offer is claimed. Publication proceeded at the maintainer's explicit direction.

## 0.2.8 — Missing bash payload diagnostics

Issue #9 showed that a host package-manager prune can leave the bash payload declared in the profile lockfile but absent on disk. `ops_bash` now converts a spawn-time `ENOENT` into a concise actionable result instead of exposing a raw process exception. It does not silently fall back to an unapproved system shell.

The Electron `workspace-write` `0xC0000142` ACL-runner failure is a DSH host sandbox issue outside this plugin's subprocess API. This release documents that boundary and does not claim to repair the host's Windows ACL runner.


### Changed

- Add `ops_bash.script_path` for executing existing scripts without placing their contents in a large JSON string; retain `command` for short commands and pipelines.
- Guide the model to use `script_path` for long, heredoc-heavy or escape-heavy scripts, reducing malformed tool-call risk and wasted turn tokens.
- Replace the execution ladder and duplicate prompt sections with one compact routing table.
- Preserve `ops_bash` as the preferred general command executor in the tools → bash → PowerShell 7 design; publish it in full-access agent scopes with the host subprocess service. Keep the compact routing table and use pwsh only for necessary Windows-native operations.
- Publish command/job tools only in plugin-owned agent fibers under authoritative per-session `danger-full-access`; reconcile `sandbox/mode` changes and recheck calls. No env/preset fallback.
- Reject image inspection explicitly and advertise PDF text only; preserve batch text ranges, encodings, hex, search filtering, and batch replacement.
- Shorten published schema descriptions and advertise only symmetric grep context. Forward ordinary arguments unchanged.
- Track background-job ownership per session/connection; reject foreign output/kill, filter background footers, and project owned job listings/counts/pagination.
- Withdraw tools on disconnect. Scope all definitions/disposers to plugin ownership, with no shared registry rewrite or host value imports.
- Declare read-only sibling concurrency through the host's function API. Do not assert host timeout quiescence; preserve the existing transport deadline.

### Measurement and validation

- Add a standalone schema measurement command and pre-change baseline, not a test gate.
- Document manual acceptance and limits. No regression tests/CI added, existing tests neither updated nor run for this change.
- Filesystem confinement of FastCtx file tools, per-command approval escalation, and cancellation quiescence remain outside this pass.

## [0.2.0] - Unreleased

The command-execution ladder, the plugin's own shells, the runtime package and the
two shell pins that bring them, and the end of the MCP bridge dependency. Not
published either: the repository still has no remote and no release tags, and this
entry is where `package.json` / `dsh-plugin.json` move to `0.2.0`; no tag has been
cut from it.

### Added

- **The command-execution ladder.** `lib/policy.js` renders the repository-tooling
  section as an explicit ladder — FastCtx (`ops_*`), then `ops_bash`, then
  PowerShell 7, then the host's own shell tools as the last resort — naming only the
  rungs the model can actually reach and renumbering the rest, so the text the model
  reads has no gaps. Preference is wording: the plugin never retries a failed call
  on another rung and never cascades at run time.
- **`ops_bash`** — the plugin's own bash, published as an ordinary tool through
  `ctx.tools.register` (only while the host's subprocess service is mounted) and
  executed through `ctx.get('subprocess')`, so commands run under the harness's own
  credential scrub, output spilling, and process termination. Its environment is the
  terminal overrides (`NO_COLOR`, `TERM`, `PAGER`, `GIT_PAGER`) and nothing else: it
  forwards no credential-shaped name and no `DSH_*` fact, and it never writes
  `process.env`, `PATH`, or the working directory.
- **PowerShell 7 as rung 3.** The bundle patch re-points the host's `pwsh-sandbox`
  row at the plugin's own pwsh through a `!!js` `pwshPath` — Windows-gated,
  `lstat`-based usability checks over both bundled layouts in one order (the
  installed `@dsh-ops/pwsh-<platform>-<arch>` package first, then the vendored copy),
  and a wrapping `try`/`catch`. A deployment whose package carries neither copy gets
  `undefined`, which is the row's own default, so the host's PowerShell resolution is
  untouched. A profile overrides the entry in its own `cordis.patch.yml`, which
  applies after every bundle layer.
- **Per-agent visibility under `deny-host-shell`.** On `agent/created` the plugin
  masks the configured host shell tools out of that agent's view with
  `agent.ctx.tools.restrict({ deny })` — only while a rung of its own is live; the
  fence at `tools/pre-execute` stays the guarantee, and the mask's disposer is owned
  by the plugin as well, so unloading lifts it. With no rung of the plugin's own, the
  fence is kept, visibility is left alone, and the reason is reported once.
- Three config keys: `bashPath` (an explicit bash for rung 2, authoritative),
  `publishBashTool` (default `true`), and `allowSystemShellFallback` (default
  `true`, to confine rung 2 to plugin-provided shells).
- **One runtime package, and two pins instead of two redistributions.**
  `@dsh-ops/fastctx-<platform>-<arch>` carries this fork's slimmed FastCtx build
  (`bin/fastctx.exe`), built here. `@dsh-ops/bash-<platform>-<arch>` and
  `@dsh-ops/pwsh-<platform>-<arch>` carry **metadata only** — the upstream URL,
  release, version, byte count, and SHA-256 of Git for Windows PortableGit and of
  PowerShell 7. Neither upstream binary is repackaged, forwarded, or redistributed
  by this distribution; the tag's GitHub Release carries this distribution's own
  tarballs and a `SHA256SUMS`, and nothing upstream's. `PROVENANCE.md` records every
  pin and licence.
- **`dsh-ops provision-shells [--bash|--pwsh]`.** Reads a pin, downloads that
  upstream archive on the user's own machine, verifies it against the pinned
  SHA-256, and unpacks it under `<DSH_HOME>/dsh-ops/shells/<name>/<version>/`, which
  is the first place both shell rungs resolve from. Nothing is downloaded at plugin
  load time, and nothing is downloaded unless the command is run.
- **`dsh-ops ladder`.** The CLI prints each rung's availability and the executable it
  came from, together with the rungs the prompt text renders for that answer, so a
  deployment can confirm which shells took effect without opening a session.
- **The shell resolution gained a provisioned tier, and so did the runtime chain.**
  Rung 2 resolves `config.bashPath`, then the provisioned copy, then a packaged copy,
  then `PATH`, then the well-known installs; rung 3 and the bundle patch that
  re-points the host's `pwsh-sandbox` row walk the same layouts in the same order. On
  the runtime side, the FastCtx chain tries `@dsh-ops/fastctx-<platform>-<arch>` ahead
  of the upstream `@fastctx/<platform>-<arch>` step, so an install gets this fork's
  build by default while a deployment without it still falls through to the vendored
  source build, the upstream package, or `fastctx` on `PATH`.

### Changed

- The repository-tooling section is no longer a flat tool list; it is the ladder
  above, rendered from the rungs the model can actually reach.
- `dsh-plugin.json` declares a second tool namespace for the tools the plugin
  registers itself (`ops_bash`, `transport: in-process`), and the manifest gate
  checks it against the fully-open ladder text.
- **This distribution's own platform packages are injected into
  `optionalDependencies` at release time, not committed.** Before the first release
  those names resolve nowhere, so listing them in the repository would put a failed
  optional fetch into every contributor's install log for no gain; the release step
  writes them, and the tarball it publishes is the one that declares them. The two
  shell pins cost an install nothing to declare, because they hold metadata and no
  binaries.
- The package version moves to `0.2.0` in `package.json` and `dsh-plugin.json`.

### Removed

- `pwshPath` and `overridePwshExecutor` are not config keys and now fail as unknown
  keys. A bundle patch is evaluated before any `dsh-ops` row is mounted, so a key
  could never reach the `pwsh-sandbox` override; rung 3 follows the executable
  instead, and the override is the patch entry documented above.
- `@deepseek-ai/dsh-mcp-client`, along with the `BRIDGE_PACKAGE` declaration and the
  manifest check that required it. The plugin holds the MCP stdio connection to the
  FastCtx server it spawns and publishes the tools itself (`lib/handshake.js`,
  `lib/tools.js`); it no longer mounts a bridge, and the 0.1.0 entry's
  registry-boundary renaming is gone with it.

### Fixed

- **`ops_bash` registers on the real host.** Its output schema used type arrays
  (`['integer', 'null']`), which the harness's schema gate rejects outright, so the
  tool could not be registered at all. Every `type` is now a single type and
  `exitCode`/`signal` are optional properties: an unknown exit fact omits the key
  rather than sending `null`.
- **Rung 3 and the host row are one fact.** The bundle patch's expression and the
  plugin's own probe now walk the same two bundled layouts
  (`BUNDLED_LAYOUT_ORDER`) in the same order with the same `lstat` test, so the
  ladder cannot advertise a PowerShell rung the host row does not run — or miss one
  it would.
- **The visibility mask follows the rungs that are live.** `deny-host-shell` used to
  hide the host shell tools whenever a bash merely resolved. The question is now
  asked of the ladder the model can reach — `ops_bash` published, or the PowerShell
  rung live — and asked again as each agent appears. With no rung of the plugin's
  own, visibility is left alone and the reason is reported once; the
  `tools/pre-execute` fence is unchanged and is installed by the mode alone.

## [0.1.0] - Unreleased

The first version. Not published: the repository has no remote and no release
tags, and `package.json` still carries `"private": true`.

### Added

- The plugin itself: one bundle that mounts the FastCtx MCP runtime as the
  profile's repository tool surface, publishes its tools under a namespace of the
  plugin's own, and injects two prompt sections that steer repository work away
  from the host shell.
- `shellPolicy: deny-host-shell` — an opt-in `tools/pre-execute` fence that
  refuses the configured host shell tools by name. FastCtx's own tools are never
  refused, so command execution stays available.
- The `dsh-ops` CLI: `resolve`, `status`, `build`, and `provision`. `provision`
  installs the built runtime into `<DSH_HOME>/dsh-ops/bin/` and writes a receipt
  recording its origin, version, and SHA-256.
- Composite licensing — MIT for the plugin, Apache-2.0 for `vendor/fastctx/` —
  with FastCtx's required notice reproduced verbatim in `README.md`,
  `README.zh.md`, and `NOTICE`.

### Changed

- **The FastCtx tools are published as `ops_*`.** The bridge's own
  `mcp__<serverName>__<rawName>` naming is transport vocabulary in every
  transcript, so registrations inside this plugin's bridge namespace are renamed
  at the registry boundary: the model calls `ops_grep`, and a transcript shows
  `ops_grep`. The `mcp__fastctx__*` names never reach the model.
- **The vendored FastCtx is stripped to its MCP server.** Upstream's control
  terminal (`src/tui/`), self-updater and upstream-version check (`src/update/`),
  and Codex integration — including `control/i18n.rs` and the other locale
  catalogs — are deleted rather than left unreachable, along with the
  distribution and CI machinery. 57 files changed, 285 insertions and 24,715
  deletions. The binary now carries `serve` plus the internal entry points the
  shell and session machinery spawn.
- `PROVENANCE.md` now records what was read from the readable `0.2.0-rc.2`
  source, with file and line, next to what a suite actually ran.

### Removed

- Upstream's `.github/`, `packages/` (the npm launcher, `codex-fastctx`, and the
  five `@fastctx/<platform>` binary packages), and `scripts/`.
