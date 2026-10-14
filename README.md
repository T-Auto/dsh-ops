# dsh-ops

**中文** | [English](README.en.md)

致力优化dsh插件token效率，提升ai性能，减少token消耗，减少任务总时间的插件，解决 Windows 下 DSH 反复使用 PowerShell 报错造成的 token、时间和模型注意力浪费，会持续更新。

> tips：本项目的 ops 是广义 operations （运行操作）的缩写，代指本插件处于dsh和系统/代码/文件操作的基础工具位置。本项目不是 operations（运维）插件。

本插件的主要功能：

- （全平台）一些可以极大改善AI报错循环、强迫思考不交付、注意力涣散的易用工具，使用rust编写，性能更好，渐进式纰漏以减少系统prompt的工具定义占用，加速任务运行，减少不必要的输入输出，减少报错率来减少运行过程中的token浪费，以及提供与 DSH 对齐的权限机制。当前npm版本仅发布windows，但源码已支持跨平台。在自用benchmark中获得了
  - 97% token减免（开启ops插件的ptc专用工具 对比 windows原装标准模式）
  - 65% token减免（开启ops插件的ptc专用工具 对比 linux 原装ptc模式）
  
  的成绩并改善了在dsh运行的ai的智力表现
- （仅windows）提供独立 **bash 5.3.15** 和 独立 **PowerShell 7.6.6** ，优先使用bash，必要时回退pwsh7，让你的AI不再和PowerShell打架——不改变系统path路径和终端指向，环境变量安全




## 安装、更新、卸载

### 官方插件市场

在目标 DSH 应用的插件市场中输入 npm 包名 **`dsh-ops`**，安装后选择启用。安装归属于当前运行的 profile，桌面端为 `desktop`。发布包依赖完整 FastCtx、bash 和 PowerShell 7 载荷；不使用安装脚本下载，不改系统 PATH。

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

`0.3.0` 新增独立原生 Rust PTC 组件：`ops_batch` 安全批处理、`ops_result` 有界引用／投影，适配 DSH 权限、沙箱、取消，提供逐项持久清单与保守恢复。三个 Windows 载荷依赖仍固定 `0.2.1`，无需重复发布。PTC 组件默认关闭，须显式启用；发布包已含 Windows x64 worker，见 [使用说明](docs/native-ptc.md)。

**卸载与查看状态**：

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

把 `desktop` 换成 `web` 或 `tui` 即可。也可在市场卸载，或执行官方 `dsh plugin --profile ... remove dsh-ops`。二进制随 profile 的插件依赖管理；卸载移除依赖引用，不误删系统 shell、其它 profile 的副本或包管理器共享缓存。

旧版显式 provision 的 `<DSH_HOME>/dsh-ops/` 文件需单独清理：`npx --yes dsh-ops@latest uninstall --yes`。默认不删 `~/.fastctx/` 持久状态；需要时显式加 `--purge-fastctx`。关闭后台组件会等待已发出的调用，然后尝试终止该组件当前连接记住的自有任务；失败会告警。断线丢失归属的旧任务及单纯降权不保证终止，先处理自己的任务。

## 已知问题

**`node_modules/@dsh-ops/` 下没有 `bash-win32-x64` 不是安装损坏。** 三个载荷都是精确钉版的**可选依赖**（`optionalDependencies`）：若你的 registry 未同步该平台包的对应版本，包管理器会**静默跳过**它——安装仍以退出码 0 结束，且不打印任何指向缺包的警告。

实测（2026-10-12）：`registry.npmmirror.com` 上 `@dsh-ops/bash-win32-x64` 的 `dist-tags.latest = 0.0.0-stage`、`versions` 只有 `0.0.0-stage`；官方源 `registry.npmjs.org` 为 `0.2.1`。走镜像的 `npm view @dsh-ops/bash-win32-x64 version` 因此会打印误导性的旧版本号，不能拿来判断载荷是否可用。镜像补齐后本节自然过期，下面是自证与兜底的办法。

**首选兜底**：`provision-shells` 绕过 registry，直接取上游 GitHub Release 的钉版资产，校验 sha256 后解包，并写 `.provisioned.json` receipt。

```console
npx --yes dsh-ops@latest provision-shells --bash
```

需要代理时（`HTTPS_PROXY` 会被显式交给 curl 的 `--proxy`，同时随环境继承）：

```console
:: cmd
set HTTPS_PROXY=http://127.0.0.1:<clash-port>
npx --yes dsh-ops@latest provision-shells --bash
```

```console
# PowerShell
$env:HTTPS_PROXY = 'http://127.0.0.1:<clash-port>'
npx --yes dsh-ops@latest provision-shells --bash
```

**核对**请跑 profile 自己那份副本：`ladder` 只报告**执行它的那份包**的随包梯级，`npx … ladder` 检查的是 npx 缓存副本，结论与你的 profile 无关。

```console
node "%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-ops\bin\dsh-ops.mjs" ladder
```

provisioned 副本在 `<DSH_HOME>/dsh-ops/shells`（跨 profile 共享，provision 一次对同机所有 profile 生效），解析时优先于随包副本，`ladder` 会给出 `source: provisioned`。

**不要**用 `allowSystemShellFallback: true` 绕过：那是安全姿态降级（改用未固定摘要的系统 bash），且首次升级启动的配置迁移会把它改回 `false`。

## 组件开关与提示词

Bundle 声明四个组件，分别启停，首次安装默认开启前两个旧组件；PTC 增强须显式启用并提供原生 worker：

| 组件 | 介绍 | 默认 | 发布的工具 |
| --- | --- | --- | --- |
| `dsh-ops-bash & powershell 7` | 将默认终端改为bash，以及bash覆盖不到时提供powershell7 | 开 | `ops_bash`；宿主 `pwsh` 使用随包 PowerShell 7 |
| `dsh-ops-file` | 更快、更高性能、输出更精简更省token的rust文件检索 | 开 | 四个文件工具 |
| `dsh-ops-background` | 为科研仿真、模型训练及其他长进程后台任务提供托管 | 关 | 启动、输出、列出、终止后台任务 |
| `dsh-ops-ptc` | 独立 Rust 安全批处理和有界结果引用，仅纯 PTC 会话加载 | 关 | `ops_batch`、`ops_result` |

“默认终端改为 bash”指模型提示优先使用 `ops_bash`，**不修改系统默认终端、PATH 或宿主原有 shell 工具名称**。Shell 组件开时，通过官方配置生命周期临时指定 `pwsh-sandbox` 的 PowerShell 7 路径；关时按执行器最新原配置恢复，不写 profile 配置。执行器配置切换不代表取消已在运行的宿主命令。

提示词注册为独立运行时段，**不写 AGENTS.md**：Shell 关就撤销 bash/pwsh 路由；文件关就撤销原生文件说明；后台关就不发布后台工具及自有 job 指导。文件组件使用独立 Rust worker；FastCtx 仅由默认关闭的 background 组件保留。默认新增四个原生文件工具和 `ops_bash`，不发布重复前台 `ops_run`。这些改变减少固定声明成本。极简预设会覆盖附加 system sections；PTC 模式经 SDK 调用底层工具，权限门不变。


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

## Star 趋势

[![Star 趋势图](https://api.star-history.com/svg?repos=T-Auto/dsh-ops&type=Date)](https://star-history.com/#T-Auto/dsh-ops&Date)
