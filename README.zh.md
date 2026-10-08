# dsh-ops

由 [FastCtx](https://github.com/yc-duan/fastctx) 驱动的 DSH 仓库工具插件，保持**工具包 → bash → pwsh7**三层设计。文件操作走工具包，通用命令优先 bash，Windows 原生操作才用 PowerShell 7；不重复宿主看图和定点编辑能力。

| | |
| --- | --- |
| 目标宿主 | DSH `0.2.0-rc.2` |
| 清单 | dsh-std Community v0.15 |
| 工具面 | 四个文件工具；授权会话提供优先命令执行器 ops_bash 与五个命令/job 工具 |
| 许可证 | `MIT AND Apache-2.0` |

## 工具面

| 要做的事 | 工具与真实增量 |
| --- | --- |
| 多文件、多区间、编码、PDF 文本、hex | `ops_inspect_local_file`；优先 `files[]`，每次 1–32 个文本区间 |
| 看图 | 宿主 `read_image`；ops 明确拒绝图像结果，不再返回“已经看到了”的占位符 |
| 搜内容 | `ops_grep`：单个 Rust 正则、支持 `!` 排除的 `glob[]`、count/summary、编码回退 |
| 找文件 | `ops_glob`：支持 `!` 排除的 `pattern[]`；paths/details 输出 |
| 跨文件机械替换 | `ops_replace`；定点改代码用宿主 `edit` |
| 通用命令、构建、git/gh、管道和脚本 | `ops_bash`，优先的命令执行器 |
| Windows 原生 cmdlet、注册表、服务 | 宿主 pwsh，可指向 provision 的 PowerShell 7 |
| 有界 bash 命令与自己的后台任务 | `ops_run`、`ops_run_background`、`ops_job_output`、`ops_job_list`、`ops_job_kill`；只在完全权限会话发布 |

`ops_bash` 是核心第二层，不是应删除的重复工具：用插件解析的 bash，经宿主 subprocess 执行。`publishBashTool` 默认 true。Windows bundle patch 保留，把**宿主的** pwsh 执行器指向可用的 PowerShell 7。通用命令行优先 bash，只有必须用 Windows 原生能力时才用 pwsh；bash 出错在 bash 内修，不切换 shell，不混两套语法。

插件只注入**一张紧凑路由表**，加两条规则：文件操作不要拼 shell 命令；工具出错改参数重试，不换 shell 兜底。命令组可见时另加“只操作自己启动的 job”规则。不再发布旧 host-shell 段和 `mcp:fastctx` 服务端 instructions。`promptPolicy: false` 关闭这张表。

## 权限权威与动态切换

`enableShellTools` 只表示部署想不想要，不表示授权。命令与 job 五件组只有在宿主
`sandboxPolicy.resolve({ session })` 明确返回 `danger-full-access` 时才一起发布。
`read-only`、`workspace-write`、没有权威服务、没有调用会话，都不发布。不用环境变量或权限预设名称猜授权。

`ops_bash` 独立要求 `publishBashTool` 开启、bash 可解析、宿主 subprocess 可用，以及同样的完全权限会话。FastCtx 缺失或 `enableShellTools: false` 不影响 bash 这一层。它也使用插件自己的 agent 子 fiber 注册，随权限事件切换；调用时重查权限，workdir 默认取当前调用会话的工作目录。

命令定义注册在插件拥有的子 fiber 中，继承 agent 的注册 scope。收到 `sandbox/mode` 会话事件就重新协调工具集，不需要重连 FastCtx。每次命令/job 调用前再读一次有效权限，防止旧句柄绕过撤销。权限降级阻止**新调用**，不会自动终止已开始的命令或后台 job。

`danger-full-access` 是文件沙箱模式，不等于禁用了所有审批策略。宿主已有审批闸仍然有效；本桥接没有另做逐命令审批升级流程。

默认 `shellPolicy: advise` 不动宿主 shell。显式 `deny-host-shell` 则遮蔽配置中的宿主继承工具，并拒绝其调用，**不再以 ops 自己还有 shell 为前提**。这可能有意让会话没有任何命令执行器；拒绝文案不会推荐一个不可用的 ops 工具。宿主工具若在本 agent 自己的层中注册，可能无法遮蔽，但执行仍被拒绝。

**这不是文件系统沙箱。** 四个 FastCtx 文件工具没有接入宿主的受限文件后端；尤其 shell 权限门不会让 `ops_replace` 自动获得 workspace confinement。没有另行设计文件系统约束前，不要把本插件视为适合不可信受限部署的方案。

## Job 隔离与输出收敛

只有成功的 `ops_run_background` 响应才能授予 job ID 所有权，按**调用会话 + 当前连接**记账。列表、尾注和输出里的 ID 都不能授予所有权。别人的 `job_output` / `job_kill` 在转发前拒绝。
`ops_job_list` 在插件内部有界扫描上游页，只返回自己的记录、分页与计数；不暴露全局总数或 offset。扫描不完整时明确标注，不伪称完整。

只在服务端尾部装饰位置过滤 Background 行，保留自己的条目，删除别人的条目与无法归属的聚合计数；没有自己的 job 就没有尾注。原有分页与 Complete/Partial 状态仍保留。

重连或卸载会清空所有权。FastCtx 持久 job 可能仍在，但新连接不能认领；启动请求超时也可能留下一个没有收到 ID 的 job。这些情况需要操作者清理，不宣称已终止。

schema 只做发布投影：压缩描述，grep 只公开对称 `context`，PDF 只公开 text 模式。其余调用参数原样转发；旧 before/after 参数仍由 FastCtx 接受。改后缀伪装的图像结果也明确拒绝；`view: hex` 仍可查看任意文件原始字节。

三个只读定义声明 `isConcurrencySafe: () => true`；替换、命令保持独占。`toolCallTimeoutMs` 仍限制 RPC 等待。不虚标宿主定义 `timeoutMs`：现有传输取消只放弃等待，不能证明服务端工作已停止。`ops_run.timeout_ms` 是另一个 FastCtx 进程树超时参数。

## 安装、更新、卸载

```console
dsh plugin --profile desktop add <checkout 绝对路径或包 spec>
dsh plugin --profile web add <checkout 绝对路径或包 spec>
dsh --profile desktop --dump-config
```

安装属于目标 profile，不是 `npm i -g`。宿主 `plugin_manager` 同样可用 `install_bundle` / `remove_bundle`。插件加载期不下载、不安装依赖。

配置可经宿主 HMR 重新应用。替换已加载 JavaScript 需要重启 DSH；会话权限切换不需要。本次源码更新后，先重启，再手动验证。

```console
dsh plugin --profile desktop remove dsh-ops
node bin/dsh-ops.mjs uninstall             # 报告/干跑
node bin/dsh-ops.mjs uninstall --yes       # 删除自己的托管运行时与 shell 目录
```

卸载释放文件工具、各 agent 命令 fiber、限制、监听器、路由提示词段与 MCP 子进程。bundle 移除不删 `<DSH_HOME>/dsh-ops/` 托管文件，也不删上游 `~/.fastctx/` 状态；清理 FastCtx 状态须显式 `--purge-fastctx`。

## 配置

在 `lib/config.js` 校验；未知键点名报错。

```yaml
config:
  # binaryPath: 'C:\tools\fastctx.exe'
  serverName: fastctx       # 兼容的服务端标识，不再生成 MCP 提示词段
  enableShellTools: true   # 还须会话 danger-full-access
  toolCallTimeoutMs: 300000
  required: false
  shellPolicy: advise      # advise | deny-host-shell
  deniedHostTools: [pwsh, bash, pwsh_persistent]
  promptPolicy: true
  # extraGuidance: '部署特有规则'
  publishBashTool: true    # 优先 bash 层，仍须会话完全权限
  # bashPath: 'C:\Program Files\Git\bin\bash.exe'
  allowSystemShellFallback: true # 无自带副本时允许解析系统 bash
```

`required` 让缺失或不可用的运行时在加载期同步失败；连接失败也拒绝激活。false 时后台有界重试，最多十次。服务端断线立即撤下工具，避免虚假的 schema 和提示词项。

## 运行时工具

FastCtx 解析顺序：`binaryPath`、`DSH_OPS_FASTCTX_BIN`、`<DSH_HOME>/dsh-ops/bin/` 托管副本、vendored release 构建、`@dsh-ops/fastctx-<平台>-<架构>`、上游 `@fastctx/<平台>-<架构>`、PATH。显式路径权威，不可用时不退到别处。

```console
node bin/dsh-ops.mjs status        # 诊断文件工具列表；没有会话授权
node bin/dsh-ops.mjs ladder        # 保留旧命令：解析结果与紧凑路由表
node bin/dsh-ops.mjs build         # vendored Rust 构建；Rust >=1.88
node bin/dsh-ops.mjs provision     # 托管运行时及 SHA-256 回执
node bin/dsh-ops.mjs provision-shells --bash
node bin/dsh-ops.mjs provision-shells --pwsh
```

shell pin 包只含元数据，不含上游载荷。显式 provision 下载官方资产、校验固定 SHA-256，再解到 `<DSH_HOME>/dsh-ops/shells/`；不改 PATH，不绕过权限；bash 层使用解析出的可执行文件。上游标识与许可记录见 [PROVENANCE.md](PROVENANCE.md)。

## 手动验证与测量

本轮**不补回归测试，不做新 CI**。原测试套件未更新、未运行，还含过时阶梯/发布预期，不能用来证明此版本已验收。请按[手动清单](docs/manual-validation.md)验证。

```console
node scripts/measure-schemas.mjs docs/schema-current.json
```

此命令只握手并列 schema，不执行工具。[基线](docs/schema-baseline.json)与[当前值](docs/schema-current.json)统一测量紧凑 UTF-8 JSON `{name,description,parameters}`。token 为 `ceil(bytes/4)` 粗估，不是 tokenizer 实测、API 账单或调用频率。四工具/九工具小计区分受限会话与完全权限会话；九工具基线未计 `ops_bash`，不把其删除收益混入数字。

## 注册边界

公开工具名统一经 `lib/policy.js` 的 `publicToolName()`。只用插件自己的上下文注册定义，不替换共享 `ToolRuntime` 的任何方法。宿主半边零 `@deepseek-ai/*` 值导入。本轮没有改 vendor 功能实现。

## 许可证

本分发采用 **`MIT AND Apache-2.0`**：`vendor/fastctx/` 之外为 MIT；vendored FastCtx 为 Apache-2.0。见 [NOTICE](NOTICE)、`vendor/fastctx/LICENSE-APACHE` 与 `vendor/fastctx/NOTICE`。

## 致谢

FastCtx 是 [yc-duan](https://github.com/yc-duan) 的作品。本分发依赖上游的运行时、工具设计与输出纪律。NOTICE 要求逐字转载：

> This product includes FastCtx
> (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
> used under the Apache License 2.0.
>
> FastCtx is redistributed and/or modified here by the maintainer of
> this distribution. Any such change is that maintainer's own work
> and their sole responsibility. It is not endorsed by, not
> supported by, and not attributable to the author of FastCtx, who
> accepts no liability of any kind arising from this distribution or
> from anything built on top of it.

vendor 标识与删除型分发改动记在 [vendor/fastctx/FORK.md](vendor/fastctx/FORK.md) 和 [vendor/fastctx/UPSTREAM.md](vendor/fastctx/UPSTREAM.md)。
