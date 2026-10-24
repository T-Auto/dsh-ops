# OPS 只读侧栏

[English](tui-panel.md)

## 启用

在 dsh-TUI profile 中启用已有的 `dsh-ops/tui` bundle 行并重启；默认关闭。使用实验性 `tuiPanels` API v1，需要包含「按导出子组件入口最近的包清单准入」修复的 TUI 构建。只识别外层包清单的旧构建不能保证正确的组件身份。

修改已有行，不要添加重复行：

```yaml
id: dsh-ops-tui
name: dsh-ops/tui
disabled: false
config:
  maxSessions: 32
  maxActive: 128
  recentLimit: 8
```

添加 OPS 标签，不强制打开或抢焦点。不新增 TUI/React 运行时依赖，使用宿主提供的 React 与 UI 原语。没有 `tuiPanels` 时只有该可选行等待；API v1 注册被拒绝时不启动观测。原 OPS 操作权限不变；UI 子组件拥有独立清单，不要求工具契约、不申请权限、不注册命令，也不拦截决策事件。

## 显示内容

- 当前选中会话自该组件启用后观察到的原生与 PTC OPS 调用。
- 调用数、运行中、传输返回/错误与最近观察耗时。
- 拒绝、业务失败、预览/计划、部分失败和明确的未知副作用，来自原生工具的展示元数据与 PTC 的 JSON 返回；未知副作用会提示先检查、不要盲目重试。
- 已结算的批处理完成数量、未展示明细数量及分页提示；不伪造实时进度。
- 达到上限时明确标记统计不完整。「已返回」是中性状态，**不代表业务成功**；后台任务启动调用返回不代表任务已经完成。

这不是历史重放或持久用量统计。关闭再打开面板不重置观测，卸载组件才清空。不保留命令、参数、搜索模式、替换文本、路径、结果正文或错误正文。切换会话只切换快照，不增加模型/worker 调用、job_output 读取、轮询、提示词段落或 token 节省估算。不提供删除、重试、提权或发送给模型按钮。

Shell 输出或被 spill/截断的内容无法可靠恢复业务状态，会保持「业务状态未确认」，不会假报成功。原生文件工具与原生 `ops_result` 给模型的是紧凑文本而非 JSON，因此会在宿主可重放的展示元数据里附一个有界的 `opsOutcome` 对象（状态、错误码与副作用状态、安全计数和布尔值；不含路径、条目或错误正文）。PTC 子调用仍只解析最多 64 KiB 的单条 JSON 文本。模型可见的文本从不被解析成业务结论。

## 只读筛选与本地分页

聚焦 OPS 面板后：

| 按键 | 动作 |
| --- | --- |
| `f` | 全部记录 → 运行中 → 异常记录循环；回到第一页 |
| `n` / PageDown | 下一页保留元数据 |
| `p` / PageUp | 上一页保留元数据 |
| `a` | 仅确认所有会话的汇总通知 |

Esc 与左右切面板键仍交给宿主；不拦截聊天输入或带修饰键的快捷键。页脚显示筛选、当前页/页数和筛选后的保留条数，顶部统计保持未筛选的累计值。异常筛选**只显示当前会话仍保留的异常记录**，不是跨会话通知清单；确认通知不会移除记录。

分页只操作有界内存中的进行中/最近记录，不执行工具、不读会话历史、不读取 `ops_result` 分页，也不展开省略的结果正文。长诊断在后页带工具名称续显。新结算与保留淘汰会改变页面内容：这是实时视图，不是固定档案。尺寸变化会钳制页码；会话切换或面板重新挂载会重置本地筛选/页码。面板太矮时可能仅能显示概况，放大后再浏览明细。

## 汇总异常提醒

OPS 标签通过公开徽标 API 提醒新观察到的拒绝/部分失败（warning）、业务/执行错误或明确未知副作用（error）。普通返回、预览和业务状态未确认的文本不触发提醒，重复事件不累计。面板隐藏时继续观测，提醒不自动打开面板、不抢焦点。

