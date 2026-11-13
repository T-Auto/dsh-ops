# Changelog

All notable changes to this package are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Add an explicit native `--serve` transport and a scoped host client for #872. Correlated file requests use independently terminable trusted workers; cancellation does not stop the kernel. Activation and tool migration are still pending, so this slice does not change published tools or establish persistent shells.
- 为 #872 添加显式原生 `--serve` transport 与作用域内宿主客户端。带关联 ID 的文件请求使用可独立终止的可信 worker，取消不会停止内核。激活与工具迁移仍待完成；本切片不改变已发布工具，也不代表持久 shell 已实现。

- Document the resident-kernel target and its acceptance evidence for #872. Repository-only public-host and baseline probes distinguish transport/ownership feasibility from the pending resident execution and persistent-shell implementation; no tool behavior changes.
- 记录 #872 常驻内核目标与验收证据。仓库专用的公开宿主接口及基线探针区分通信/所有权可行性与尚待实现的常驻执行、持久 shell；工具行为未改变。

- Native tool construction and the publication refusal queue no longer attach listeners or lifetime effects to the composition root. The evidence observer and result admission subscribe on the caller's context with global dispatch, and the refusal queue falls back to the caller lifetime when the root refuses an effect. dsh-tui 0.20 refuses `root.events.on` and `root.effect` from a plugin activation, and the native-tools row is one, so every `dsh-tui --resume` aborted with "cannot resume session" before the agent mounted.
- 原生工具构造与发布拒绝队列不再向组合根挂监听或生命周期 effect：证据观察者与 result admission 改为在调用方上下文订阅并声明 global 分发，拒绝队列在 root 拒绝 effect 时回落到调用方生命周期。dsh-tui 0.20 会拒绝插件激活期内的 `root.events.on` 与 `root.effect`，而原生工具行正是插件激活，导致每次 `dsh-tui --resume` 都在 agent 挂载前报 "cannot resume session"。

## [0.5.5] — 2026-11-13 — Patch release

