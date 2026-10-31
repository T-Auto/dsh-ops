# Changelog

All notable changes to this package are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Bound an unattributed `tools/change` to one representative probe: the registry notification may name the affected scope, and when the host names none only one session is re-probed synchronously while the rest stay stale until their next real assembly. `system-prompt/change` takes the same lazy path, a scope the host names but no session knows falls back to the conservative path, and the representative probe no longer cascades into its own scope family. This removes the one-full-assembly-per-live-session cost that made session creation scale with the live count (198 live sessions: 23,143ms and 1,393 assemblies before, 7,097ms and 400 after with only the discovery path bounded; zero live sessions are unchanged at 103-129ms).
- 未点名作用域的 `tools/change` 收敛为只同步重探一个代表会话：宿主点名时只失效该作用域及其后代；未点名时其余条目保持过期，在各自下一次真实组装时重新观测。`system-prompt/change` 走同一条惰性路径；宿主点名但无任何会话认识的作用域改走保守路径；代表会话的探测不再连带重探它自己的作用域族。这去掉了「每个存活会话一次完整装配」的成本（198 存活会话：修复前 23,143ms / 1,393 次装配，仅收敛 discovery 路径后 7,097ms / 400 次；零存活会话时两者一致，103-129ms）。

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
