# dsh-ops

**中文** | [English](README.en.md)

解决 Windows 下 DSH 反复使用 PowerShell 报错造成的 token、时间和模型注意力浪费。本插件的三个主要功能提供：

- 提供独立 **bash 5.3.15** 并优先使用bash，让你的AI不再和PowerShell打架
- 独立 **PowerShell 7.6.6**，用于必要的 Windows 原生操作，沿用宿主 `pwsh` 工具。PowerShell 7 比自带的 PowerShell 5 也有不少优化
- 一些 Rust 编写的性能更好的，更快的读取、查找、替换工具，加速任务运行，减少不必要的输入输出。由于部分工具不经过 DSH 的受限终端后端，命令与后台任务工具只在**完全权限**时启用。

执行顺序：**工具包 → bash → PowerShell 7**。bash 报错在 bash 内修正，不随意换 shell，不混用两套语法。

仅支持 **Windows x64**；目标宿主 DSH `0.2.0-rc.2`。

## Beta 测试版候选

`0.2.5-beta.1` 增加「上下文自动压缩」及其组件配置入口，默认阈值 50%。它仅计划发布到 npm 的 `beta` 标签；`latest` 保持正式版，不自动给普通用户升级。发布状态以 registry 查询为准，发布前不能据此认定包已在线。

发布后在插件市场指定 **`dsh-ops@0.2.5-beta.1`**、选择 npm 官方源。精确指定版本**不会绕过** pnpm 的发布冷却策略；如被拦截，应等待冷却期结束或由用户对该精确版本设置豁免，不删除锁文件、不关闭全局供应链检查。安装后完全退出并重启应用，确认主包版本与四个组件。

## 安装、更新、卸载

### 官方插件市场

在目标 DSH 应用的插件市场中输入 npm 包名 **`dsh-ops@0.2.4`**，安装后选择启用。安装归属于当前运行的 profile，桌面端为 `desktop`。发布包依赖完整 FastCtx、bash 和 PowerShell 7 载荷；不使用安装脚本下载，不改系统 PATH。

注：新发布版本暂时明确写 dsh-ops@0.2.4，避免 pnpm 安全冷却期使裸包名选择旧版本。

### npm 一键安装

```console
npx --yes dsh-ops@latest install --profile desktop
npx --yes dsh-ops@latest install --profile web
npx --yes dsh-ops@latest install --profile tui
```

必须显式选择目标 profile；`tui` 映射到 **dsh-TUI 产品的 `dsh-tui` profile**，不是旧的 `tui` 目录。请先初始化目标应用。该入口委托官方 DSH CLI 安装，不另写一套 profile 锁与回滚逻辑。

桌面端必须使用桌面应用自带的 CLI；默认探测 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。安装在其它位置时加 `--dsh-cli "<安装目录>\resources\runtime\cli\bin\dsh.cmd"`。Web/TUI 需要可用的 DSH CLI，可同样显式指定。

也可以直接使用官方命令：

```console
dsh plugin --profile web add dsh-ops
dsh plugin --profile dsh-tui add dsh-ops
"<桌面安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-ops
```

普通 DSH CLI 不能管理保留的 `desktop` profile；不要把它与桌面自带入口混淆。

**更新**：重新运行相同的 `npx --yes dsh-ops@latest install --profile ...`，或用官方 CLI `add dsh-ops@latest`。按应用提示重载；替换已加载代码时重启应用。

当前版本 `0.2.4` 支持三个独立组件；bash 参数 schema 修复和自定义图标保留。三个二进制依赖继续使用 `0.2.1`，它们会自动安装，不影响主插件版本。新发布版本可能受桌面 pnpm 的 24 小时安全冷却策略影响：如果市场分析版号与安装结果不一致，指定 `dsh-ops@0.2.4` 并选择 npm 官方源，确认实际版本后完全退出并重启。原始载荷记录见 [docs/release-0.2.1.md](docs/release-0.2.1.md)。

**卸载与查看状态**：

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

把 `desktop` 换成 `web` 或 `tui` 即可。也可在市场卸载，或执行官方 `dsh plugin --profile ... remove dsh-ops`。二进制随 profile 的插件依赖管理；卸载移除依赖引用，不误删系统 shell、其它 profile 的副本或包管理器共享缓存。

旧版显式 provision 的 `<DSH_HOME>/dsh-ops/` 文件需单独清理：`npx --yes dsh-ops@latest uninstall --yes`。默认不删 `~/.fastctx/` 持久状态；需要时显式加 `--purge-fastctx`。关闭后台组件会等待已发出的调用，然后尝试终止该组件当前连接记住的自有任务；失败会告警。断线丢失归属的旧任务及单纯降权不保证终止，先处理自己的任务。

## 组件开关与提示词

官方市场显示四个组件，分别启停，首次安装默认开启 shell、file 和自动压缩：

| 组件 | 介绍 | 默认 | 发布的工具 |
| --- | --- | --- | --- |
| `dsh-ops-bash & powershell 7` | 将默认终端改为bash，以及bash覆盖不到时提供powershell7 | 开 | `ops_bash`；宿主 `pwsh` 使用随包 PowerShell 7 |
| `dsh-ops-file` | 更快、更高性能、输出更精简更省token的rust文件检索 | 开 | 四个文件工具 |
| `dsh-ops-background` | 为科研仿真、模型训练及其他长进程后台任务提供托管 | 关 | 启动、输出、列出、终止后台任务 |
| `上下文自动压缩` | Web 占用高于可设置阈值时，空闲后调用宿主 `/compact` 服务 | 开 | 自动策略，不新增模型工具 |