- A loader-less PTC scope no longer registers the configured `allowedTools` pool: with dynamic loading off nothing could ever select those APIs, and a host assembly without a step tool set declared all sixteen in `tools:sdk`. Resident publication, the default inspect + loader set and selection behavior are unchanged (#887).
- 关闭动态加载的 PTC 作用域不再注册 `allowedTools` 候选池：没有 loader 时这些 API 永远不可选，而缺少 step tool set 的宿主装配会把十六个全部写进 `tools:sdk`。常驻发布、默认 inspect + loader 与选择行为不变（#887）。
- Glob accepts `kind: file | directory | all` (default `file`), including empty directories in shallow listings without following links or changing hidden-item policy. Partial Native searches retain paths, scan counters, skip reasons and bounded diagnostic examples; directory read refusals give usable guidance.
- Glob 新增 `kind: file | directory | all`（默认 `file`），浅层列举可见空目录，仍不跟随链接，也不改变隐藏项策略。Native 搜索不完整时保留路径、扫描计数、跳过原因与有界诊断样例；目录读取拒绝给出可执行指引。
- Correct the model-visible glob/grep/read-files result shapes and the ops-ptc batching examples. Bypass reminders distinguish command-output filters from definite file access. On-demand integration diagnostics report the host-selected runtime version or `unknown`, without adding version text to prompts or SDKs. Shared SDK declaration deduplication remains a documented host dependency.
- 修正模型可见的 glob/grep/read-files 结果类型与 ops-ptc 批量示例。绕过提醒区分命令输出过滤与明确的文件操作。按需集成诊断返回宿主选定的运行时版本或 `unknown`，不向提示词或 SDK 注入版本文字。公共 SDK 声明去重仍作为宿主依赖记录。
- Native output omits only proven duplicate summaries and successful read-only zero-change counts, preserving scan/page/display completeness and failure facts. The Native naming audit identifies the host-owned stale `read` instruction separately from OPS routing; no aliases or additional tools are published.
- Native 输出仅合并已确认重复的摘要，并省略成功只读操作的零变更计数，保留扫描、分页、显示完整性与失败事实。Native 名称审计将宿主自有的过期 `read` 指引与 OPS 路由区分记录，不发布别名或额外工具。
- `ops_glob` and `ops_grep` gain an opt-in `includeHidden` flag (default `false`, so unchanged behaviour). Dot-prefixed directories such as `.github` were pruned before any pattern was matched, which meant the caller could not ask for them even by naming them explicitly in `pattern`; the answer was quietly narrow and looked complete. The flag lifts exactly one rule: `node_modules`, `target`, `.venv`, `.git`, symlinks, junctions and reparse points stay excluded, a caller-supplied `!` exclusion still wins, and the plugin's own `.dsh-ops` sidecars stay invisible under every setting because those names — the store directory, `.dsh-ops-update-<sha256>.lock` and the `.a.ts.dsh-ops-<uuid>` atomic-write temporary — are what guard writes in flight; the old blanket dot rule used to hide the temporary by accident, and lifting that rule must not start reporting a half-written file as a match. That check matches whole names, not a prefix, so caller content such as `.dsh-ops-backup/`, `.dsh-ops.json` or `.notes.txt.dsh-ops-personal-backup` keeps working. Scan budgets, credential denials and the no-follow rule are unchanged, no `.gitignore` parsing is added, and the recursive-matching semantics of `glob` are untouched. Three limits are worth stating: `ops_replace` never takes the flag (it rewrites what it walks, so a reading preference is not one of its arguments); a call with `includeHidden` declines the index and takes the live walk, because an index built with dot directories pruned cannot answer a question about them; and changing the flag between pages rejects the older continuation with `SEARCH_STALE`, since the flag is part of the cursor's binding. `skipReasons.excluded` still counts pruned traversal entries rather than lost files, so it was and remains a lower bound on what a narrow answer omitted.
- `ops_glob` 与 `ops_grep` 新增可选开关 `includeHidden`（默认 `false`，行为不变）。点前缀目录（如 `.github`）此前在任何模式匹配之前就被剪掉，调用方即使把目录显式写进 `pattern` 也换不回来——答案悄悄变窄却看起来是完整的。该开关只解除这一条规则：`node_modules`、`target`、`.venv`、`.git`、symlink、junction 与重解析点仍被排除；调用方显式写的 `!` 排除依然生效；插件自己的 `.dsh-ops` 内务文件在任何设置下都不可见，因为这些名字——store 目录、`.dsh-ops-update-<sha256>.lock` 与原子写的临时文件 `.a.ts.dsh-ops-<uuid>`——正是写入在途的保护；临时文件此前是被那条笼统的点规则顺带藏起来的，解除该规则不能反而把写了一半的文件当成命中返回。该判断匹配完整名字而非前缀，所以 `.dsh-ops-backup/`、`.dsh-ops.json`、`.notes.txt.dsh-ops-personal-backup` 这类调用方内容照常可用。扫描预算、凭据拒绝与不跟随规则都不变，不新增 `.gitignore` 解析，`glob` 的递归匹配语义不受影响。有两条边界要讲清：`ops_replace` 永不接受该开关（它会改写自己走过的东西，读取偏好不是它的参数）；带 `includeHidden` 的调用会绕开索引走实时遍历，因为索引是在点目录被剪掉的前提下建的、答不了关于它们的问题；分页途中改动该开关会让旧 continuation 被判 `SEARCH_STALE`，因为开关属于游标绑定。`skipReasons.excluded` 仍统计被剪掉的遍历条目而非丢失的文件，所以它过去是、现在仍是「窄答案漏了什么」的下界。
- Fix an enumeration/naming disagreement the flag exposed: `ops_grep` and `ops_replace` accepted an explicit single-file root such as `.dsh-ops-update-deadbeef.lock` and read it, while the same path was invisible to every enumeration. The root name is now checked against the same two exact shapes, so an explicit sidecar path returns `PATH_RESTRICTED` instead of its contents. Ordinary explicit file roots still read, and names that merely begin the same way — `.dsh-ops-backup/`, `.dsh-ops.json`, a lock-shaped name with the wrong digest — remain readable, which is the rule `ops-files` settled on in review of #81.
- 修复该开关暴露出的「枚举与显式命名不一致」：`ops_grep` 与 `ops_replace` 此前接受 `.dsh-ops-update-deadbeef.lock` 这类显式单文件根并读出内容，而同一条路径在任何枚举里都不可见。现在根名也按同样两种精确形状检查，显式指向内务文件会返回 `PATH_RESTRICTED` 而不是内容。普通文件的显式根仍照常读取；只是开头相同的名字——`.dsh-ops-backup/`、`.dsh-ops.json`、摘要不对但形似的锁名——仍然可读，这正是 `ops-files` 在 #81 评审后定下的规则。

## [0.5.4] — 2026-11-11 — Patch release

- Fix `ops-ptc` silently losing batching guidance when an older profile replaces the whole bundle row config and omits the new mode section. The code now defaults `batchingGuidance` to true for `ops-ptc` only; explicit false still disables it, other modes remain off, and telemetry remains opt-in.
- 修复旧 profile 整行覆盖 bundle 配置且缺少新模式配置节时，`ops-ptc` 静默失去批量引导的问题。代码现在仅对 `ops-ptc` 默认开启 `batchingGuidance`；显式 false 仍可关闭，其它模式仍默认关闭，遥测仍需主动开启。

- CI: the three `validate-*` jobs are one `validate` matrix over the four shipped targets, and the Rust version is read from `native/rust-toolchain.toml` by a shared `.github/actions/setup` action instead of being written in eight places. The cargo cache is scoped per job, OS and architecture, holds dependencies only (no incremental state or workspace artifacts), is invalidated by a new toolchain or flags instead of accumulating old trees, and is saved only by pushes. `CI required` now judges `toJSON(needs)` directly instead of a second hand-kept list. The Linux leg stages the published musl worker before the suites run (`verify-gate.mjs --worker-target`), and `rust-lint` runs clippy for the Linux, Windows and macOS targets, which exposed an `unreachable_code` error in `ops-files` that only exists on macOS (fixed without a behaviour change). The three macOS FSEvents idle-stream tests, which failed on cold runners because they asserted an empty batch that FSEvents does not promise, now assert that no event lies inside the tree and that `recovery()` still answers caught-up.
- CI：三个 `validate-*` job 合并为覆盖四个发布目标的 `validate` 矩阵，Rust 版本由共享的 `.github/actions/setup` 从 `native/rust-toolchain.toml` 读取，不再在八处手写。cargo 缓存按 job、系统与架构隔离，只存依赖（不含增量状态与工作区产物），工具链或编译参数变化时整体失效而不是堆叠旧产物，且仅由 push 保存。`CI required` 直接对 `toJSON(needs)` 判定，不再维护第二份名单。Linux 腿在跑 suite 之前先 stage 发布用的 musl worker（`verify-gate.mjs --worker-target`），`rust-lint` 对 Linux、Windows、macOS 三个 target 跑 clippy，并因此发现 `ops-files` 里一处只在 macOS 上存在的 `unreachable_code` 错误（已修复，行为不变）。三个 macOS FSEvents 空闲流测试此前断言“batch 必须为空”，而 FSEvents 并不承诺这一点，冷启动的 runner 上会失败；现改为断言树内没有任何事件，且 `recovery()` 仍判定为已追平。

## [0.5.3] — 2026-11-11 — Patch release

- The batch trigger now analyses the **root `run_code` program text** instead of counting repeated writes. Three independently latched categories — `bypass` (file work through the shell or `node:fs`), `plan` (no `// plan:` on the first physical line) and `shape` (a single operation in its own round trip) — each speak once per turn; a program that complies re-arms its category, so a regression inside the same turn speaks again, with no per-turn cap. Only the root call is inspected, delivery priority is `bypass` → `plan` → `shape`, and the notice rides the triggering result as `additionalContexts` without changing the tool value, its content or the system prompt.
- 批量触发器改为分析**根 `run_code` 的程序文本**，不再统计重复写路径。三类独立锁——`bypass`（用 shell 或 `node:fs` 做文件工作）、`plan`（第一物理行没有 `// plan:`）、`shape`（一次往返只做一件事）——每类每轮各发言一次；某类一旦合规即解锁，同一轮内先改对再退回仍可再次提醒，且不设每轮条数上限。只检查根调用，投递优先级为 `bypass` → `plan` → `shape`，提醒以 `additionalContexts` 附在触发调用自身的结果上，不改工具值、正文与系统提示词。
- The teacher trajectory is now a full procedure: the first-line `// plan:` directive with both `;` and the full-width `；` as separators, the dependency split, the load-before-call step (`ops_load_sdk` takes effect on the next program), four copyable trajectories that use the OPS file APIs instead of the shell, the 128-dispatch ceiling and the common-mistake table.
- 教师轨迹补全为完整流程：首行 `// plan:` 指令（`;` 与全角 `；` 均可作分隔符）、按依赖拆分、先加载再调用（`ops_load_sdk` 在下一个程序生效）、四条改用 OPS 文件 API 而非 shell 的可照抄轨迹、单程序 128 次派发上限，以及常见错误表。
- Fix the one-time teaching latch: the lesson is spent only once it appears as a durable `user/message`. The step-tail provider no longer latches on its own return value, so a batch withdrawn before admission (cancellation, rejection, failed request preparation) leaves the next accepted batch free to teach it again instead of silently skipping the lesson for the whole session.
- 修复一次性教学闩锁：教学只有在真正出现持久 `user/message` 时才算兑现。step-tail provider 不再在自己的返回值上置位，因此因取消、拒绝或请求准备失败而撤回的批次不会消耗它，下一个被接受的批次仍会教学，不会整会话静默跳过。
- Add the YAML-only `batchingTelemetry` row switch (default `false`): one structured log line per delivered notice, e.g. `dsh-ops batching: turn=3 category=plan plan=1 bypass=0 shape=2 total=3`. Observation only — no context, no message, no new dependency.
- 新增 YAML-only 模式行开关 `batchingTelemetry`（默认 `false`）：每投递一条提醒打印一行结构化日志，例如 `dsh-ops batching: turn=3 category=plan plan=1 bypass=0 shape=2 total=3`。只做观测——不产生上下文、不发消息、不引入新依赖。
- Remove the repeated-write detector and the `wrapDispatch` interceptor it required on the shared file lease, so the shared dispatch identity is untouched again.
- 移除重复写检测，以及它给共享文件租约加的 `wrapDispatch` 拦截器，共享派发的身份恢复原样。
- Windows Niubash selection no longer hashes the payload. Each mode consumer, the settings page and `ops_status` hashed the source and the prepared copy (about 893 MiB, faces included) synchronously on the host thread, so one default mount of four modes stalled for seconds. Selection now checks only that each pinned file is present with its pinned size, reads no contents and writes nothing; bytes are still hashed where they enter the machine (package build and `provision-shells --bash`). The prepared runtime is built asynchronously at the first Bash call, once per process, and its publication backoff no longer blocks the event loop. Files the shell writes into its state directories no longer mark the prepared copy damaged and force a full rebuild.
- Windows Niubash 选择阶段不再哈希载荷。此前每个模式消费者、设置页和 `ops_status` 都会在宿主线程上同步哈希源载荷与准备副本（含 face 约 893 MiB），默认四个模式挂载一次就卡数秒。选择现在只检查每个固定文件存在且大小一致，不读取内容、不写文件；字节仍在进入本机时哈希（打包构建与 `provision-shells --bash`）。准备运行时改为进程内第一次 Bash 调用时异步构建一次，发布退避不再阻塞事件循环。Shell 写入启动目录的文件不再使准备副本被判为损坏而整份重建。
- Prepared-version retirement (online, and offline `cache reclaim --kind exec-tree`) removes an already `.retired-` sibling in place instead of renaming it again. Two hosts cleaning up at once could split one tree across two names, and `rmSync(force)` reported success for the half it no longer found, leaking the rest.
- 准备版本退役（在线退役与离线 `cache reclaim --kind exec-tree`）对已是 `.retired-` 的兄弟目录改为原地删除，不再二次改名。两个宿主同时清理时可能把一棵树拆到两个名字下，而 `rmSync(force)` 对找不到的那一半照样报告成功，剩余部分因此泄漏。
- Add the `global.forceDefaultOpsPtc` bundle switch (default true): while the `dsh-ops` row is enabled and the `ops-ptc` preset registered, it forces the profile's default preset to `ops-ptc` at runtime by writing `selectedDefault` through the host settings service (the settings-page mechanism, overriding a manual choice). Turning the switch off, disabling or unloading the row restores the value captured before forcing, or the host `config.default` (the official default) when nothing was captured or the captured value is `ops-ptc`. The forced default persists through the host settings layer into the profile patch and survives a restart; saving another switch on the row re-confirms it, and a failed registration never forces while best-effort restoring a leftover forced default. A missing settings service or a failed write only logs a warning.
- 新增 bundle 总开关 `global.forceDefaultOpsPtc`（默认 true）：`dsh-ops` 行启用且 `ops-ptc` 预设注册成功时，在运行时通过宿主 settings 服务把 `selectedDefault` 写成 `ops-ptc`，强制新会话默认使用该预设（与设置页同一机制，会覆盖手动选择）。关闭开关、禁用或卸载插件行时恢复强制前捕获的值；未捕获或捕获值本身是 `ops-ptc` 时回退宿主 `config.default`（官方默认）。强制值经宿主设置层持久化到 profile patch，重启后保持；保存该行其它开关会重新确认；注册失败不强制，仅尽力回退残留默认。宿主 settings 服务缺失或写入失败只记 warning。
- Describe the `OPS (PTC)` preset in Chinese: "代码驱动的 PTC 工具面，由 dsh-ops 的 ops_* 工具扩展。" The name stays `OPS (PTC)`; the generated fragment and its sync script carry the new description.
- `OPS (PTC)` 预设描述改为中文「代码驱动的 PTC 工具面，由 dsh-ops 的 ops_* 工具扩展。」，名称仍为 `OPS (PTC)`；生成片段与同步脚本同步该描述。

- Add the `ops-ptc` enhanced preset as the fifth built-in mode. `dsh-ops` registers it at apply time through the host agent preset registry from the shipped `presets/ops-ptc.patch.yml` loader fragment (parsed by the host's `loadOverlayPatches`), not from a bundle patch or a plugin-manager row; the merged row gains an `ops-ptc` section with the same typed PTC surface, and compaction stays the official `compaction-basic`.
- 新增第五个内置增强模式 `ops-ptc`：`dsh-ops` 在 apply 时通过宿主预设注册表注册它，定义来自随包片段 `presets/ops-ptc.patch.yml`（由宿主 `loadOverlayPatches` 解析），不再是 bundle patch 或插件管理器行；单行配置新增 `ops-ptc` 分区并发布同一套类型化 PTC 工具面，压缩沿用官方 `compaction-basic`。
- Fix `ops-ptc` preset ownership: drop the old bundle-layer wiring (the fragment is no longer a bundle patch and the default is no longer a static `agent-preset-registry` override), so the preset is a runtime registration that lives and dies with the `dsh-ops` row and a missing or rejected fragment only warns while the tools keep working. Default handling now lives in the explicit `global.forceDefaultOpsPtc` switch; with the switch off, a manually set `ops-ptc` default must be switched before disabling that row or new sessions cannot resolve the preset.
- 修正 `ops-ptc` 预设归属：移除旧的 bundle 层接线（片段不再作为 bundle 补丁，默认也不再用静态 `agent-preset-registry` 覆盖），预设改为随 `dsh-ops` 行启停的运行时注册，片段缺失或注册被拒只告警、工具面照常工作。默认处理改由显式的 `global.forceDefaultOpsPtc` 开关负责；开关关闭时，手动设成 `ops-ptc` 的默认仍须先切换再禁用该行，否则新会话解析不到预设。
- Move the batch-call guidance to the editable English `prompts/batching-guidance.md`, delivered from that one file: a lesson once in the session's first accepted user-message batch (logged history, visible to the first request, never the system prompt), plus the shape notices described by the entry above; the prompt prefix and tool schemas stay unchanged, and an unreadable file skips delivery instead of failing the call. Progressive disclosure under `ops-ptc` still follows `dynamicTools` (mode switch AND bundle switch), and loaded APIs appear only on the next model step.
- 批量调用提示改为可编辑的英文外置文件 `prompts/batching-guidance.md`，统一从该文件投递：会话首个被接受的用户消息批次里教学一次（进入历史、模型第一条请求可见、不改系统提示词），另加上一条所述的形状提醒；系统提示词前缀与 tool schema 不变，文件读不到时跳过投递而不影响调用。`ops-ptc` 的渐进式披露仍由 `dynamicTools`（模式开关与 bundle 总开关的与门）控制，新加载的 API 只在下一模型步骤可见。

- The package no longer ships the duplicate `README.zh.md`; `README.md` is the Chinese readme and `README.en.md` the English one.
- 发行包不再包含重复的 `README.zh.md`：`README.md` 即中文说明，`README.en.md` 为英文说明。

- Run Niubash preparation/security suites in the parallel pool using their private prepared copies; only the prepack consumer remains exclusive. Reduce the cold-payload watchdog and Windows release-gate budget from 600 to 300 seconds, retaining explicit overrides and ample headroom above the measured cold setup.
- Niubash 准备与安全套件使用各自 prepared 副本进入并行池，仅 prepack consumer 保持独占；完整载荷看门狗与 Windows 发布门禁预算从 600 秒调为 300 秒，保留显式覆盖，并为实测冷启动保留充分余量。

- Windows publication now distinguishes genuine sharing/lock conflicts from unsupported exFAT locks and preserves unrelated IO errors instead of fabricating `REVISION_CONFLICT`. Volumes without named-stream/ACL support preserve available basic metadata with `metadataWarnings`; source metadata that is present but unsupported still fails closed (#800).
- Windows 发布错误现在区分真实的共享/锁冲突、exFAT 不支持的锁及其他 IO 错误，不再伪造 `REVISION_CONFLICT`。不支持命名流/ACL 的卷会保留可用基本元数据并返回 `metadataWarnings`；源文件确有不受支持的元数据时仍闭锁拒绝（#800）。
- `stat`, `copy`, `move` and `remove` compute SHA-256 revisions by streaming, so revision checks no longer impose the 32 MiB whole-content buffer limit. Hex inspection seeks for its requested window instead of materializing the file; content-holding operations retain explicit size errors, and an unsupported inspect `encoding` is an `INVALID_ARGUMENT` naming that field.
- `stat`、`copy`、`move` 与 `remove` 改为流式计算 SHA-256 revision，不再受 32 MiB 完整内容缓冲限制。hex 检查按请求窗口定位读取，不再物化整个文件；必须持有内容的操作保留明确的大小错误，不支持的 inspect `encoding` 改为指明该字段的 `INVALID_ARGUMENT`。
- Search depth overflow now skips only the affected subtree and records `skipReasons`, while entry/file budget stops also record their cause. Blank glob entries name their index, grep pattern/limit errors are distinct, and directory replace records permission-denied reads and continues eligible neighbors while lock, staging and publication denials still fail (#796, #797).
- 搜索深度超限现在只跳过对应子树并记录 `skipReasons`，目录项/文件预算停止也会记录原因。空白 glob 条目会指明索引，grep 的 pattern 与 limit 错误分别报告；目录 replace 会记录读取权限拒绝的路径并继续处理其他合格文件，更新锁、暂存与发布阶段的权限拒绝仍使调用失败（#796、#797）。
- Read-only file/result worker deadlines, caller cancellation, lossy output and nonzero exits now report `effectState: none` with `TIMEOUT`, `ABORTED`, `OUTPUT_LIMIT` or `EXECUTOR_UNAVAILABLE` as appropriate; signal death remains `RESULT_UNKNOWN` without implying mutation. Mutating calls retain uncertainty. Bash preparation that never returned a process handle likewise reports no effects and keeps its failure-specific retry advice.
- 只读文件/结果 worker 的真实截止、调用方取消、输出丢失与非零退出现在报告 `effectState: none`，分别使用 `TIMEOUT`、`ABORTED`、`OUTPUT_LIMIT` 或 `EXECUTOR_UNAVAILABLE`；信号死亡仍为 `RESULT_UNKNOWN`，但不暗示发生写入。写入调用仍保留不确定性。Bash 准备在返回进程句柄前失败时同样报告无效果，并保留按失败类别给出的重试建议。
- `write_file`/`edit_file` descriptions and bilingual contracts now state the effective 2 MiB request budget, and oversized writes name `content` and advise splitting. Bash guidance requires background jobs for long-running/daemon starts and notes that `job_kill` terminates the job's process tree.
- `write_file`/`edit_file` 说明及双语契约现在标明实际的 2 MiB 请求预算，超大写入错误会指明 `content` 并建议拆分。Bash 指引要求长时间运行进程/守护进程使用后台任务，并说明 `job_kill` 会终止该任务的进程树。

- If another profile with a different Niubash pin retires the selected runtime, recover it once on the next call from its selected verified source without retiring other pins. Online retirement leaves other hashes' in-progress staging directories for offline cleanup.
- 同一 DSH_HOME 的另一 profile 使用不同 Niubash pin 并退役所选运行时时，下次调用从原选定的已验证源恢复一次，不退役其他 pin；在线退役保留其他哈希构建中的 stage 目录，交由离线回收。

- Retire obsolete prepared Niubash versions, broken/retired leftovers and same-hash staging leftovers after successful selection: rename each exact namespace directory once before best-effort deletion, leave busy versions for later, and keep unrelated paths untouched. `cache status/reclaim --kind exec-tree` also covers non-current prepared versions, never the current hash.
- 成功选择 Niubash 后退役旧准备版本及 broken/retired 和同哈希 stage 残留：仅处理精确命名空间目录，先尝试改名一次再尽力删除，保留繁忙版本待后续清理，不碰无关路径；`cache status/reclaim --kind exec-tree` 同样覆盖非当前准备版本，绝不回收当前哈希。

- Prepare Windows Niubash once per frozen manifest hash under `DSH_HOME`, copying the source without hardlinks and publishing command faces plus startup directories atomically. Calls reuse the prepared runtime outside the workspace and retain host confinement, without per-call execution trees, hashing, seals, receipts or disposal. `DSH_OPS_EXEC_ROOT` and `NIUBASH_VERIFY=deep` no longer configure execution; the former remains available only to discover legacy trees for offline reclamation (#817).
- Windows Niubash 按冻结清单哈希在 `DSH_HOME` 中一次性准备：复制源载荷但不建立源硬链接，预生成命令 face 与启动目录后原子发布。每次调用复用工作区外的准备运行时、保留宿主约束，不再创建执行树、哈希、封印、写收据或释放副本。`DSH_OPS_EXEC_ROOT` 与 `NIUBASH_VERIFY=deep` 不再配置运行行为；前者仅为离线回收发现旧执行树保留（#817）。

- Bound Windows first-preparation publication rename backoff to 10 seconds for temporary scanner sharing refusals only; preserve explicit publication diagnostics and never retry commands.
- Windows 首次准备发布时，仅对扫描器临时共享拒绝的目录 rename 退避最多 10 秒，保留明确发布诊断，绝不重试命令。
- Repair a damaged prepared Niubash version once at selection: move it aside, rebuild from the verified source, clean the old version best-effort, and report both causes if fresh preparation fails.
- 准备后的 Niubash 版本损坏时，在选择阶段移走旧目录并从已验证源载荷重建一次，尽力清理旧版本；新准备仍失败时同时报告两次错误。
- Reclaim incomplete legacy Niubash execution trees without requiring a completed execution receipt; verify every existing payload member, clear legacy deny ACEs/read-only attributes, and retain unknown contents. Offline confirmation is still required (#808).
- 回收不完整的旧 Niubash 执行树时不再要求完整执行收据；核验每个现存载荷成员，解除旧 deny ACE/只读属性，保留未知内容，仍要求明确离线确认（#808）。
- Official read/glob/grep declarations now yield to an admitted OPS replacement in the same model step, sharing the source's conditional admission rather than publishing both and refusing official calls with `MODE_REPLACEMENT`. When the counterpart is unavailable, official fallback keeps its schema and execution callbacks and respects existing restrictions; an unlinked host scope leaves the original official definitions untouched (#787).
- 官方 read/glob/grep 与 OPS 替代工具现在按同一模型步骤的准入结果互斥声明，不再同时发布后以 `MODE_REPLACEMENT` 拒绝官方调用；替代工具不可用时，官方回退保留原 schema 和执行回调，并遵守已有工具限制；宿主作用域关联失效时保留官方原始定义（#787）。
- Publication diagnostics distinguish stale or unadmitted definitions (`PUBLICATION_IDENTITY_MISMATCH`) from missing or conflicting dispatch grants (`PUBLICATION_GRANT_UNAVAILABLE`), without changing authorization boundaries or claiming a root-cause fix for #784.
- 发布诊断区分过期或未准入的定义（`PUBLICATION_IDENTITY_MISMATCH`）与缺失或冲突的分派授权（`PUBLICATION_GRANT_UNAVAILABLE`）；不改变授权边界，也不将诊断改进宣称为 #784 根因修复。
- Retain explicit create-only `expectedRevision: "absent"` guidance in compact tool help and refresh deferred-tool security/regression fixtures (#817).
- 精简工具说明时保留 create-only 所需的 `expectedRevision: "absent"` 明示，并同步延迟加载工具的安全与回归测试夹具（#817）。

- Reduce per-request tool overhead: Standard/Cordis keep only inspect/glob/grep resident, with read_files/result discovered on demand; PTC initially keeps inspect and load_sdk, with result loadable on demand even when allowedTools is empty. Replace always-resident capability directories with one-line loader pointers and remove prompt/schema repetition without changing argument defaults, limits, paging completeness or authority checks (#817).
- 减少每请求固定工具开销：Standard/Cordis 仅常驻 inspect/glob/grep，read_files/result 按需发现；PTC 初始仅保留 inspect 与 load_sdk，即使 allowedTools 为空仍可按需加载 result。常驻能力目录改为一行加载器指引，删除提示词与 schema 的重复说明，不改变参数默认值、限额、分页完整性或权限检查（#817）。
- Give CPU-bound test compilers, packers and fixture checks a shared 120-second subprocess budget so parallel-load contention is not mistaken for a hang; the CI suite watchdog remains in force and no failure is retried.
- 测试中的编译器、打包器和 fixture 检查统一使用 120 秒子进程预算，避免把并行负载争用误判为挂死；保留 CI 套件 watchdog，失败不重试。

- Run test suites in a bounded worker pool with isolated processes/homes, buffered output, per-suite timings and a slowest-ten summary; `DSH_OPS_TEST_JOBS=1` restores serial execution. Only the Niubash consumer stays exclusive because prepack rebuilds shared `lib/`; preparation and security suites use private prepared copies and run with the pool. Cache CLI fixtures use unique scratch directories across runs. Remove timeout retries and avoid repeating the plugin build and manifest validation inside the release gate.
- 测试套件改为有界并行，保留独立进程与临时 home，整块输出每套结果、耗时和最慢十套；`DSH_OPS_TEST_JOBS=1` 可恢复串行。仅 Niubash consumer 因 prepack 重建共享 `lib/` 保持独占；准备与安全套件改用各自 prepared 副本，可进入并行池。缓存 CLI fixture 使用跨运行唯一的 scratch 目录；删除超时重试，并去掉发布门禁内重复的插件构建与 manifest 校验。

- Unsealing an execution tree no longer skips a file whose Windows `dev:ino` matches another member's. That key is not unique on Windows, so a skipped file stayed read-only, could not be removed, and left the whole tree behind in the temp directory; a repeated `chmod` on a genuinely shared inode is harmless (#804).
- 解封执行树时不再按 `dev:ino` 跳过文件：该键在 Windows 上并不唯一，被跳过的成员会一直只读、删不掉，进而把整棵树留在临时目录里。对真正共享的 inode 重复 `chmod` 无害（#804）。
- A hardlink clone the filesystem refuses with `UNKNOWN` now rebuilds the tree as copies. Windows reports the per-inode link limit under that single code, so the five-code fallback gate never matched and every Bash call failed until the condition cleared on its own; the fallback now also records the payload's highest link count so the ceiling is visible next time (#804).
- 硬链接克隆遇到 `UNKNOWN` 失败时改为重建为复制副本。Windows 把 inode 链接上限归到这一个错误码下，此前五码白名单永远匹配不到，复制兜底不触发，每次 Bash 调用都会失败，只能等外部条件自行消失；现在回退还会记录 payload 的最高链接数，下次能直接看出是否触顶（#804）。
- A Bash/Niubash preparation failure now shows the link-count paragraph only when the failure itself carries a link-count signature, and that paragraph no longer tells an installation already on 0.5.2 to upgrade to 0.5.2. Every other unclassified failure keeps its own reason and falls through to the default text (#805).
- Bash/Niubash 准备失败现在只在错误本身带 link-count 特征时才显示那段说明，且该段不再要求已经运行 0.5.2 的安装去升级到 0.5.2；其余未分类失败保留自身原因、走默认文案（#805）。
- A Bash slot whose executor never resolved now says so in the prompt instead of rendering an empty section: the notice quotes the resolution `source` and `detail` (which already ends with the deployment remedy), points file work at the OPS file tools, and refuses to imply that swapping shells is a repair. Official PowerShell is still never hidden while Bash is unavailable.
- Bash 执行器未能解析时，提示段落不再留空，而是明确说明不可用：引用解析结果的 `source` 与 `detail`（后者已含部署侧修复办法），指明文件读写应走 OPS 文件工具，并明确不得以换 shell 充当修复；Bash 不可用时官方 PowerShell 仍绝不被隐藏。
- Load `@deepseek-ai/dsh-scope` from the copy the running host resolves. A bundle that hoists its own copy into the profile tree used to shadow the host's, so scope contexts read as unscoped and creating a session failed with `Publication scope must match its registration context` (#752). The adapter resolves the host entry's copy, then the profile layer, then the bare specifier.
- 从宿主实际解析到的那份 `@deepseek-ai/dsh-scope` 加载 scope 助手。某个 bundle 把副本提升进 profile 目录树时会遮蔽宿主那份，作用域上下文读不到标签，新建会话报 `Publication scope must match its registration context`（#752）。adapter 依次从运行入口、profile 层、最后才是裸导入解析。

## [0.5.2] — 2026-11-08 — Patch release

- Fix concurrent Windows Niubash preparation by verifying stable file identities instead of shared hardlink counts; retain preparing trees through disposal without replacing the zero-copy path or reverting 0.5.1's bounded retention.
- 修复 Windows Niubash 并发准备：以稳定文件身份而非共享硬链接计数校验，准备中的执行树参与释放协调；保留零拷贝路径和 0.5.1 的有界保留修复。
- Allow the merged settings row to persist and clear the selected Git Bash path in all four built-in modes.
- 合并设置行可在四种内置模式中保存、清除选定的 Git Bash 路径。
- Offline execution-cache reclamation discovers configured/same-volume roots and clears the verified tree's read-only/deny-delete seal before removal; Niubash failures give specific recovery commands instead of promising a retry fixes every failure.
- 离线执行缓存回收覆盖显式及同卷根目录，删除前解除已验证树的只读/拒绝删除封印；Niubash 故障提供具体恢复命令，不再笼统承诺重试可修复。

## [0.5.1] — 2026-11-08 — Patch release

- Bound temporary-resource growth through ownership ledgers, deferred result-cache cleanup and explicit cache reclamation; preserve data-bearing snapshots and user content. Host output spills now have bounded retention rather than accumulating indefinitely.
- 通过归属台账、结果缓存延迟清理与显式缓存回收约束临时资源增长，保留含数据的快照与用户内容；宿主输出 spill 采用有界保留，不再无限积累。
- Packing an installed package no longer requires repository-only build scripts; source checkouts still build and verify their payload before packing.
- 从已安装包重新打包不再依赖仓库专用构建脚本；源码检出打包前仍执行构建与载荷校验。
- Include the integrated cross-platform index/query work and its verified Windows, Linux and macOS correctness fixes; the Windows MFT source remains opt-in.
- 包含已集成的跨平台索引/查询及经过验证的 Windows、Linux、macOS 正确性修复；Windows MFT 来源仍须显式开启。

- `ops_grep` gains `outputMode: "definitions"`: it returns only the lines where the matched identifier is declared (function, method, type, variable, macro), classified lexically in the native worker — no parser, no new dependency, same no-follow/credential/limit boundaries. `matched` counts every matching line and `total` the returned declarations, so a complete scan reports how many references it withheld; `multiline` and context flags are refused in this mode.
- Add `dsh-ops cache status|reclaim`: report every temporary resource OPS can reproduce — kept provision downloads, Niubash staging/previous siblings, quarantined Bash IPC generations, audit-store writer temporaries and per-call execution trees — with per-row ownership evidence, `deleted`/`kept`/`unverified` decisions and byte totals. It previews by default, refuses `--yes` without `--all-hosts-stopped`, and never deletes on a name pattern, mtime or dead PID.
- Failed provision downloads are registered under `<DSH_HOME>/dsh-ops/pending/` and reclaimed under a count/byte/age budget; a shell version is unpacked and verified in a staging sibling and only then renamed into place, so a failed or interrupted install leaves the previous version usable and no half-unpacked tree.
- Niubash staging and previous siblings are verified before use: a complete staged tree is reused, a complete previous tree is restored when the target is missing, and trees that do not verify are kept. A refused previous-tree removal no longer reports a completed install as failed.
- Offline Bash IPC cleanup reclaims quarantined copies beyond the newest two; audit-store `.tmp` writer files are swept when the store is opened for writing.
- `ops_grep` 新增 `outputMode: "definitions"`：只返回匹配标识符处于声明位置的行（函数、方法、类型、变量、宏），由 native worker 做词法判定——不引入解析器与新依赖，沿用 no-follow/凭证/限额边界。`matched` 计所有匹配行、`total` 计返回的声明行，完整扫描可据此知道略过了多少引用；该模式拒绝 `multiline` 与上下文参数。
- 新增 `dsh-ops cache status|reclaim`：报告 OPS 可再生的全部临时资源（保留的 provision 下载、Niubash staging/previous 兄弟目录、被隔离的 Bash IPC generation、审计写入临时文件和每调用执行树），逐项给出来源证据、`deleted`/`kept`/`unverified` 决策与字节数。默认预览，缺少 `--all-hosts-stopped` 时拒绝 `--yes`，绝不按名字、mtime 或死 PID 删除。
- 失败的 provision 下载登记到 `<DSH_HOME>/dsh-ops/pending/` 并按数量/字节/年龄预算回收；shell 版本先在 staging 兄弟目录中解包校验、再 rename 就位，失败或中断不再留下半解包目录，也不再破坏旧版本。
- Niubash 的 staging/previous 兄弟目录先验证后使用：完整 staging 直接复用、target 缺失时用完整 previous 恢复、无法验证的保留；删除 previous 失败不再把已完成的安装报成失败。
- 离线 Bash IPC 清理会回收最新两份之外被隔离的副本；审计存储以写模式打开时清扫 `.tmp` 写入残留。
- The per-call Niubash execution root now follows the payload's volume on Windows. When `DSH_OPS_EXEC_ROOT` is unset and `os.tmpdir()` sits on another volume, the clone is created below `<payload volume>\dsh-ops-exec`, and the default configuration keeps the zero-copy hardlink path instead of silently falling back to copying 785 MiB per call. That directory must be a real directory the current account owns — a junction, a directory owned by another account, or a path overlapping the payload is refused and the call falls back to the temp directory with the reason reported; an explicit `DSH_OPS_EXEC_ROOT` is validated the same way but fails loudly instead of being silently replaced. POSIX paths always reduce to one volume root, so a tmpfs `/tmp` still needs an explicit `DSH_OPS_EXEC_ROOT`.
- 每次调用的 Niubash 执行根在 Windows 上改为跟随载荷所在卷：未设置 `DSH_OPS_EXEC_ROOT` 且 `os.tmpdir()` 与之不同卷时，克隆改在 `<载荷所在卷>\dsh-ops-exec` 下创建，默认配置因此保持零拷贝硬链接路径，而不是静默回退为每次调用复制 785 MiB。该目录必须是当前账户拥有的真实目录——重解析点、被其他账户拥有的目录、或与载荷路径重叠时会被拒绝，调用回退到临时目录并报告原因；显式设置的 `DSH_OPS_EXEC_ROOT` 走同样校验，但会直接报错，不会被静默替换。POSIX 路径一律归约为同一个卷根，因此 tmpfs 上的 `/tmp` 仍需显式设置 `DSH_OPS_EXEC_ROOT`。
- Fixed the stale `niubash-consumer` assertion that still expected `all 10 checks passed` after `niubash-security-host` grew to 11 checks, which failed every full-gate run.
- 修正 `niubash-consumer` 中过时的断言：`niubash-security-host` 增至 11 项检查后，consumer 仍断言 `all 10 checks passed`，导致完整门禁必挂。
- An execution root below the workspace now clones by copy instead of hard links. The host sandbox labels the workspace tree with an inheritable Low mandatory label; a hard-linked payload would export that label onto the shared file object, and every later `niu.exe` image would run at Low integrity — full access included, where an unconfined shell must be able to write a Medium directory.
- 位于工作区之下的执行根改为复制克隆而不是硬链接：宿主沙箱会给工作区树打上可继承的 Low 强制标签，硬链接会把该标签带到共享文件对象上，之后每次 `niu.exe` 镜像都会以 Low 完整性运行——包括 full access，而不受限的 shell 本应能写 Medium 目录。

- Every merge gate is now a real gate. `validate-windows`, `validate-macos-intel` and `tools-trial` lost `continue-on-error` and joined `CI required`'s `needs` and failure loop; the bench smoke moved to `benchmark-gates.yml` (dispatch + monthly schedule) so `ci.yml` has no non-blocking job; `node-floor` runs on Linux and Windows; a new `rust-lint` job gates `cargo fmt --check` and `clippy -D warnings` on the pinned 1.97.1 toolchain (`native/rust-toolchain.toml`). `scripts/check-workflows.mjs` now states the blocking topology in one place (`EXPECTED_BLOCKING`) and fails when a job is unclassified, when `needs` disagrees, or when a failure-loop entry is missing; timeouts are tightened from measured p99.
- Publishing is immutable. The release `gate` refuses a tag that was force-moved away from the built commit, requires a successful `CI required` check on the tagged commit, runs the same `verify-gate.mjs` as CI (restoring the skip-is-not-a-pass assertions and running the Niubash payload suites instead of skipping them), and `publish` only appends missing assets — no `--clobber`. `v0.5.0`'s four tag moves and post-publication asset replacement are the accident this prevents. The ruleset template also carries a merge queue, applied by the idempotent `scripts/apply-ruleset.mjs`.
- 每个合并门禁都成为真正的门禁：`validate-windows`、`validate-macos-intel`、`tools-trial` 去掉 `continue-on-error` 并加入 `CI required` 的 `needs` 与失败判定循环；bench smoke 移到 `benchmark-gates.yml`（手动 + 每月调度），`ci.yml` 不再有非阻塞 job；`node-floor` 覆盖 Linux 与 Windows；新增 `rust-lint`，用 `native/rust-toolchain.toml` 钉住的 1.97.1 门禁 `cargo fmt --check` 与 `clippy -D warnings`。`scripts/check-workflows.mjs` 用 `EXPECTED_BLOCKING` 单一事实源校验“job 已分类 / needs 与循环一致”，并按实测 p99 收紧超时。
- 发布不可变：release `gate` 拒绝被 force-move 的 tag，要求 tag commit 的 `CI required` 为 success，并改用与 CI 相同的 `verify-gate.mjs`（恢复“skip 不是通过”的断言，Niubash 载荷套件真跑）；`publish` 只补缺失资产，不再 `--clobber`。规则集模板带上 merge queue，由幂等的 `scripts/apply-ruleset.mjs` 下发。

## [0.5.0] — 2026-11-06 — Stable release

- This stable release summarizes the user- and developer-facing changes since v0.4.0, including the 0.4.1-0.4.4 patch releases and the 0.5.0 previews. **Breaking:** the 0.5 series targets DSH 0.2.2-rc.1 and later 0.2.2 releases only; older hosts are no longer supported.
- 本正式版汇总自 v0.4.0 起（含 0.4.1-0.4.4 补丁版与 0.5.0 预览版）的用户与开发者相关变更。**破坏性变更**：0.5 系列仅面向 DSH 0.2.2-rc.1 起的 0.2.2 发行线，不再支持旧宿主。

- The built-in Minimal, Standard, PTC and Cordis presets now hide the host PowerShell by default, still only while their Bash replacement is callable, the global gate allows it and the dsh-win-pwsh7 link is off; saved explicit values, custom presets and the global veto are unchanged.
- 内置极简、标准、PTC 与创造预设默认隐藏宿主 PowerShell，但仍要求其 Bash 替代工具可调用、总闸允许且未开启 dsh-win-pwsh7 联动；已保存的显式值、自定义预设与总闸否决保持不变。

- Plugin detail pages now show a curated introduction through the locale meta.detail entry instead of the repository README.
- 插件详情页通过 locale 的 meta.detail 展示专门编写的介绍，不再直接使用仓库 README。

- Align the runtime settings surfaces with the shipped Niubash payload. The status card reports the executor the host actually resolves per mode (packaged payload, provisioned copy, explicit path, PATH or well-known install) instead of an install inventory, names each mode when they disagree, and no longer claims no Bash exists while the packaged payload is running. The install preview now names the pinned Niubash archive, its digest, and the DSH_HOME target it really writes, replacing the leftover Git for Windows facts.
- 设置页运行时卡片与随包 Niubash 对齐：状态按宿主对各模式的实际解析（随包载荷、托管副本、显式路径、PATH 或标准安装位置）报告执行器，模式之间不一致时逐项列出，不再在随包载荷可用时声称没有 Bash；安装预览改为真正会下载的固定 Niubash 归档、摘要与 DSH_HOME 目标，替代遗留的 Git for Windows 数据。

- Add a Bash executor card to the row page. It switches every mode between the packaged Niubash rung (removing `bashPath`) and one Git Bash/MSYS executable, offers the host's scanned installations, accepts a typed absolute path, and validates the choice through the host before the revision-checked save writes `bashPath`; the CLI exposes the same choice as `bash-runtime niubash` and `bash-runtime git --path`.
- 配置页新增 Bash 执行器卡片：在所有模式之间切换随包 Niubash（移除 `bashPath`）或一个 Git Bash/MSYS 可执行文件，列出宿主扫描到的安装、允许输入绝对路径，并在带版本校验的保存写入 `bashPath` 之前由宿主校验；CLI 以 `bash-runtime niubash` 与 `bash-runtime git --path` 暴露同一选择。

- 运行时状态卡片不再把随包载荷当作“未安装”：只有在 DSH_HOME 真的存在托管副本、或随包载荷缺失需要恢复时才显示该行；同时排除 Windows Store 的 `WindowsAppsash.exe`（WSL 别名），它不会被当作 Git Bash。
- The runtime card no longer treats the packaged payload as a missing installation: the managed-copy row appears only when one exists or when installing is the recovery, and the Windows Store `WindowsAppsash.exe` alias (WSL) is never offered as Git Bash.
- 插件详情页说明进入设置页的路径：向下翻页后点击“包含的组件”内的“dsh-ops>”进入设置界面。
- The plugin detail now names the navigation: scroll down, then open the settings page through “dsh-ops>” inside “Included components”.
- The Windows default shell is now the complete official Niubash v1.5.0 payload shipped inside the package: the archive, source tree and every per-call execution copy are verified, a missing payload never falls back implicitly to ambient Bash, and managed install, status, select and remove commands are provided.
- Windows 默认 Shell 改为随主包携带的完整官方 Niubash v1.5.0 载荷：逐条校验归档、源树与每次调用的执行副本，缺少载荷时不隐式回退到环境 Bash，并提供托管安装、状态、选择与卸载命令。

## [Unreleased]

- Run `prepack` through `bin/prepack.mjs`: a checkout still builds and checks the payload, while packing an installed package without the repository `scripts/` directory no longer fails with `MODULE_NOT_FOUND`.
- `prepack` 改由 `bin/prepack.mjs` 执行：仓库检出仍会构建并校验载荷，而从已安装包（没有仓库 `scripts/`）重新打包不再以 `MODULE_NOT_FOUND` 失败。

- Add the read-only `dsh-ops disk status [--json]` report: an ownership registry for every disk family the plugin writes (R1–R13), a bounded measurement that never follows links, per-category default actions, reclaim evidence with blocked reasons, and a validated `disk.status`/`disk.retention` config skeleton (the retention keys are a contract only; this release deletes nothing).
- 新增只读的 `dsh-ops disk status [--json]`：为插件写入的每个磁盘家族（R1–R13）建立归属清单，提供不跟随链接的有界测量、按类别的默认动作、带阻塞原因的回收证据，以及经校验的 `disk.status`/`disk.retention` 配置骨架（retention 键只是契约，本版不删除任何内容）。

- Keep zero-byte ERROR_MORE_DATA completions incomplete instead of treating them as end-of-data.
- ERROR_MORE_DATA 零字节完成保留不完整状态，不再误报数据结束。

- Record deferred result-cache cleanup for a root before its first caller can use it, retry it with bounded exponential backoff when workspace-write authority returns or at the next start-up, and reclaim idle roots that no session references. The native purge deliberately keeps the root, its scope directory and the lock; the new host-side sweep reclaims empty and lock-only roots by default, validates the whole directory structure before deleting a name, skips and reports any root with an unknown entry, excludes this process's live roots, and reports aggregate root/byte budget violations as blocked roots without ever deleting a root that still holds snapshot data. A session whose cache root was removed externally now recreates it instead of failing. `dsh-ops result-cache status|reclaim [--apply]` exposes the same bounded pass (#721).
- 在首个调用可使用结果缓存根之前登记该根的延迟清理；恢复 workspace-write 授权或下次启动时按有界指数退避重试，并回收已无会话引用的空闲根。native purge 有意保留根目录、作用域目录与锁，新的宿主侧清扫默认回收空根与只剩 lock 的根，删除任何名字前校验完整目录结构，遇未知条目整根跳过并报告，排除本进程活跃根，并把聚合根数/字节预算超限的根标为 blocked，永不删除仍含快照数据的根。缓存根被外部删除后，会话会重建它而不是报错。`dsh-ops result-cache status|reclaim [--apply]` 暴露同一次有界清扫（#721）。
- Clone each Windows Niubash execution tree by hardlink, seal the shared payload inodes read-only for the duration of the command, and verify the clone stat-only before spawn. The execution receipt records the clone mode, the copy-fallback cause when hardlinks are refused, the source manifest digest and the seal level; `DSH_OPS_EXEC_ROOT` moves the execution root parent (physically resolved against the payload) and `NIUBASH_VERIFY=deep` restores the full per-call re-hash.
- 每调用的 Windows Niubash 执行树改为硬链接克隆，命令运行期间把共享载荷 inode 封印为只读，spawn 前只做 stat 校验。执行收据记录克隆模式、硬链接被拒时的复制回退原因、源清单摘要与封印级别；`DSH_OPS_EXEC_ROOT` 移动执行根父目录（按载荷做物理路径解析），`NIUBASH_VERIFY=deep` 恢复每调用全量重哈希。
- Preserve PTC paging of session-owned legacy snapshots and batch audits through the shared result adapter, while Native still accepts only ref:// references. Refuse result storage when the active PTC parent's presentation changes or its inspection fails before cache IO. Await shared publication readiness and roll back permanent delayed initialization failures.
- 共享 result 适配器保留 PTC 对会话自有旧快照与 batch 审计的分页，Native 仍仅接受 ref:// 引用；活动 PTC 父调用的展示变化或检查失败时，在缓存 IO 前拒绝存储。等待共享发布就绪，并回滚延迟初始化的永久失败。

- Share a bounded registry-refusal cooldown across publication rows, retaining refused withdrawals and recovering owed registrations without another session event. Include accepted PTC dispatch settlements in TUI attention badges.
- 各发布行共享有界注册拒绝冷却，保留被拒绝的撤销操作，并在没有新会话事件时恢复待发布项；TUI 提醒徽章计入已接受的 PTC 分派结算。

- Roll back rejected discovery attachments without leaving registrations or selection observers, observe background failures, and verify settings persistence with Cordis 4.1.0. Render PTC guidance only after the public presentation waterfall confirms PTC; Native prompt text and wire declarations remain unchanged when PTC is enabled.
- discovery 挂载失败时回滚注册与选择观察器，接住后台失败，并验证 Cordis 4.1.0 设置持久化；仅在公开展示 waterfall 确认 PTC 后生成专属引导，启用 PTC 不改变 Native 提示词与 wire 声明。

- Restore the previous scoped PTC SDK after overlapping rows unload; stop superseded asynchronous attachments before publishing through disposed contexts. Conditional official replacements may remain model-visible: dispatch is guarded only by same-step OPS admission and current consumer authority, so an unavailable counterpart cannot disable both tools.
- 重叠行卸载后恢复原作用域 PTC SDK；异步挂载被取代后停止发布，避免使用已释放上下文。条件性原版替换可能仍对模型可见；仅同一步骤准入 OPS 对应项且消费者当前有权限时守卫分派，避免对应项不可用时两边同时禁用。

- Unify Native/discovery/PTC file and result publication with typed Outcome values and separate compact Native rendering; preserve fresh-read evidence, CAS and authority. Result uses one put/page/release schema, rejects Native put before IO, and defaults root to live cwd in both projections. Real source/grant changes conservatively invalidate all old steps sharing that registration; resolve again, never automatically replay.
- Native/发现/PTC 文件与 result 统一发布，执行值为类型化 Outcome，Native 文本独立紧凑渲染，保留新鲜读取证据、CAS 与权威检查。result 统一 put/page/release schema，Native put 在 IO 前拒绝，两投影 root 均默认实时 cwd；真实来源/grant 变化保守使共享注册旧步全部失效，须重新 resolve，禁止自动重放。

- Make the 0.5 series native to DSH 0.2.2-rc.1 and later 0.2.2 releases, dropping older hosts while retaining the DSH adapter. Use stable conditional discovery/PTC definitions, captured step admission for replacement guards, required live working directories and complete writable-root authority checks.
- 0.5 系列原生面向 DSH 0.2.2-rc.1 起的 0.2.2 发行线，停止支持旧宿主但保留 DSH adapter；发现/PTC 使用稳定条件注册，替换 guard 使用本步准入集，必须提供实时工作目录，并完整复核额外可写根权限。

- Accept package-manager hardlinks only in rehashed Niubash source payloads while requiring exclusive execution copies; cover a real offline pnpm hardlink consumer and keep gate orchestration fixtures independent of a host Git Bash installation.
- Niubash 源载荷逐字节校验后兼容包管理器硬链接，执行副本仍要求独占文件；增加真实离线 pnpm 硬链接消费者验证，并让门禁编排测试不依赖宿主 Git Bash 安装。

- Repin the rebuilt official Niubash 1.5.0 Windows x64 archive after checking its GitHub asset digest, published SHA256SUMS and complete member inventory; keep strict archive and per-file validation.
- 核对 GitHub 资产摘要、官方 SHA256SUMS 与完整成员清单后，重新固定官方重建的 Niubash 1.5.0 Windows x64 归档；保留严格归档与逐文件校验。

- Document binary locations and ownership for npm/marketplace/CLI updates, fixed-directory replacement, disposable execution copies, explicit legacy cleanup and shared-store limits; do not add unsafe automatic uninstall hooks.
- 说明 npm/市场/CLI 更新的二进制位置与归属、固定目录替换、临时执行副本、显式旧载荷清理和共享缓存边界；不添加不安全的自动卸载钩子。

- Preserve preparation-time Bash runtime and authority error codes separately from spawn diagnostics; recheck the absolute monotonic deadline before spawning even when synchronous legacy MSYS preparation blocks its timer. Preparation can still exceed the budget, but an expired call never starts a command.
- 保留 Bash 准备阶段的运行时与权限错误码，与实际 spawn 诊断分开；即使同步 legacy MSYS 准备阻塞计时器，也在 spawn 前复核单调时钟绝对 deadline。准备本身仍可能超出预算，但已超时调用不会启动命令。

- Embed the complete frozen official Niubash v1.5.0 Windows x64 payload as the default shell backend; verify source and per-call execution trees, include preparation in cancellation/deadlines, preserve results on cleanup failure, and integrate managed install/status/select/removal. Missing payloads never switch implicitly to ambient Bash; explicit Git Bash and POSIX system Bash remain supported. This full-package-first choice does not rule out rubash-only later.
- Windows x64 默认 Shell 改为固定官方 Niubash v1.5.0 完整载荷；校验源树及每调用执行树，准备阶段纳入取消/超时，清理失败不覆盖结果，并接通托管安装/状态/选择/卸载。缺载荷不隐式切换环境 Bash，保留显式 Git Bash 与 POSIX 系统 Bash。这是先完整包的阶段选择，不否定后续 rubash-only。
- Stop attempting an inherited-tool restriction for a Bash this consumer published into the Agent's own layer, which `restrict()` never masks: a preset that does not own the publication no longer reports `inherited bash restriction failed: tools.restrict() names unknown global tool "ops_bash"` on every reconcile (#652).
- 不再对注册在 Agent 自有层的 Bash 尝试继承工具限制（`restrict()` 本就不遮蔽自有层注册）：不持有该发布的 preset 不再在每一轮 reconcile 重复报告 `inherited bash restriction failed: tools.restrict() names unknown global tool "ops_bash"`（#652）。
- Keep `turn` on projected `tool/call` and `tool/result` records. A step number restarts at 1 in every turn, so a log row that carried only `step` could not be attributed to the turn it happened in (#644).
- 投影后的 `tool/call` 与 `tool/result` 记录保留 `turn`。step 编号在每个 turn 都从 1 重来，只带 `step` 的日志行无法归到它实际发生的那个 turn（#644）。

- Stop refusing a replaced official tool on behalf of a request that never carried its replacement: the guard now answers for the tool surface that request was assembled with instead of the registry's current view, so a replacement that landed after the request was captured is no longer enforced against the call the model can actually make (#578).
- 不再因某次请求从未携带替换而拒绝被替换的官方工具：替换守卫改为按该请求组装时的工具面判定，而不是注册表当前视图；在请求快照之后才落地的替换，不再被用来拒绝模型实际能发出的那次调用（#578）。
- Accept a Windows workspace that already grants the host's effective WRITE_OWNER prerequisite even when another account (for example BUILTIN\Administrators) owns it, require ownership only when preparation must add that ACE, and report an owner mismatch separately from a missing WRITE_OWNER (#651).
- Windows 工作区若已具备宿主所需的有效 WRITE_OWNER，即使所有者是 `BUILTIN\Administrators` 等其它账户也直接使用；只有确实需要补该 ACE 时才要求所有者是当前用户，并把「所有者不匹配」与「缺少 WRITE_OWNER」分开报告（#651）。

- Give an Electron self-runner Node mode instead of refusing every confined Bash call: a confined Windows sandbox runs the Desktop executable itself as the Node runner, so `ops_bash` could answer every command in `read-only` and `workspace-write` with `EXECUTOR_UNAVAILABLE`. Only a self-runner (a prepared argv whose first element is the Desktop executable) gains `ELECTRON_RUN_AS_NODE=1`; sandbox, policy and command are unchanged (#574).
- 让 Electron 自跑 runner 进入 Node 模式，而不是拒绝所有受限档位的 Bash 调用：Windows 受限沙箱会把 Desktop 可执行文件自身当作 Node runner，导致 `read-only` 与 `workspace-write` 下 `ops_bash` 对任何命令都回答 `EXECUTOR_UNAVAILABLE`。现在只有自跑 runner（准备阶段 argv 的第一个元素即 Desktop 可执行文件）会补上 `ELECTRON_RUN_AS_NODE=1`，沙箱、策略与命令本身不变（#574）。
- Give the discovery routing sentence an evaluable document condition — a `.pdf`, `.docx`, `.csv` or `.tsv` file whose reader is absent from the tool table — and state that creating, editing, rendering or exporting Office documents belongs to the host office skill, with a failed document read falling back to that skill instead of retrying the reader. Formats are named, never unpublished tool names; adds 279 characters (64 cl100k_base tokens) to the discovery-enabled prompt and changes no tool schema, so the pinned schema budgets stay valid.
- 发现路由句改为可判定的文档条件：读取器不在工具表中的 `.pdf`、`.docx`、`.csv` 或 `.tsv` 文件；并写明创建、编辑、渲染或导出 Office 文档归宿主 office 技能，读取失败时回退到该技能而不是重试读取器。只写格式、不写未发布的工具名；发现开启时提示词增加 279 字符（64 个 cl100k_base token），工具 schema 未变，已固定的 schema 预算仍然有效。
- Preserve trailing backslashes in install specs delegated through Windows cmd launchers without relaxing injection refusal. / Windows cmd 启动器委派安装参数时保留末尾反斜杠，且不放宽注入拒绝。

- Key the hidden-surface snapshot by view identity instead of projecting every schema, so the replacement guard and the assemble waterfall stop deep-copying the whole catalog on every pass; the optional scope now reaches the same cheap path and a scope-less read describes the global layer.
- 隐藏面快照改用视图条目身份作键，不再为每个定义投影 schema；替换守卫与装配瀑布因此不再每次检查都深拷贝整个工具目录，可选作用域走同一条低价路径，无作用域读取描述全局层。
- Read the discovery guidance's callable set from the view instead of `schemas()`, removing one schema projection per prompt assembly.
- 渐进披露指引的可调用集合改从视图读取，不再每条提示词装配投影一次 `schemas()`。
- Read a scope's surface without throwing when the host publishes no projection: both readers answer empty, so a dispatch path never turns a missing `schemas()` into an exception.
- 宿主不发布投影时，作用域表面读取不再抛错：两个读者都返回空，派发路径不会把缺失的 `schemas()` 变成异常。
- Keep a forged entry out of the surface key: the projection fallback pairs each name with the description it already holds, so both separator characters are escaped before they enter the key, and a description that is not a string cannot throw on a dispatch path.
- 防止表面键被伪造条目：投影兜底把每个名字与它已有的描述并列，因此两个分隔符在进入键之前先转义，非字符串的描述也不会在派发路径上抛错。
- Read a scope's visible names from the entries its view publishes, not only from `keys()`: a view that offers entries without keys now reports its names, so the replacement planner stops treating every selected counterpart as absent there.
- 作用域的可见名字改从视图条目读取，不再只认 `keys()`：只发布条目、不发布键的视图现在也能报出名字，替换计划不再把每个已选对应项当成缺失。
- Refuse an install spec the Windows launcher line cannot carry: the profile installer quotes every argument it hands to `cmd.exe /s /c` and rejects the cmd metacharacters a `.cmd` expands again, so an `&` or `|` in `DSH_OPS_INSTALL_SPEC` can no longer become a second command. A `--dry-run` preview refuses the same input as the real run instead of reporting success.
- 拒绝 Windows 启动器行承载不了的 install spec：配置档安装器给交给 `cmd.exe /s /c` 的每个参数加引号，并拒绝会被 `.cmd` 再次展开的 cmd 元字符，`DSH_OPS_INSTALL_SPEC` 里的 `&` 或 `|` 不再能变成第二条命令。`--dry-run` 预览与真跑拒绝同一批输入，不再报告成功。
- Enforce zero-entry MFT result budgets before appending and report exact-fit results as complete.
- MFT 结果预算在追加前检查，零预算不返回条目，恰好容纳的结果不再误报截断。
- Preserve exact-head fork PR CI evidence with empty Actions associations, including approval-required runs, and report GitHub mergeability with its base identity separately from local merge probes (#495).
- 保留 Actions 关联为空的 fork PR 准确 head CI 证据（含待批准运行），并将 GitHub 可合并性及其基线身份与本地合并预演分开报告（#495）。
- Report PowerShell ConstrainedLanguage before workspace ACL preparation and preserve a named diagnostic without changing security policy (#458). / 工作区 ACL 准备前明确报告 PowerShell ConstrainedLanguage，并保留具名诊断，不改变安全策略（#458）。

- Classify a confined Windows Bash preparation failure by the stage that failed (`bash-staging-failed`, `bash-generation-quarantine-failed`, `bash-lifecycle-lock-busy`, `bash-runtime-missing`, `bash-ipc-mismatch`), keep the actionable reason, and stop answering a recoverable staging interruption with the blanket "Do not retry" paragraph (#512).
- 按失败阶段对 Windows 受限 Bash 准备失败分类（`bash-staging-failed`、`bash-generation-quarantine-failed`、`bash-lifecycle-lock-busy`、`bash-runtime-missing`、`bash-ipc-mismatch`），保留可操作原因，不再用"不要重试"的笼统文案回答本可恢复的 staging 中断（#512）。
- Reclaim interrupted `stage-*` copies in the private Bash runtime cache after one hour, count them in the reported reclaimable bytes, and remove them together with a confirmed `bash-runtime clean-cache` (#512).
- 一小时后回收私有 Bash 运行时缓存中被中断的 `stage-*` 副本，计入可回收字节，并在确认后的 `bash-runtime clean-cache` 中一并清除（#512）。
- Document how to diagnose and recover an interrupted restricted-Bash staging or lifecycle lock.
- 文档补充受限 Bash staging 中断与生命周期锁的诊断与恢复方法。
- Document how to identify the failing dependency in `ERR_PNPM_UNKNOWN` / `UNKNOWN: unknown error, open '<path>'` reports without inferring an unverified filesystem or security-software cause, and state that the
  `git+https`/source channel cannot produce a loadable plugin because `lib/` and the staged
  `runtime/` are not in Git. The manifest gate now fails if `package.json` declares any
  install-time lifecycle hook — `prepare`, `preprepare`, `postprepare`, `install`, `preinstall`
  or `postinstall` — and names the gate's rule truthfully, so "fix the Git channel with `prepare`"
  cannot land silently (#524).
- 说明如何从 `ERR_PNPM_UNKNOWN` / `UNKNOWN: unknown error, open '<path>'` 报告确定失败依赖，而不推断未经验证的文件系统或安全软件根因；同时明确直接 `git+https`/未构建源码通道无法提供完整发行物，因为
  `lib/` 与已 stage 的 `runtime/` 不在 Git 里。清单门禁现在会在 `package.json` 声明任何
  安装期生命周期钩子时失败——`prepare`、`preprepare`、`postprepare`、`install`、
  `preinstall`、`postinstall`——并按实际行为描述该规则，使「用 prepare 修 Git 通道」
  无法静默落地（#524）。
- Preserve completed, failed and pending per-file receipts when multi-file replacement stops after a publication failure; retain uncertain effects and never offer a write replay cursor. Clarify the required literal `expectedRevision: "absent"`, document read/edit/write/replace contracts, and verify same-call PTC read-to-edit CAS and stale reads (#419, #421, #422).
- 多文件替换在发布失败后保留已完成、失败和待处理文件的回执，保留未知副作用且不提供重放写入游标。明确必填字面量 `expectedRevision: "absent"`，补充读取、编辑、写入、替换契约，并用真实 PTC 同轮读改与过期读取回归验证 CAS（#419、#421、#422）。

- Keep one build serving both ends of the supported range. The whole suite now passes on the locked `0.2.0-rc.2` graph and on the `0.2.1-rc.5` graph over the same source, and the compatibility assertion names rc.5 alongside the earlier ones. The precheck case that needed the removed `both` mode now pins the seam instead: a registry mode the precheck cannot answer from the scope chain still owes a probe.
- 同一份构建同时服务受支持范围的两端：整套测试在锁定的 `0.2.0-rc.2` 依赖图与 `0.2.1-rc.5` 依赖图上分别全绿，兼容性断言也把 rc.5 与更早版本并列。原先需要已删除的 `both` 模式的预检用例改为锁住接缝：作用域链解析不出的注册表模式仍要付一次探针。
- Track the official 0.2.1-rc.5 line: `@deepseek-ai/dsh-*` moves to `0.2.1-rc.5` and Cordis to `4.0.5`. `ToolPresentationMode` no longer carries `both`, so every presentation list, loader description and doc sentence names only `native` and `ptc`; `ConfigFormSnapshot` no longer carries `mode`, so a Client form is editable when it is ready and writable; and `run_code` now asks the host for the directory it executes in, which the test hosts provide only where a suite really runs code. Test fixtures follow rc.5 as well: `invoke` names its `PeerScope`, a user message carries its `source`, and the gateway client is resolved through its condition exports.
- 跟进官方 0.2.1-rc.5 线：`@deepseek-ai/dsh-*` 升到 `0.2.1-rc.5`，Cordis 升到 `4.0.5`。`ToolPresentationMode` 不再有 `both`，因此所有展示模式清单、加载器描述与文档句子只写 `native` 与 `ptc`；`ConfigFormSnapshot` 不再有 `mode`，Client 表单改为「就绪且可写即可编辑」；`run_code` 现在会向宿主索取执行目录，测试宿主只在真正运行代码的套件里提供。测试夹具同样跟进 rc.5：`invoke` 必须指明 `PeerScope`，用户消息必须携带 `source`，gateway 客户端按其条件导出解析。
- Retire the last `both` traces rc.5 invalidated: the presentation-mismatch diagnostic no longer offers a mode that does not exist, the docs name only `native` and `ptc`, test scopes request a real presentation instead of the removed one, and the discovery-incremental case that needed a mixed scope retires with it. A ready Host document that refuses writes is now asserted to stay uneditable.
- 清理 rc.5 使 `both` 失效后残留的痕迹：展示不匹配诊断不再建议一个已不存在的模式，文档只写 `native` 与 `ptc`，测试作用域改为申请真实存在的展示模式，需要混合模式的 discovery-incremental 用例随该模式一起退役；并补上「就绪但拒绝写入的宿主文档不可编辑」的断言。

- Bound an unattributed `tools/change` to one representative probe: the registry notification may name the affected scope, and when the host names none only one session is re-probed synchronously while the rest stay stale until their next `agent/pre-step` or tool execution, both of which check freshly regardless of cached state. `system-prompt/change` takes the same lazy path, a scope the host names but no session knows falls back to the conservative path, and the representative probe no longer cascades into its own scope family. This removes the one-full-assembly-per-live-session cost that made session creation scale with the live count (198 live sessions: 23,143ms and 1,393 assemblies before, 7,097ms and 400 after with only the discovery path bounded; zero live sessions are unchanged at 103-129ms).
- 未点名作用域的 `tools/change` 收敛为只同步重探一个代表会话：宿主点名时只失效该作用域及其后代；未点名时其余条目保持过期，在各自下一个 `agent/pre-step` 或工具执行时重新观测——这两处无论缓存状态如何都会做新鲜检查。`system-prompt/change` 走同一条惰性路径；宿主点名但无任何会话认识的作用域改走保守路径；代表会话的探测不再连带重探它自己的作用域族。这去掉了「每个存活会话一次完整装配」的成本（198 存活会话：修复前 23,143ms / 1,393 次装配，仅收敛 discovery 路径后 7,097ms / 400 次；零存活会话时两者一致，103-129ms）。
- Reduce the first Native-to-PTC switch from seven prompt assemblies to four in the 150-tool host fixture. Keep full host presentation probes and their Native withdrawal, but do not rebuild a private probe after withdrawal; rebuild a public assembly only when its PTC publication generation is stale, so next-step SDK declarations still arrive exactly at request two (#490).
- 在 150 工具宿主夹具中，首次 Native→PTC 切换的提示词装配从 7 次降到 4 次。保留完整宿主展示探针及其 Native 撤回，但私有探针撤回后不再重建；公共装配仅在 PTC 发布代次过期时重建，下一请求的 SDK 声明仍恰好在第二次请求出现（#490）。
- Stop spending a presentation probe per session on an unattributed `tools/change`. A registration the host reports without naming a scope cannot move a presentation mode — only `presentAs` does — so the publish still runs, but the verdict is deferred and the next real probe confirms it at pre-step. A `system-prompt/change` since the last re-derivation is the evidence that a mode may have flipped, and only then does the next change owe that probe.
- 未点名作用域的 `tools/change` 不再逐会话花一次展示探针。宿主报告但没有点名作用域的注册不可能移动展示模式——只有 `presentAs` 会——所以发布照常进行，但判定被延后，由下一次真实探针在 pre-step 确认。自上次重推导以来出现过 `system-prompt/change` 才是「模式可能已翻转」的证据，只有那时下一次变化才欠这次探针。
- Answer a probe whose scope resolves to a non-`ptc` registry mode from the scope chain instead of assembling: `modeFor` is the same source the collapsed section reads, so an assembly for such a scope can only return the verdict already held. A mixed-native deployment still probes, because only `ptc` renders the collapsed section.
- 作用域链解析出的注册表模式不是 `ptc` 时，直接由链上答案回答而不装配：`modeFor` 正是折叠段落读取的同一来源，对它做装配只能得到已经持有的判定。混合 Native 部署仍照常探测，因为只有 `ptc` 会渲染折叠段落。
- Scan a scope's Native providers against one registry view: the scan asked the registry once per provider whether that scope resolves the provider's own definition, and `tools.get(name, scope)` rebuilds the entire scope view on every call, so a publish that touches every live scope rebuilt the view once per provider per scope — 82,365 rebuilds for one unattributed `tools/change` over 198 live sessions. Reading the view once and looking the names up in the map it returns removes that whole factor: one unattributed change over 198 sessions drops from 3,970 assemblies' worth of rebuilds and 8,580ms to 1 assembly and 218ms, and `create-ptc` from 1,194 to 6.5 assemblies. A host that serves no view still resolves through `get()`, as `surfaceOf` already does.
- 作用域的 Native provider 扫描改为只读一次注册表视图：原先对每个 provider 都要问一次该作用域是否解析到它自己那份定义，而 `tools.get(name, scope)` 每次调用都会重建整个作用域视图，于是「一次触及所有存活作用域的发布」的重建次数是「provider 数 × 作用域数」——198 个存活会话上的单次未点名 `tools/change` 就重建了 82,365 次。改为读一次视图、在它返回的 Map 里逐个查名，整个因子消失：198 会话上单次未点名变化从相当于 3,970 次装配的重建量、8,580ms 降到 1 次装配、218ms，`create-ptc` 从 1,194 次装配降到 6.5 次。宿主不提供视图时仍走 `get()` 解析，与 `surfaceOf` 的既有做法一致。
- Reject an unadapted Electron self-runner before it can report empty Bash success; preserve legitimate empty output and explicitly prepared host runners (#484).
- 在未适配的 Electron 自身 runner 启动前拒绝执行，避免 Bash 空输出假成功；保留合法空输出与宿主显式准备的 runner（#484）。
- Name Windows `STATUS_DLL_INIT_FAILED` exit values without claiming that commands had no effects or that the host startup failure was repaired (#417).
- 为 Windows `STATUS_DLL_INIT_FAILED` 退出值提供明确诊断，不将命令效果误报为无，也不宣称宿主启动失败已修复（#417）。
- Stop optional Windows result caching from invoking workspace ACL preparation or confinement in full-access sessions on legacy hosts. Cache-only hosts retain spill, paging and cleanup; legacy hosts return explicit bounded output when storage is unavailable (#411).
- 修复旧版 Windows 宿主的完全访问会话仅为可选结果缓存而准备工作区 ACL 或请求沙箱的问题。支持专用缓存准备的宿主仍可溢出、分页和清理；旧宿主缓存不可用时返回明确有界的结果（#411）。

- Transfer the owned Bash registration when an agent changes preset, before the new consumer publishes. PTC-to-Standard/Minimal switches no longer lose `ops_bash` to a same-layer registration collision; the retired consumer cannot remove its successor or execute a retained callback. Foreign same-name providers remain untouched.
- 切换预设时，在新消费者发布前交接所属 Bash 注册。PTC 切到 Standard/Minimal 不再因同层同名冲突丢失 `ops_bash`；已退役消费者不能移除接任者或继续执行保留的回调，也不会撤销其它插件的同名工具。
- Let Windows compute and verify ordinary parent DACL inheritance for create-only files after private staging is complete, preserving inherited denies and creator-owner rules so restricted workspace processes can edit, rename and remove newly written files. Existing overwrite/copy and private-cache ACL contracts remain separate (#420).
- 仅新建文件完成私有暂存后，由 Windows 计算并验证普通父目录 DACL 继承，保留继承拒绝与创建者规则，使受限工作区进程可编辑、重命名和删除新文件；覆盖、复制与私有缓存的 ACL 契约保持独立（#420）。
- Overlap at most two bounded native reads inside `ops_read_files`, retaining request order, duplicate ranges, full revisions, per-file errors, credential/no-follow checks and ordered aggregate capture. Single-file reads avoid thread setup; the worker deadline remains authoritative (#477).
- `ops_read_files` 内部最多重叠两个有界原生读取，保留输入顺序、重复范围、完整 revision、逐文件错误、凭证/no-follow 检查和有序总预算捕获；单文件不启动线程，仍以 worker 截止为准（#477）。
- Record the evidence and go/no-go decisions for revision/anchor editing, symbol maps, and review tooling; retain current production contracts while defining the conditions for reconsideration (#424, #459, #534).
- 记录 revision/anchor 编辑、符号地图与审阅工具的证据和推进决策；保留现有生产契约并明确重新评估条件（#424、#459、#534）。
- Prepare search glob segments once per request and add opt-in, content-free worker stage timing with a same-corpus comparison runner; retain security checks, scan budgets and completeness semantics (#474).
- 搜索 glob 路径段改为每请求准备一次，增加不含正文的可选 worker 阶段计时及同语料对比 runner；保留安全检查、扫描预算与完整性语义（#474）。
- Accept npm 12 package-keyed pack reports alongside earlier arrays through one strict release/source-closure parser, preserving post-repair tar hashes and provenance (#560).
- 发布打包与源码闭包检查共用严格解析器，同时支持 npm 12 按包名组织的打包报告与此前数组格式，保留 tar 修复后的摘要和 provenance 校验（#560）。
- Add an opt-in WSL readonly file route for same-distribution UNC workspaces, preserving Windows credential/path restrictions, backend-bound search cursors and Windows-owned result storage; see [WSL file reads](wsl-readonly.md) (#498).
- 为同发行版 UNC 工作目录增加可选 WSL 只读文件路由，保留 Windows 凭据和路径限制、后端绑定搜索游标及 Windows 结果存储所有权；见 [WSL 只读文件操作](WSL只读文件操作.md)（#498）。
- Verify WSL fallback against the original Windows bounded result when a legacy host has no cache-only capability; keep reference paging mandatory when that capability exists (#411, #498).
- 旧宿主缺少仅缓存准备能力时，将 WSL 回退结果与原 Windows 有界结果对比；宿主提供该能力时，仍必须验证引用分页（#411、#498）。

- Complete the manifest namespace inventory with PTC batch/SDK-loading and Native discovery controls; validate exact capability coverage without changing scoped publication or model schemas (#484).
- 补齐清单命名空间中的 PTC batch/SDK 加载与 Native 发现控制入口，并校验能力目录完整性；不改变作用域发布或模型 schema（#484）。
- Keep Native file routing separate from the independent Bash prompt section, so resident Native + Shell consumers do not repeat Bash guidance or advertise host PowerShell routing. Keep deployment guidance single-owned across Bash, Native and discovery sections, including withdrawal and reload.
- 将 Native 文件路由提示与独立 Bash 提示段分开，避免 Native + Shell 常驻消费者重复 Bash 指导或把 Bash 宣传为宿主 PowerShell 路由。部署指导在 Bash、Native 与发现提示段之间仅保留一份，并覆盖撤回与重载。
- Update preset hints and rendered settings UI to describe default Bash/PowerShell coexistence; hiding host PowerShell remains an explicit choice.
- 更新预设提示和渲染后的设置界面，说明 Bash 与 PowerShell 默认共存；隐藏宿主 PowerShell 仍需显式选择。
- Document the limits of Windows payload checks and read-only evidence for Low-integrity images, mixed MSYS startup, antivirus correlation, heredoc and approval reports; do not present missing reproductions as fixes (#446, #439, #425, #426).
- 补充 Windows 载荷检查边界，以及 Low 程序标签、混合 MSYS 启动、杀软相关性、heredoc 和审批反馈的只读取证；缺少复现不能标为已修复（#446、#439、#425、#426）。
- Clarify step-tail snapshot handoff: disposal withdraws pending contributions only before the batch returns from `agent/pre-step`; an already handed-off batch may still be admitted and logged, while replacements wait for a later nonempty batch.
- 明确步骤尾部快照交接：释放只会在 batch 从 `agent/pre-step` 返回前撤回等待中的贡献；已经交接的 batch 仍可能被接纳并写入日志，替代注册等待后续非空 batch。
- Add scoped job-wait guidance after a successful standalone long sleep, with zero added prompt bytes before the trigger, Native/PTC coverage and live consumer/prompt-policy withdrawal (#507).
- 成功完成独立长延时后，按作用域提示使用宿主 job 等待；触发前不增加提示词字节，覆盖 Native/PTC 并跟随消费者/提示策略撤回（#507）。
- Honor configured PTC `allowedTools` when resident APIs are disabled; only `result` remains an implicit selection exception, with the directory and loader sharing the same pool.
- 关闭常驻 API 时遵守 PTC 的 `allowedTools` 配置，仅保留 `result` 隐式选择例外，目录与加载器共用同一允许池。
- Build Windows Bash IPC proxies from non-ASCII checkout/tool/temp paths using ASCII batch instructions and Unicode environment values; reproducible linker metadata keeps identical sources byte-identical across checkout paths (#553).
- Windows Bash IPC 构建以 ASCII 批处理与 Unicode 环境变量支持非 ASCII 检出/工具/临时路径，并使用可复现链接元数据，使相同源码跨检出路径生成相同字节（#553）。
- Detect the `dsh-win-pwsh7` companion from the profile that installed this package, so the row's link also resolves in the host process, which gets no `DSH_PROFILE_DIR`; a save no longer freezes a detected link into an explicit value, while a flipped link is always written.
- 从安装本包的 profile 探测 `dsh-win-pwsh7` 联动，宿主进程没有 `DSH_PROFILE_DIR` 也能判定；保存其它开关不再把「跟随检测」写成显式值，而手动拨动联动开关一定落盘。
- Name the row setting instead of the removed Compatibility mode when an official tool has an OPS replacement.
- 官方工具被 OPS 替代时，拒绝信息改指行设置，不再提已删除的兼容模式。
- Stop the discovery refresh/reconcile feedback loop (#526). A tool or prompt
  registry change made while this plugin's own presentation probe is assembling
  is now attributed to that probe instead of being applied inline, and each
  external activation may spend at most one trailing reconciliation; a component
  that keeps mutating the registry during assembly gets a single warning and its
  change is dropped. One external `tools/change` now costs one reconcile (two
  with a one-off in-assembly change) instead of an unbounded boot-time storm.
- 修复 discovery 的 refresh/reconcile 自激回路（#526）。本插件自身展示探针装配期间发生的
  工具或 prompt 注册表变更，现在归属到该探针而不再内联应用；每次外部触发最多追加一次尾随
  收敛；在装配期间持续修改注册表的组件只告警一次，其变更被丢弃。一次外部 `tools/change`
  现在只产生一次收敛（装配内有一次性变更时为两次），不再是无界的启动期风暴。
- Bound a presentation withdrawal to one rebuild per request: `claimPresentationRebuild` in `src/publication/presentation.ts` lets the first hook that retires tools re-assemble, and every later hook in the same request keeps the assembly it already holds. Two hooks that each withdrew in one request used to re-assemble in turns, which is the spin behind an idle Host burning a core.
- 将展示撤回限制为每个请求最多重建一次：`src/publication/presentation.ts` 的 `claimPresentationRebuild` 只允许第一个撤回工具的发钩重建，同一请求中后续钩子保留已有装配。此前两个钩子在同一请求里交替重建，正是空闲宿主吃满单核的自旋。
- Stop the session shell hook from waiting on reconciles scheduled after its own assembly started, and let it answer an inspection instead of waiting for a publication an inspection cannot change.
- 会话 shell 钩子不再等待自身装配开始之后才排队的 reconcile；探测（inspection）不再等待它无法改变的发布。

- Add an opt-in download guard with operator-owned Bash/PowerShell alternatives, conservative literal-command detection and actual Native/PTC dispatch coverage. Unconfigured, ambiguous and streaming calls stay unchanged; replacements are never executed automatically (#506).
- 新增可选下载约束，由用户配置 Bash/PowerShell 替代下载命令，保守识别字面命令并覆盖真实 Native/PTC 派发。未配置、含歧义或流式输出的调用保持原状，绝不自动执行替代命令（#506）。
- Inspect Windows Bash image and ancestor integrity labels in `ladder`, warn about Low labels, and keep unreadable labels and runtime health distinct from static payload compatibility (#446).
- `ladder` 只读检查 Windows Bash 映像与祖先路径的完整性标签，告警 Low 标签，并区分不可读标签、运行时健康和静态载荷兼容性（#446）。
- Record every host subprocess spill path the plugin settles in `$DSH_HOME/ops-spill-ledger.jsonl` and reclaim only those ledger-owned files: a TTL window (default 30 days), an oldest-first total byte budget (default 256 MiB), at most 64 files per bounded pass, plus `bash-runtime spill-report [--json] [--sweep --yes]` and a one-line `bash-runtime status` summary. The provider's `dsh-subprocess-*` directories are never removed, unrecorded files and other providers' paths are never touched, and a failed unlink keeps its entry with `lastError` for the next pass (#720).
- 在结算点把宿主 subprocess 的每个 spill 路径登记到 `$DSH_HOME/ops-spill-ledger.jsonl`，并且只回收账本内的文件：TTL 窗口（默认 30 天）、最旧优先的总字节预算（默认 256 MiB）、单次有界 pass 最多 64 个文件，并提供 `bash-runtime spill-report [--json] [--sweep --yes]` 与 `bash-runtime status` 的一行摘要。永不删除宿主的 `dsh-subprocess-*` 目录，不触碰未登记文件与其它 provider 的路径，删除失败时保留条目与 `lastError` 供下一轮重试（#720）。

## [0.5.0-alpha3] — 2026-10-30 — Unstable development prerelease

- This unstable prerelease summarizes changes since v0.5.0-alpha2; use an isolated test environment.
- 本不稳定预发布版汇总自 v0.5.0-alpha2 以来的变更，建议仅在隔离测试环境使用。

- Assemble built-in and explicit preset consumers through one responsibility-based pipeline, with exact custom-preset Switch cards and independent residency, discovery, Bash, file replacement and host-shell hiding. Preserve saved intent under global gates and keep Native discovery independent of typed PTC loading.
- 内置与显式预设通过同一个按职责组织的流程装配；自定义预设提供精确身份的原生开关卡片，常驻、发现、Bash、文件替换和宿主 Shell 隐藏独立控制。总开关保留保存意图，Native 发现与类型化 PTC 加载独立。
- Cancel owned calls on consumer/Agent/preset/presentation/authority retirement, return no-effect cancellation before dispatch and retire external publication without indefinitely waiting for non-cooperative provider promises. Unfinished foreign effects remain unknown.
- 消费者、Agent、预设、展示或权限撤销时取消所属调用；派发前取消返回无效果结果，外部发布撤回不无限等待不协作的提供者 promise，未完成的外部副作用仍明确为未知。
- Document the single-row migration, responsibility boundaries and removed dangling Compatibility export; Native text and PTC typed projections retain separate contracts over shared worker execution.
- 更新单行迁移、职责边界和悬空兼容导出的移除说明；Native 文本与 PTC 类型化投影共享 worker 执行但保留不同契约。

- Preserve Unix worker executable modes in Windows-built release tarballs and reject invalid runtime TAR members before publishing checksum records.
- 修复 Windows 构建发布包丢失 Unix worker 执行位，并在生成校验记录前拒绝异常运行时 TAR 成员。

- Add the real-corpus `calls` comparison: host-dispatched official `grep`/`glob` versus OPS, or two OPS builds in one process, with a declared corpus shape, a content identity and coverage recorded per arm. Timings stay manual evidence and never gate CI.
- 新增真实语料 `calls` 对比：真实 host 派发的官方 `grep`/`glob` 对 OPS，或同进程内两套 OPS 构建；语料 shape、内容身份与覆盖率按臂记录。耗时仍为人工证据，不进入 CI 门禁。

## [0.5.0-alpha2] — 2026-10-30 — Unstable development prerelease

- This unstable development prerelease summarizes changes since v0.5.0-alpha1. Use an isolated development or test environment rather than replacing a stable installation.
- 本不稳定开发预发布版汇总自 v0.5.0-alpha1 以来的变更，仅建议在隔离开发测试环境中使用，不建议替换稳定安装。

### Improved

- Reconcile official-tool replacement incrementally: plan only the newly created Agent, narrow attributed tool changes to affected Agents and coalesce event bursts, avoiding tool-view scans across all open sessions on each session creation (#464).
- 增量协调原版工具替换：只规划新建 Agent，将有归属的工具变更限定到受影响 Agent，并合并突发事件，避免每次新建会话都扫描所有已开会话的工具视图（#464）。
- Safely reuse private Windows Bash IPC payload generations by executable content identity, protect active generations with durable leases and expose cache usage plus preview-first offline cleanup with explicit stopped-host confirmation (#492).
- 按可执行内容身份安全复用 Windows 私有 Bash IPC 载荷代次，以持久租约保护活动代次，并显示缓存占用、提供默认预览且需明确确认宿主已停止的离线清理（#492）。

### Fixed

- Follow the live session working directory for Native file paths, Bash workdirs and default Native result roots; retain workspace write-authority boundaries and explicit stored-reference roots, and report directory provenance (#475).
- Native 文件路径、Bash 工作目录与 Native 结果默认根目录跟随会话实时工作目录；保留工作区写权限边界与显式存储引用根目录，并报告目录来源（#475）。
- Read classic-xref PDFs whose outline items contain `/Prev`; continue rejecting incremental PDFs when `/Prev` or `/XRefStm` appears in the trailer (#432).
- 修复大纲条目含 `/Prev` 的传统交叉引用表 PDF 无法读取的问题；trailer 中含 `/Prev` 或 `/XRefStm` 的增量 PDF 仍被拒绝（#432）。
- Prepare and purge Windows result caches through the optional cache-only host capability without workspace grants when available; preserve the legacy path on older hosts (#465).
- 宿主提供可选的仅缓存准备能力时，通过该能力准备和清理 Windows 结果缓存，不授予工作区访问权限；旧宿主保留原有路径（#465）。
- Vendor the PTC SDK declaration generator so builds do not depend on the removed host `jsonSchemaToTs` export. This fixes build code generation only; it does not expand the declared host compatibility range or establish full DSH 0.2.2 support (#485).
- 内置 PTC SDK 声明生成器，使构建不再依赖宿主已移除的 `jsonSchemaToTs` 导出。此项仅修复构建代码生成，不扩大声明的宿主兼容范围，也不代表完整支持 DSH 0.2.2（#485）。

### Tests

- Add deterministic Windows replace refusal and sidecar-lock reader regressions from PR #128, with explicit cross-platform skips and an honest coverage map.
- 提取 PR #128 的 Windows replace 拒绝与 sidecar 锁读取确定性回归，准确接入跨平台 skip，并记录覆盖与未测范围。

- Ship the Linux x64 native worker as a `x86_64-unknown-linux-musl` static-pie binary so the artifact carries no `GLIBC_*` floor: the previous gnu build required `GLIBC_2.30`/`GLIBC_2.32` and failed on glibc 2.28 hosts. Add `dsh-ops build-ptc --target <rust-triple>` (staging from `native/target/<triple>/release`) and assert the static link in CI and release.
- Linux x64 原生 worker 改为 `x86_64-unknown-linux-musl` 静态链接（static-pie），发布产物不再带 `GLIBC_*` 下限：此前的 gnu 构建要求 `GLIBC_2.30`／`GLIBC_2.32`，在 glibc 2.28 主机上无法执行。新增 `dsh-ops build-ptc --target <rust-triple>`（从 `native/target/<triple>/release` 取产物），并在 CI 与发布流程中断言静态链接。

## [0.5.0-alpha1] — 2026-10-30 — Unstable development prerelease

- This is an unstable development prerelease relative to v0.4.4, intended for isolated testing rather than stable production use. The single-row configuration is a breaking migration: move saved legacy-row settings into `dsh-ops`; resident tools and dynamic loading are independent.
- 本版本为相对 v0.4.4 的不稳定开发预发布版，仅建议隔离测试，不建议稳定生产环境使用。单行配置属于破坏性迁移：旧行设置需迁入 `dsh-ops`；常驻工具与动态加载独立控制。

- Keep explicit preset integration mounts independent of retired Loader rows; migrate release scope and benchmark switches to the merged row, and retain component behavior checks through a mount-local test fixture.
- 显式预设集成挂载不再被旧 Loader 行退役防护误拦截；发布范围及 benchmark 开关迁移至单行配置，旧组件行为测试使用仅挂载期间有效的局部夹具。

- Separate resident OPS file tools from dynamic loading for Standard, PTC and Cordis; Minimal has no resident-tools option. Preserve on-demand baseline access when residency is off and connect the PTC discovery switch.
- 标准、PTC、创造模式新增独立的 OPS 常驻工具开关，与动态加载相邻；极简模式不提供常驻选项。关闭常驻时基础 API 仍可动态加载，并接通 PTC 动态开关。

- Verify the hide-official assembled surface through the scope view when the host withholds the tool array. DSH 0.2.1 transforms a `PromptPresentation` in `system-prompt/assemble` and attaches `tools` afterwards, so the guard's `Array.isArray(result?.tools)` threw `assembled tool schemas unavailable` for every scoped assembly once `replaceTools` was non-empty — every turn was blocked, not one tool. A host that still supplies schemas keeps the stricter assembled-surface assertion (#413).
- 宿主不再提供工具数组时，hide-official 改由作用域视图核验组装面。DSH 0.2.1 的 `system-prompt/assemble` 只变换 `PromptPresentation`，`tools` 在瀑布之后才追加，于是 `replaceTools` 非空时该校验的 `Array.isArray(result?.tools)` 对每个作用域都抛出 `assembled tool schemas unavailable`——整轮不可用，而非某个工具不可用。仍提供 schema 的宿主保留更严格的组装面断言（#413）。
- Add candidate-only benchmark component switches with conservative patch editing, composed-config verification and a bounded readiness turn. Archive effective switches, show them in reports, and reject comparisons across different candidate switch sets (#296).
- 为 benchmark 增加仅作用于 candidate 的组件开关，保守编辑补丁并核验合成配置及有时限的就绪 turn；归档实际开关、在报告中展示，并拒绝不同 candidate 开关集的混配（#296）。

### Changed — breaking

- The compatibility fallback component and its switch were removed: the four presets,
  the discovery entry, activity capture and the TUI link are the whole surface. A saved
  `compat` section is ignored by the resolver instead of failing startup.
- The bundle now inserts one Loader row named `dsh-ops` (like a single-plugin bundle):
  its browser half mounts on that row, and the Plugins page configures it from one page.
  Per the maintainer's decision that page keeps two bundle switches (hide the official
  tools, dynamic tool discovery) plus four switches per preset (enable the Bash tool,
  hide the host PowerShell, hide the official tools, dynamic tool discovery). The last
  two only apply while the matching bundle switch is on; the mode keeps its saved value
  and the control is disabled. Worker paths, PTC pools, routing text, capture limits and
  the credential fence stay YAML-only, so the page cannot grow into a second settings app.
- Saved patch entries for the old row ids (`dsh-ops-mode-*`, `dsh-ops-discovery`,
  `dsh-ops-compat`, `dsh-ops-panel`, `dsh-ops-tui`, and the older `shell`/`file`/`ptc`/
  `hide-official`/`background`) are tolerated but no longer authoritative: their modules
  log one warning and publish nothing. Move those settings into the single row.
- The optional client carrier (`dsh-ops/lib/profiles/client`) and the
  `dsh-ops settings-profile` command are removed: the single row mounts the browser half
  directly, so the migration is unnecessary and no profile is rewritten.
- 移除了兼容模式组件及其开关：四个预设、动态工具加载、数据采集与 TUI 联动构成全部配置面；已保存的
  `compat` 段会被忽略而不是导致启动失败。
- 现在 bundle 只插入一行 `dsh-ops`：浏览器半侧挂在这一行上，插件页用一个页面配置它。按维护者裁定，
  页面只保留两个总开关（隐藏原版工具、动态工具加载）加上每个预设的四个开关（开启 Bash 工具、
  隐藏宿主 PowerShell、隐藏原版工具、动态工具加载）；后两个仅在对应总开关开启时生效，模式保留
  已保存值、控件置灰。worker 路径、PTC 池、路由补充、采集上限与凭据围栏仍为 YAML-only，
  配置页不会长成第二个设置中心。
- 旧行 id 的已保存补丁条目仍被容忍但不再生效：对应模块记录一条警告并不发布任何东西，请把设置
  迁进这一行。可选承载 bundle 与 `dsh-ops settings-profile` 命令一并删除。

### Changed

- The Plugins page configures all seven rows that have keys (four mode rows, discovery, data
  capture, TUI link) from one schema-driven form: booleans use the host's native Switch, advanced
  keys fold by default, and only keys that actually changed are written with the revision the page
  read. A status section on shell rows and the bundle page reports only the host runtime snapshot and
  owns the install/remove/upgrade actions, which used to live inside the configuration form.
- 插件页面用同一套 schema 驱动的表单配置全部七个有键的行（四个模式行、发现、数据采集、TUI 联动）：
  布尔项使用宿主原生 Switch，高级键默认折叠，只写入真正改动的键并沿用页面读到的 revision。
  shell 行与组合包页面新增状态区，只报告宿主运行时快照；安装/删除/升级动作从配置表单移入该区。

### Fixed

- Resolve Native file paths, Bash workdirs and default result roots through the live DSH
  working-directory service after `working_directory` changes (#447). Keep workspace write
  authority and stored reference roots independent; show directory provenance in file/Bash output.
- The PTC row no longer offers Bash publication and an executor override, which its schema never
  accepted; the discovery page now exposes the worker override, "fail when the worker is missing"
  and the credential fence that already existed in its schema.
- PTC 行的页面不再显示它从未接受的 Bash 发布与执行器路径；发现页面补上了 schema 里已存在的
  worker 路径覆盖、「worker 缺失即失败」与凭据围栏。

### Fixed

- Prepare Windows result caches without granting workspace access when the host supports cache-only preparation; retain the legacy path on older hosts.
- 当宿主支持仅准备缓存时，Windows 结果缓存准备不再授予工作区访问权限；旧宿主继续使用原有路径。

- Withdraw PTC publication and cancel calls when a session leaves its selected preset; keep other
  sessions' discovery selections intact and authorize external calls only in their owned wrapper.
- Diagnose the selected discovery/shell services and scoped publication; clarify the host's
  ancestor-registration/restriction limit for nested unrelated preset integrations.
- 切换离开已接入预设时撤回 PTC 发布并取消调用；保留其他会话的发现选择，外部调用仅在自有包装内授权一次。
- 诊断所选发现/Shell 的服务与作用域发布，并说明无关预设嵌套时宿主继承祖先注册/限制的边界。
- Plan only the new Agent on `agent/created` instead of re-reading every live session's tool
  view, and reconcile the Agents a `tools/change` actually reached; coalesce the passes the host
  emits unattributed. Creating a session no longer costs O(open sessions) tool-view scans, which
  was the visible lag when starting one with many sessions open.
- 新建会话时只规划新 Agent，不再重读所有存活会话的工具视图；`tools/change` 只核对它实际触达的
  Agent，宿主未标注归属的变更合并为一次处理。新建会话不再随已开会话数线性扫描工具视图。

## [0.5.0] — 2026-10-27 — Preset-mode component roster

### Breaking changes

- Replace the seven-row component roster with eight rows: `dsh-ops/mode-minimal`,
  `dsh-ops/mode-standard`, `dsh-ops/mode-ptc` and `dsh-ops/mode-cordis` for the built-in
  presets, `dsh-ops/discovery` for dynamic tool loading, `dsh-ops/compat` for Compatibility
  mode, `dsh-ops/panel` for data inspection and `dsh-ops/tui` for TUI integration. The former
  `dsh-ops/shell`, `dsh-ops/file`, `dsh-ops/ptc` and `dsh-ops/hide-official` rows are gone
  from the bundle; their modules remain as unsupported legacy exports for old profiles.
- A mode row publishes OPS tools only for sessions composed from its preset. Standard and Cordis
  replace the official `read`, `glob` and `grep`; every enabled mode replaces the official
  Windows shell (`pwsh`/`pwsh_persistent` with `ops_bash` on Windows). A replaced tool is
  hidden only while its OPS counterpart is visible in the same scope.
- `dsh-ops/compat` inverts the removed per-tool `replaceTools` selection: enabling
  Compatibility mode keeps every official tool visible while OPS tools stay available, and lifts
  hiding without unloading any row. It is off by default; while it is on, token efficiency and
  model ability are reduced.
- Windows sessions route command execution through `ops_bash` instead of the official `pwsh`
  when a mode row is enabled and the OPS counterpart is visible.
- Restore the OPS icon on every component row.

### Upgrade

- Delete saved profile patch overrides for `dsh-ops-shell`, `dsh-ops-file`, `dsh-ops-ptc` and
  `dsh-ops-hide-official`; a leftover override names no row in the new bundle and produces a
  startup `patch: entry ... not found` warning. Set the mode switches you want afterwards.
- The optional client carrier migration now only switches the profile bundle name. It preserves
  every component row, switch and effective configuration; the nested client bundle renames only the
  standard-mode row to the package root, so a name-qualified `dsh-ops/mode-standard` override is
  refused for manual review instead of being rewritten.

## [Unreleased]

- Unify Native/discovery/PTC file and result publication with typed Outcome values and separate compact Native rendering; preserve fresh-read evidence, CAS and authority. Result uses one put/page/release schema, rejects Native put before IO, and defaults root to live cwd in both projections. Real source/grant changes conservatively invalidate all old steps sharing that registration; resolve again, never automatically replay.
- Native/发现/PTC 文件与 result 统一发布，执行值为类型化 Outcome，Native 文本独立紧凑渲染，保留新鲜读取证据、CAS 与权威检查。result 统一 put/page/release schema，Native put 在 IO 前拒绝，两投影 root 均默认实时 cwd；真实来源/grant 变化保守使共享注册旧步全部失效，须重新 resolve，禁止自动重放。

- Embed the complete frozen official Niubash v1.5.0 Windows x64 payload as the default shell backend; verify source and per-call execution trees, include preparation in cancellation/deadlines, preserve results on cleanup failure, and integrate managed install/status/select/removal. Missing payloads never switch implicitly to ambient Bash; explicit Git Bash and POSIX system Bash remain supported. This full-package-first choice does not rule out rubash-only later.
- Windows x64 默认 Shell 改为固定官方 Niubash v1.5.0 完整载荷；校验源树及每调用执行树，准备阶段纳入取消/超时，清理失败不覆盖结果，并接通托管安装/状态/选择/卸载。缺载荷不隐式切换环境 Bash，保留显式 Git Bash 与 POSIX 系统 Bash。这是先完整包的阶段选择，不否定后续 rubash-only。

- Let `/Prev` and `/XRefStm` be ordinary PDF dictionary keys: they mark an unsupported
  incremental update only as trailer keys, so an outline item's `/Prev` no longer makes the
  whole document unreadable (#427).
- 允许 `/Prev` 与 `/XRefStm` 作为普通 PDF 字典键：仅当它们出现在 trailer 中才表示不支持的增量更新，大纲项里的 `/Prev` 不再使整份文档被判不可读（#427）。

- Add current-scope `ops_status` diagnostics and public `diagnose(ctx, agent)` inspection; report integration, host/runtime, presentation and external provider readiness without executing or activating capabilities (#440).
- 新增当前作用域 `ops_status` 与公开 `diagnose(ctx, agent)`，区分接入、宿主/运行时、展示及外部提供者状态，不执行或激活能力（#440）。
- Expose opt-in Native capability providers with original names/contracts, explicit preset allow/startup/disable controls, per-instance selection invalidation and provider-owned authorization; reuse scoped discovery publication without requiring the OPS worker for external-only sessions (#440).
- 开放 Native 第三方能力注册，保留原名与契约，预设显式允许/启动/禁用，按实例撤销选择并由提供者负责授权；复用作用域发现发布，纯外部会话不依赖 OPS worker（#440）。
- Add explicit `dsh-ops/integration` preset opt-in with independent files, Bash, Native/PTC, discovery, replacement and guidance choices; unknown presets no longer receive the bundled discovery row implicitly. Existing headless/built-in and explicit legacy components retain their compatibility paths (#440).
- 新增 `dsh-ops/integration` 显式预设接入，独立控制文件、Bash、Native/PTC、发现、替换和提示词；未知预设不再隐式获得 bundle 的发现行。内置/无预设 headless 与显式 legacy 组件保留兼容路径（#440）。
- Separate scoped Native publication and replacement lifecycle from built-in preset policy; move Native rendering/read evidence to `file/native` and typed PTC projection to `ptc/projection`, without changing tool contracts or component exports (#440).
- 将作用域内 Native 发布与替换生命周期从内置预设策略分离；Native 渲染/读取证据归入 `file/native`，类型化 PTC 投影归入 `ptc/projection`，工具契约和组件导出保持不变（#440）。
- 收敛所有 DSH 产品类型、懒加载 scope 与 profile carrier 入口到项目自有 `adapter/dsh` 边界；保持现有 Cordis 工具注册、提示词、权限、subprocess、PTC、结果与 UI 行为不变，并将宿主兼容声明扩展至 `>=0.2.0-rc.2 <0.2.2-0`，覆盖已验证的 DSH 0.2.1-rc.4。
- Converge DSH product types, lazy scope loading and profile-carrier entrypoints behind the project-owned `adapter/dsh` boundary without changing existing Cordis tool, prompt, policy, subprocess, PTC, result or UI behavior; widen the bounded host range to `>=0.2.0-rc.2 <0.2.2-0`, including validated DSH 0.2.1-rc.4.
- Make benchmark model/reasoning selections actual shared routing conditions, archive composed configuration, and record the condition in sealed evidence. Repeated selections produce separate condition groups and reports; cross-condition pairing is refused, while historical runs remain readable as unknown (#294).
- 将 benchmark 的模型与思考档位选择用于两臂实际路由，归档合成配置并在封存证据中记录条件。重复选项生成独立条件组和分组报告，拒绝跨条件配对；历史运行仍可按未知条件读取（#294）。
- Make benchmark setup skip Windows-only checks explicitly on POSIX, preserve platform/component configuration in summaries and sealed arms, reject cross-platform comparisons by default, and expand the optional tools smoke to Linux, Windows and macOS (#295).
- 基准准备在 POSIX 上明确跳过 Windows 专用检查，普通摘要和封存数据保留平台及组件配置，默认拒绝跨平台混配，可选 tools 自检覆盖 Linux、Windows、macOS（#295）。
- Document the owned Bash restriction boundary and publication switch (#380),
  provider tool-change error ownership (#367), and scoped discovery troubleshooting (#346).
- 说明 Bash 自有工具的掩码边界与发布开关、提供商工具变更错误的职责边界及 discovery 作用域排查方法。
- Add macOS Intel (`darwin-x64`) as a first-class native target on macOS 13+: accept it in the resolver and profile commands, declare it in every component row, ship its Mach-O worker with a receipt, and add a non-blocking `macos-15-intel` CI leg plus the fourth release artifact. The Intel leg measured 318 s, so it follows the >300 s non-blocking rule. macOS 12 is not part of this support: its kernel lacks `CLONE_ACL`, so the write path fails closed; that fallback is a separate follow-up. See [macOS](macos.md).
- 将 macOS Intel（`darwin-x64`）作为 macOS 13+ 的一等原生目标：解析器与 profile 命令接受它，所有组件行声明它，发布其 Mach-O worker 与收据，并新增非阻塞的 `macos-15-intel` CI leg 与第四个发布 artifact。Intel leg 实测 318 秒，因此按 >300 秒规则作为非阻塞信号。macOS 12 不在本次支持范围内：其内核缺少 `CLONE_ACL`，写路径会 fail closed；该回退是独立后续项。说明见 [macOS](macos.zh.md)。
- Declare DSH 0.2.0-rc.2 and 0.2.1-rc.2 consistently in engines/peers, export every
  component icon, and validate bundle composition with the host patch API (#200).
  中英文兼容范围、组件图标导出与升级检查同步更新；宿主 patch 校验拒绝丢失目标的 override。
- Derive discovery names, file mutation/rendering classes, retrieval continuations, read observations, PTC residency and browser replacement choices from shared catalogue facts. Check all component declarations and explicit bundle defaults against runtime definitions, cover every worker tool in the Rust dispatch boundary, and expose missing shell/discovery settings fields with explicit compatibility exclusions (#315).
- 从共享目录定义派生发现工具名、文件变更渲染分类、读取续页、读取观察、PTC 常驻状态及浏览器替换选项。将各组件声明和 bundle 显式默认值与运行时逐项校验，覆盖全部工具的 Rust 分派边界，并补齐 shell/discovery 设置字段、明确兼容字段的排除项（#315）。
- Add opt-in `exactTotal: false` to grep for bounded prefix queries. Stop after the requested matching rows, report lower bounds without stable continuation, and preserve exact totals by default and for summaries. Keep invalid encoding as an explicit coverage gap instead of inventing a complete total (#384).
- grep 新增可选 `exactTotal: false`，按所需匹配行数提前停止，返回下界且不提供稳定续页；默认查询和 summary 保留完整扫描。无效编码仍明确标为覆盖缺口，不伪造完整总数（#384）。
- Summarize large intact JSON spills for successful Native foreground Bash calls, with bounded samples and a full-output path. Preserve canonical/PTC values, stderr, exit status, host spill ownership and fallback rendering; add no command rewriting or runtime dependency (#297).
- 成功的 Native 前台 Bash 调用可将大型完整 JSON 溢出输出显示为有限样本和完整输出路径；规范/PTC 数据、stderr、退出状态、宿主溢出存储及降级展示保持不变，不重写命令、不增加运行依赖（#297）。
- Present `ops_bash` through the host's terminal-card contract with multiline commands, cwd, captured output and durable exit/signal facts. Background jobs retain their collection guidance; older UIs retain generic rendering (#32).
- `ops_bash` 通过宿主 terminal card 契约展示多行命令、工作目录、已捕获输出和持久化退出码/信号；后台任务保留收集指引，旧 UI 保留通用展示（#32）。
- Isolate PTC and discovery presentation probes by inheritance family so an unanswered host hook cannot block unrelated roots. Cancel obsolete probe waits on supersession, disposal and unload; reject late publication while preserving atomic family overlays and live authority checks (#359).
- PTC 与 discovery 的呈现探测按继承族隔离，宿主 hook 未返回时不阻塞无关根会话；探测被取代、销毁或卸载时取消旧等待并拒绝迟到发布，同时保留继承族原子叠加层与实时权限检查（#359）。
- Defer and coalesce Bash lifecycle publication until session event delivery completes, preserve live authority checks for retained callbacks, and cancel queued publication on unload (#386). Accept text-only prompt presentation hooks without weakening complete PTC assembly checks (#387). Add a delayed-discovery first-prompt regression for the readiness fix already integrated in #366 (#375).
- Bash 生命周期发布延后到会话事件分发结束后并合并通知，保留旧回调的实时权限校验，卸载时取消待发布任务（#386）；兼容纯文本提示词呈现 hook，同时保留完整 PTC 装配检查（#387）。为 #366 已合入的就绪修复增加延迟 discovery 首轮回归（#375）。
- Reuse discovery presentation decisions with live context/session/policy inputs and explicit prompt, configuration and service invalidation; keep pre-step and execution checks fresh. Avoid empty Native provider notifications (#345, #333).
- discovery 按实时 context/session/policy 输入复用呈现判定，并在 prompt、配置和服务变化时失效；pre-step 与执行检查保持新鲜。不为空 Native provider 发送通知（#345、#333）。
- Publish PTC projections by affected inheritance family, merge superseded requests and track hidden Native provider changes. Attribute OPS-owned tool changes locally so independent sessions keep their definitions and cached probes; unknown external changes remain conservative (#333).
- PTC 投影按受影响继承族发布，合并被取代的请求并跟踪隐藏 Native provider 变化。OPS 工具变化在本地记录作用域，使独立会话保留定义与缓存探测；未知外部变化仍保守处理（#333）。
- Retain unchanged Bash layers and inherited restrictions; explicitly refresh definitions when shared jobs or executor services change. Add real-host bounded-probe/event and definition-identity regressions (#333).
- 保留未变化的 Bash 层与继承限制，仅在共享 jobs 或执行器服务变化时显式刷新定义；增加真实宿主探测/事件有界和定义身份回归（#333）。

- Read the tool names the tooling sections render through the scope view instead of the schema projection. `visibleTools` (the `tooling:shell`/`tooling:file` prompt section and the host-shell denial gate) asked `tools.schemas()` and kept only the names, so every prompt assembly paid one deep copy of every visible definition: 34.2 ms for 258 tools at the issue's own surface shape on the published 0.2.1-rc.2 runtime, against 0.043 ms through `tools.view()` — about 800x for the same name list in the same order, verified against `schemas()` for a scoped key and for the global layer. Cost tracks nested schema nodes, not payload bytes: the same host spends 16.5 ms on 811 KB of flat string fields but 34.2 ms on 705 KB carrying eight nested groups per tool, so the fixture is pinned to the issue's measurement (705,008 bytes of `parameters` against the recorded 691,714). The discovery pre-step probe is deliberately left alone: its per-step assembly is the path by which a presentation that flips without the names moving corrects itself, so memoizing it there trades a measured cost for a correctness regression (#369).
- 工具区段取工具名改用 scope 视图，不再走 schema 投影。`visibleTools`（`tooling:shell`/`tooling:file` 提示词区段与宿主 shell 拒绝门）之前问 `tools.schemas()` 后只保留名字，于是每次提示词装配都要把所有可见定义深拷贝一遍：已发布的 0.2.1-rc.2 运行时上，按 issue 自身的表面形状造 258 工具要 34.2 ms，而走 `tools.view()` 只要 0.043 ms——同一份名字、同一顺序下约 800 倍，并在 scoped key 与全局层两种形态下逐一对照 `schemas()` 验证一致。代价取决于 schema 的嵌套节点数而非 payload 字节：同一宿主上 811 KB 的扁平字符串字段只要 16.5 ms，而 705 KB、每工具八组嵌套对象要 34.2 ms，因此 fixture 按 issue 的度量固定（`parameters` 合计 705,008 字节，issue 记录值 691,714）。discovery pre-step 探针刻意不动：它每步的那次装配正是「呈现已翻转但工具名未变」这类 scope 自我纠正的路径，在那里加备忘等于用实测成本换正确性回归（#369）。
- Read the per-publish surface from the scope's derived view instead of its wire schemas, and carry the definition identity in the key. `surfaceOf` asked `tools.schemas()` for the names it memoizes, and that projector rebuilds one deep copy of every visible parameter schema per call: on the published 0.2.1-rc.2 tool runtime a single 258-tool read costs 24.58 ms against 0.094 ms for one view read naming the same surface, so the memo key cost more than the prompt assembly it was meant to skip — measured end to end with 1/2/4/8 agents the probe ran 6.5/14.3/32.8/58.2 ms before and 25.9/47.4/94.6/198.4 ms after, i.e. 2.9–4.0x the work it saves. Names now come from `tools.view(scope).visible`, which resolves the same visible map without projecting it; `schemas()` is kept as a fallback for a runtime that does not expose a view. The key pairs each name with a `WeakMap` identity for the definition the view holds, because a names-only key returns a stale hit when a scoped registration shadows a global of the same name — the shadow is what a publish captures, so missing it publishes nothing on the change that owed a republish. Identity costs one lookup against an object already in hand rather than the `tools.get()` pairing that would rebuild the whole view per name and turn the key into O(names²) (#368, #369).
- 每次发布的工具快照改为读取 scope 的派生视图，不再读取其 wire schema，并让键携带定义身份。`surfaceOf` 之前用 `tools.schemas()` 取名当备忘键，而该投影每次调用都会把所有可见工具的参数 schema 深拷贝一遍：在已发布的 0.2.1-rc.2 工具运行时上，一次 258 工具读取要 24.58 ms，而读取同一份表面的单次视图只要 0.094 ms，于是这个备忘键比它想省掉的那次提示词装配更贵——端到端实测 1/2/4/8 个 agent 时，探针改动前为 6.5/14.3/32.8/58.2 ms，改动后为 25.9/47.4/94.6/198.4 ms，即多做了 2.9–4.0 倍的功。现在工具名取自 `tools.view(scope).visible`，它在不投影的前提下解出同一份可见映射；保留 `schemas()` 作为运行时未暴露视图时的回退。键为每个名字配上该视图所持定义的 `WeakMap` 身份，因为只含名字的键在 scoped 注册遮蔽同名全局定义时会返回陈旧命中——被遮蔽的那份定义才是发布实际捕获的对象，漏掉它就会在该重新发布的变化上什么都不发。身份只需对已持有的对象查一次表，而非改用 `tools.get()` 逐名配对（后者会为每个名字重建整份视图，把键的代价变成 O(名字数²)）（#368、#369）。
- Keep the per-agent re-probe from retiring live registrations or stranding an unpublished surface. `reconcile` advanced its epoch on every call, so the passes the new `targets` argument turns into no-ops still invalidated every published `execute` guard and every Native shadow, which then answered `POLICY_DENIED` for a scope that was still authoritative; and a probe recorded its surface on the entry before the republish that consumes it ran, so a pass a later reconcile superseded left the next pass reading that surface as already published and returning early forever, which is how a PTC verdict could never take effect. A separate `published` counter now moves only when a pass actually republishes, the guards compare it, and probed surfaces stay pending until that republish commits them. `discovery` compares `published` for the same reason its probe cannot: assembling the prompt reconciles other scopes. A departure's empty target set is also a probe-free pass now, instead of being normalized to "no restriction" and re-probing every survivor, and the per-publish snapshot reads tool names through one shared `surfaceOf` rather than a copy per plugin (#368).
- 让逐 agent 重探针不再作废仍有效的注册，也不再把未发布的结果留在 entry 上。`reconcile` 每次调用都推进 epoch，于是新增 `targets` 参数变成空转的那些 pass 仍会作废所有已发布的 `execute` 守卫与 Native 影子工具，它们随后对仍然有效的 scope 返回 `POLICY_DENIED`；探针还会在消费它的那次重发布执行之前就把 surface 记到 entry 上，被后一次 reconcile 取代的 pass 由此让下一个 pass 把该 surface 当作已发布而永远提前返回，PTC 判定因此始终无法生效。现在单独的 `published` 计数器只在某个 pass 真正重发布时推进，守卫改为比较它，探针结果保持待提交直到那次重发布写入。`discovery` 同样比较 `published`：它的探针要装配提示词，而装配会 reconcile 其它 scope。离开 agent 时的空目标集合现在是真正的免探测 pass，不再被归一化成“无限制”而对全部幸存者重探；每次发布的工具快照改由共享的 `surfaceOf` 读工具名，不再每个插件各存一份（#368）。
- Stop re-probing every tracked agent on each PTC publish. `ptc` and `discovery` both assembled the entire prompt once per agent per reconcile, so a new session paid for every session still tracked: on Windows x64 with 38 bundles the same `session/create` took 264 / 308 / 396 / 475 / 590 / 681 / 748 / 947 ms over eight rounds. Each agent now memoizes its presentation verdict against the tool names it publishes and re-probes only when that set changes, `reconcile` accepts the agents a change actually touches, and the per-publish tool snapshot reads names instead of rebuilding a scope view per tool. The same eight rounds now measure 195 / 226 / 270 / 260 / 295 / 329 / 358 / 373 ms (#333, #359).
- 不再在每次 PTC 发布时重新探测全部已跟踪 agent。`ptc` 与 `discovery` 都在每次 reconcile 里对每个 agent 完整装配一次提示词，因此新建一个会话要付出所有仍在跟踪的会话的代价：Windows x64、38 个 bundle 下，同一个 `session/create` 八轮为 264 / 308 / 396 / 475 / 590 / 681 / 748 / 947 ms。现在每个 agent 按自己发布的工具名缓存呈现判定、只有该集合变化时才重新探测，`reconcile` 接受「本次真正受影响的 agent」，每次发布的工具快照只读工具名而不再为每个工具重建一次 scope 视图。同样八轮实测为 195 / 226 / 270 / 260 / 295 / 329 / 358 / 373 ms（#333、#359）。
- Run CI on every PR target branch, including stacked feature branches; provide a checked ruleset payload and explicit administrator acceptance steps for required checks (#303). Repository enforcement still requires admin application.
- CI 覆盖所有 PR 目标分支（包括堆叠功能分支），提供校验过的规则 JSON 与管理员验收步骤（#303）；仓库强制保护仍需管理员实际应用。

- Stop `dsh-ops-hide-official` from blocking a `run_code` (PTC) scope when `replaceTools` is set. That scope presents one program entry, and the selected counterparts are SDK functions rather than owned native providers, so readiness could never be proven and every PTC session failed prompt assembly with `READINESS_BLOCKED` as soon as one tool was selected. Readiness is now judged on the assembled surface: a scope that really kept a selected official tool still fails closed, while a collapsed scope's transport is not gated and the selected official names stay refused there.
- 修复 `dsh-ops-hide-official` 在设置 `replaceTools` 后阻塞 `run_code`（PTC）作用域的问题。该作用域只呈现一个程序入口，所选替代工具是 SDK 函数而非已拥有的 native provider，就绪状态永远无法成立，只要选择了一项工具，每个 PTC 会话的提示词组装都会以 `READINESS_BLOCKED` 失败。现在改以装配出的表面判定：真正保留了所选官方工具的作用域仍然失败闭合；折叠作用域的 transport 不再被门禁阻塞，所选官方工具在该作用域内仍被拒绝。
- Name the bytes each published checksum covers (#300): `SHA256SUMS` is authoritative for the released tarballs, and every tarball records its native worker's digest in `runtime/<target>/provenance.json`; the Release body defines neither. The 0.3.1 notes headed that table `Target | SHA-256` and listed the worker digest, while 0.3.2 kept the heading and listed the ZIP digest, so anyone comparing archive against worker saw a false mismatch. The troubleshooting guides now carry the in-package check (`node package/bin/native-runtime.mjs check --root package --platform <target>`), which needs no platform-specific hashing tool, and `docs/PROVENANCE.md` records the historical mismatch. Published Release bodies are left as they were.
- 说明已发布的摘要到底覆盖哪些字节（#300）：`SHA256SUMS` 是发布 tarball 的权威，每个 tarball 在 `runtime/<target>/provenance.json` 里记录自带 native worker 的摘要，两者都不由 Release 正文定义。0.3.1 的正文把 `Target | SHA-256` 填成 worker 摘要，0.3.2 在同样表头下填成 ZIP 摘要，比对归档与 worker 的人因此看到假的不匹配。排查文档新增包内校验命令（`node package/bin/native-runtime.mjs check --root package --platform <target>`），不依赖平台专有的哈希工具；`docs/PROVENANCE.md` 记录这段历史口径。已发布的 Release 正文保持原样。
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
- Reserve the exact `.dsh-ops` component case-insensitively on absolute public file-tool paths as well as relative batch paths. Reads, writes, edits, copy/move sources and destinations, removals, and explicit search/replace paths return `PATH_RESTRICTED` before content access or publication. Preserve ordinary hidden-search exclusions and trusted batch audit/result/cache lifecycle access (#329).
- 绝对路径公开文件工具与相对 batch 通道统一将完整组件 `.dsh-ops` 视为保留名，忽略大小写。读取、写入、编辑、复制/移动的源与目标、删除及显式搜索/替换路径均在内容访问或发布前返回 `PATH_RESTRICTED`；保留普通隐藏搜索排除规则，以及可信 batch 审计、结果和缓存生命周期访问（#329）。

- Fix independent restricted Windows Bash roots failing to reopen the current user's MSYS shared section while another root is alive (#363). Preserve the original ACL and the existing verified object-directory, pagefile-only and Low restricted-token boundaries; unrelated sections and filesystem permissions are unchanged.
- 修复 Windows 受限模式中，一个 Bash 根进程仍在运行时，独立根进程无法重新打开当前用户的 MSYS 共享段的问题（#363）。保留原有 ACL，以及经过验证的对象目录、仅分页文件共享段、Low 受限令牌边界；不改变其它共享段和文件系统权限。

### Fixed

- Withdraw PTC publication and cancel calls when a session leaves its selected preset; keep other
  sessions' discovery selections intact and authorize external calls only in their owned wrapper.
- Diagnose the selected discovery/shell services and scoped publication; clarify the host's
  ancestor-registration/restriction limit for nested unrelated preset integrations.
- 切换离开已接入预设时撤回 PTC 发布并取消调用；保留其他会话的发现选择，外部调用仅在自有包装内授权一次。
- 诊断所选发现/Shell 的服务与作用域发布，并说明无关预设嵌套时宿主继承祖先注册/限制的边界。

## [0.5.0] — 2026-10-27 — Preset-mode component roster

### Breaking changes

- Replace the seven-row component roster with eight rows: `dsh-ops/mode-minimal`,
  `dsh-ops/mode-standard`, `dsh-ops/mode-ptc` and `dsh-ops/mode-cordis` for the built-in
  presets, `dsh-ops/discovery` for dynamic tool loading, `dsh-ops/compat` for Compatibility
  mode, `dsh-ops/panel` for data inspection and `dsh-ops/tui` for TUI integration. The former
  `dsh-ops/shell`, `dsh-ops/file`, `dsh-ops/ptc` and `dsh-ops/hide-official` rows are gone
  from the bundle; their modules remain as unsupported legacy exports for old profiles.
- A mode row publishes OPS tools only for sessions composed from its preset. Standard and Cordis
  replace the official `read`, `glob` and `grep`; every enabled mode replaces the official
  Windows shell (`pwsh`/`pwsh_persistent` with `ops_bash` on Windows). A replaced tool is
  hidden only while its OPS counterpart is visible in the same scope.
- `dsh-ops/compat` inverts the removed per-tool `replaceTools` selection: enabling
  Compatibility mode keeps every official tool visible while OPS tools stay available, and lifts
  hiding without unloading any row. It is off by default; while it is on, token efficiency and
  model ability are reduced.
- Windows sessions route command execution through `ops_bash` instead of the official `pwsh`
  when a mode row is enabled and the OPS counterpart is visible.
- Restore the OPS icon on every component row.

### Upgrade

- Delete saved profile patch overrides for `dsh-ops-shell`, `dsh-ops-file`, `dsh-ops-ptc` and
  `dsh-ops-hide-official`; a leftover override names no row in the new bundle and produces a
  startup `patch: entry ... not found` warning. Set the mode switches you want afterwards.
- The optional client carrier migration now only switches the profile bundle name. It preserves
  every component row, switch and effective configuration; the nested client bundle renames only the
  standard-mode row to the package root, so a name-qualified `dsh-ops/mode-standard` override is
  refused for manual review instead of being rewritten.
  
## [0.4.1] — 2026-10-20 — Update locks stop leaving files behind

- Stop the update lock from leaving `.dsh-ops-update-*.lock` sidecars behind (#319). The writer that takes the lock removes it on release, and only after proving the name still leads to the inode it locked, so a waiter that opened the old inode can never publish under it. A published write, a request refused after the lock and a directory-wide `replace` now leave the directory exactly as they found it; a sidecar left by a killed writer is not a stuck lock — the next write of that name binds to it, publishes under it and removes it.
- 更新锁不再在目录里遗留 `.dsh-ops-update-*.lock`（#319）：持锁的写者在释放时删除它，并且先确认名字仍指向自己锁住的 inode，因此打开过旧 inode 的等待者不会在它上面发布。成功写入、拿锁之后被拒的请求、整目录 `replace` 都不再留下痕迹；被硬杀的写者留下的边车不是死锁——下一个同名写入会锁定它、用它发布并删除它。

- Restore `ops_bash` background jobs. The tool read the host `jobs` registry at definition time and then required `ctx.get('jobs')` to be identity-equal at call time; a tracked Cordis service returns a fresh traceable proxy on every read, so the comparison could never hold and every `run_in_background` call failed with `EXECUTOR_UNAVAILABLE` while the schema still advertised the parameter, and a foreground timeout killed the command instead of promoting it. Bind the registry once through `ctx.inject(['jobs'], …)`, exactly as the host's own bash tool does, and pass it into the definition; re-register when the service mounts or unloads. Regression tests cover the tracked-service proxy, background admission, and timeout promotion.
- 恢复 `ops_bash` 的后台任务能力。原实现定义工具时读取一次宿主 `jobs` 注册表，执行时要求 `ctx.get('jobs')` 与它身份相等；Cordis 的被跟踪服务每次读取都返回新的 traceable proxy，比较永远不成立，于是 schema 声明了 `run_in_background` 却必然报 `EXECUTOR_UNAVAILABLE`，前台超时也只会杀进程而不会转后台。改为像宿主自带 bash 一样经 `ctx.inject(['jobs'], …)` 只绑定一次注册表并传入工具定义，服务挂载/卸载时重新注册；补了被跟踪服务代理、后台受理与超时升级的回归测试。

- Restore extended attributes before the replacement's final mode, so a read-only file keeps its `user.*` attributes and macOS stops reporting `com.apple.provenance` unrestored on every `0400` replace. The mode matrix now carries a user attribute, so the order is asserted on every host rather than only where macOS supplies that attribute for free (#324).
- 恢复扩展属性时改在写入最终模式之前进行，只读文件不再丢失 `user.*` 属性，macOS 的 `0400` 替换也不再报告 `com.apple.provenance` 未恢复；模式矩阵用例改为携带用户属性，使该顺序在所有平台都受断言约束，而不只依赖 macOS 自带的属性（#324）。
- Stop inventing audit references for new batch validation failures that occur before a job is saved, and for synchronous failures before worker creation. Preserve worker-provided references, existing resume identities and recovery ids for interrupted or ambiguous execution; no additional worker calls are made (#78).
- 新批次在审计记录创建前发生已确认的校验失败，或工作进程创建前同步失败时，不再返回不存在的审计引用。保留 worker 返回的引用、已有 resume 标识，以及执行中断或状态不明时的恢复标识；不增加 worker 调用（#78）。
- Document stopped-host upgrades and removal, explicit trusted-registry selection for lockfile policy checks, and the 0.3.x-to-0.4.x migration contracts (#175, #335, #372). Distinguish file locks, missing registry metadata and unconfirmed native crash causes; retain security policies and provide scoped crash-evidence guidance.
- 补充停止宿主后升级/卸载、锁文件策略检查时显式选择可信 registry，以及 0.3.x 到 0.4.x 的迁移契约（#175、#335、#372）。区分文件占用、registry 元数据缺失与未确认的原生崩溃原因；保留安全策略并提供按应用收集证据的方法。
- Validate the selected profile CLI before both dry-run and execution (#100): reject missing or unusable launchers and missing Node bin targets, preserve PATH lookup and Windows PATHEXT/batch launchers, and apply Windows command-script path checks during preview. Dry-run never executes the candidate or changes the profile.
- 在安装/卸载的预演与实际执行前共用 CLI 静态检查（#100）：拒绝缺失或不可用的启动文件及缺失的 Node bin 入口，保留 PATH 查找与 Windows PATHEXT/命令脚本，并在预演时同样检查 Windows 命令脚本路径。预演不启动候选程序、不修改 profile。

- Fix the generated `ops_load_sdk` declaration (the builder still keyed on the pre-rename `sdk` name), cover the rename alias plus the `select:` and SDK request paths with tests, and align the catalogue facts in the current docs (20/18/15, 242 tokens/1101 bytes) with a docs guard (#302).
- 修复生成的 `ops_load_sdk` 声明（构建脚本仍按改名前的 `sdk` 判定）、为改名别名与 `select:`/SDK 请求路径补测试，并把当前文档的目录事实（20/18/15、242 tokens/1101 bytes）对齐并加守护（#302）。