这是**自上次确认以来、所有会话的汇总**，不是当前会话失败数量，也不是未解决问题清单；面板明确标注范围。只保留计数和最高级别，不保留会话 ID 或结果正文；活动统计的 LRU 淘汰不重置汇总。数量封顶 999，超过后面板标为 `999+`。

聚焦 OPS 面板后按 **a** 确认全部汇总提醒。只重置通知状态，不影响会话统计、工具、权限或任务。切换会话、聚焦面板都不会确认汇总。宿主打开标签时可能自行清掉标签指示点，但标明范围的汇总计数保留到显式确认或组件卸载。不依赖尚未实现的 opened/focused 通知，也不轮询。

## 上限

TUI 行只接受以下键：

| 键 | 默认 | 范围 |
| --- | ---: | --- |
| `maxSessions` | 32 | 1–256 个保留会话，LRU 淘汰 |
| `maxActive` | 128 | 每会话跟踪 1–1024 个进行中调用 |
| `recentLimit` | 8 | 每会话 1–64 条已结算记录 |

限制的是观测内存，不是工具执行。进行中记录达到上限后省略新调用，并标记统计不完整；淘汰会话只丢统计，不取消工作。使用完整 component 面板；当前 TUI API 的 compact 专用渲染和 send-to-chat 均不在范围内。

## 验证

```console
node test/run.mjs tui-activity tui-panel tui-result tui-attention tui-navigation manifest
DSH_OPS_TUI_ROOT=/path/to/dsh-TUI DSH_OPS_REQUIRE_TUI=1 node test/run.mjs tui-host
```

可选宿主用例从同一个 TUI 检出或构建包解析 React/Cordis/渲染依赖，在任何 TUI 导入前隔离 HOME/USERPROFILE/DSH_HOME，验证真实 Loader 准入、OPS 导出子路径、inline/fullscreen 的 28/38 列面板、会话切换、聚焦态导航/确认、尺寸变化与新结算后的本地重分页和卸载。工具事件是合成数据，不等于 Windows 原生执行、OS 沙箱或真实 PTY 手工验收。未设置路径时明确记为跳过；`DSH_OPS_REQUIRE_TUI=1` 使缺少路径成为失败。加上 `DSH_OPS_TUI_BUILT=1` 可在已编译的检出中使用 `lib/types`。测试目标必须能解析自身测试/peer 依赖；peer 由 DSH 启动器供应的生产 profile 不是独立测试根，不要为此向现用 profile 安装测试依赖。

### 真实源码 worker 联调

显式构建独立 worker（Rust 1.97.1），然后启用独立用例：

```console
cargo build --release --locked --manifest-path native/Cargo.toml
DSH_OPS_TUI_ROOT=/path/to/dsh-TUI DSH_OPS_TUI_WORKER=/absolute/path/to/dsh-ops/native/target/release/dsh-ops-worker DSH_OPS_REQUIRE_NATIVE_TUI=1 node test/run.mjs tui-native
```

使用真实 Rust worker、OPS 文件运行时、DSH 工具运行时、AgentLoop、Session 提交后通知，以及真实准入的侧栏与渲染器。模型响应和策略选择是脚本夹具，不调用在线模型。覆盖原生文件读取、有界列表、dry-run 替换和只读拒绝；**不覆盖** PTC batch/result 执行、生产 PTC-only 发布门禁、run_code 执行、磁盘持久化耐久性、Windows 沙箱或手工 PTY 验收。只修改测试自有临时文件，隔离 HOME/USERPROFILE/DSH_HOME。用例本身不构建/下载 worker，也不改发布平台解析器。缺少 opt-in 前提时记为跳过，required 标志使其失败。

侧栏不改变整包声明的 Windows x64、Linux x64、macOS arm64 与 macOS Intel x64 目标；UI 测试本身不能替代原生执行或 OS 沙箱验收。
