# Changelog

All notable changes to this package are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- Document the Linux index limitations: network (NFS/FUSE/CIFS/9p/Ceph/AFS) and kernel pseudo (procfs/sysfs/debugfs/tracefs/securityfs/cgroup) roots stay Offline and never back an index, classification failures fail closed, inotify events cannot be replayed across processes, and a restarted worker always rebuilds cold (#608).
- 记录 Linux 索引限制：网络（NFS/FUSE/CIFS/9p/Ceph/AFS）与内核伪文件系统（procfs/sysfs/debugfs/tracefs/securityfs/cgroup）根保持 Offline、不支撑索引，分类失败一律按 Offline 处理（fail closed），inotify 事件无法跨进程回放，重启的 worker 只能冷重建（#608）。
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