“默认终端改为 bash”指模型提示优先使用 `ops_bash`，**不修改系统默认终端、PATH 或宿主原有 shell 工具名称**。Shell 组件开时，通过官方配置生命周期临时指定 `pwsh-sandbox` 的 PowerShell 7 路径；关时按执行器最新原配置恢复，不写 profile 配置。执行器配置切换不代表取消已在运行的宿主命令。

提示词注册为独立运行时段，**不写 AGENTS.md**：Shell 关就撤销 bash/pwsh 路由；文件关就撤销检索说明；后台关就不发布后台工具及自有 job 指导。文件与后台共享一个插件拥有的 FastCtx 连接，关闭其中一个不关闭另一个。默认仅新增五个工具，不发布重复前台 `ops_run`。这些改变减少固定声明成本，**不保证任意任务总 token 降低**。极简预设会覆盖附加 system sections；PTC 模式经 SDK 调用底层工具，权限门不变。

## 配置方式与工具列表

**Beta 测试版新增组件**：在上面的「包含的组件」中打开「上下文自动压缩」的配置入口，设置阈值（默认 **50%**）、冷却（120 秒）、超时（120 秒）。严格高于阈值、正常会话进入空闲后才触发，不打断运行中的工具；保存使用宿主 profile 持久化和版本冲突检查。压缩可能调用模型并产生费用。关闭组件会取消并等待它自己启动的压缩，不取消用户任务。该组件属于 `0.2.5-beta.1` 测试版候选，已安装的正式版 npm `0.2.4` 不含它；是否已发布请查 npm。详见[安全边界与验证记录](docs/auto-compact.md)。

在 DSH 的配置编辑器中找到对应的 `dsh-ops/shell`、`dsh-ops/file` 或 `dsh-ops/background` 行，调整 `config` 后保存；未知配置键会点名报错。也可直接在市场切换组件。主要配置：

```yaml
config:
  # background component only; its market row is disabled by default
  enableShellTools: true
  publishBashTool: true
  promptPolicy: true
  toolCallTimeoutMs: 300000
  required: false
  shellPolicy: advise
  allowSystemShellFallback: true
  # binaryPath: 'C:\tools\fastctx.exe'
  # bashPath: 'C:\tools\bash.exe'
```

- `enableShellTools`：后台组件的部署开关，开启仍须会话 `danger-full-access` 才发布四个后台工具；文件组件不发布命令工具。
- `publishBashTool`：是否发布 `ops_bash`，同样要求完全权限和宿主 subprocess 服务。
- `promptPolicy`：是否注入该组件的运行时说明；可用 `extraGuidance` 追加指导。
- `toolCallTimeoutMs`：FastCtx RPC 等待超时，不代表服务端工作已终止。
- `required`：运行时不可用时是否拒绝激活。
- `shellPolicy`：默认 `advise`；`deny-host-shell` 拒绝 `deniedHostTools` 列表中的宿主 shell（默认 `[pwsh, bash, pwsh_persistent]`）。这也会禁用第三层 pwsh，谨慎开启。
- `binaryPath` / `bashPath`：可选显式路径；不可用时报错，不悄悄换执行器。一般无需配置。

| 工具 | 用途 | 完全权限要求 |
| --- | --- | --- |
| `ops_inspect_local_file` | 批量文本范围、编码、PDF 文本、hex | 无命令权限门¹ |
| `ops_grep` | Rust 正则搜索、多文件过滤、计数/摘要 | 无命令权限门¹ |
| `ops_glob` | 多模式找路径，支持排除 | 无命令权限门¹ |
| `ops_replace` | 跨文件批量替换；精确编辑仍用宿主 edit | 无命令权限门¹ |
| `ops_bash` | 优先的通用 bash 命令执行器 | 是 |
| `ops_run_background` | 启动后台任务 | 是 |
| `ops_job_output` / `ops_job_list` / `ops_job_kill` | 查看、列出、停止当前会话启动的任务 | 是 |
| 宿主 `pwsh` | 使用随包 PowerShell 7 的 Windows 原生操作 | 沿用宿主策略 |

¹ **文件工具不是宿主文件系统沙箱。** 它们未接入 DSH 的受限文件后端，尤其 `ops_replace` 没有 workspace confinement。不要把该插件视为不可信受限环境的安全方案。图片交给宿主 `read_image`，插件不会假装已看过图片。

命令工具随会话权限变化发布/撤销，调用前重查权限。后台 job 按会话和当前连接隔离；断线后不能重新认领旧任务。[手动验证清单](docs/manual-validation.md)与[schema 测量](docs/schema-measurement.md)记录了验证范围，不构成运行时无缺陷保证。

## 许可证

插件源码分发采用 **`MIT AND Apache-2.0`**：`vendor/fastctx/` 之外为 MIT；vendored FastCtx 为 Apache-2.0。见 [NOTICE](NOTICE)、`vendor/fastctx/LICENSE-APACHE` 与 `vendor/fastctx/NOTICE`。

独立的 Windows 载荷包另按上游组件许可证分发：Git for Windows 包含 GPL 等许可组件，PowerShell 包含 MIT 与第三方组件。其原始许可证、声明及来源记录随载荷保留；插件的 MIT 许可不替代这些许可。详见 [PROVENANCE.md](PROVENANCE.md)。

## 致谢

Rust 工具基于 [yc-duan](https://github.com/yc-duan) 的 Codex 插件 FastCtx 并使用其源代码。vendor 标识与删除型分发改动记在 [vendor/fastctx/FORK.md](vendor/fastctx/FORK.md) 和 [vendor/fastctx/UPSTREAM.md](vendor/fastctx/UPSTREAM.md)。需要转载的 FastCtx 声明如下：

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
