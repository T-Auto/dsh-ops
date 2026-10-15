# dsh-ops

[English](README.en.md) | **中文**

Windows DSH 的性能工具插件：提供独立 bash / PowerShell 7，并用 Rust 重写文件检索与批处理，
减少反复踩 PowerShell 报错所浪费的 token、时间和模型注意力。

> tips：本项目的 ops 是广义 operations（运行操作）的缩写，代指本插件处于 dsh 和系统/代码/文件操作的基础工具位置。本项目不是 operations（运维）插件。

**0.3.0 仅支持 Windows x64**，目标宿主 DSH `0.2.0-rc.2`。原生 Rust 文件/PTC worker 随包携带；PTC 默认关闭，须显式启用。Linux/macOS/ARM64 留待后续版本。见 [PTC 设计与使用](docs/native-ptc.md)。

---

## 核心特性

- （全平台）使用 Rust 编写的一组工具，用于改善 AI 报错循环、强迫思考不交付、注意力涣散的问题，并以渐进式披露减少系统 prompt 的工具定义占用：加速任务运行，减少不必要的输入输出，减少报错率，以及提供与 DSH 对齐的权限机制。

  在自用 benchmark 中获得了

  - 97% token 减免（开启 ops 插件的 PTC 专用工具 对比 Windows 原装标准模式）
  - 65% token 减免（开启 ops 插件的 PTC 专用工具 对比 Linux 原装 PTC 模式）

  的成绩，并改善了在 DSH 运行的 AI 的智力表现。

- （仅 Windows）按需获取独立 **bash 5.3.15** 和独立 **PowerShell 7.6.6**：安装时 `postinstall` 只补机器上没有的那一个，已有可用 shell 就直接复用（bash 在 `danger-full-access` 下用它，`pwsh` 由宿主自己的 `pwsh-sandbox` 继续提供），让你的 AI 不再和 PowerShell 打架 —— **不修改系统默认终端、PATH 或宿主原有 shell 工具名称**，环境变量安全。

- 独立的 Rust 原生文件工具与安全批处理（**默认关闭**，须显式启用），见 [组件参考](docs/组件参考.md)。

- 未来会加入一系列 docx、pdf 处理轻量化的好用 Rust 工具，均可开关，不占用上下文。

<img width="1603" height="1028" alt="247c1326cca5b66e60d330c3f32150e2" src="https://github.com/user-attachments/assets/7c9ba485-5323-42a2-b5a8-6dcda07f91c4" />

> 配图由作者自行更换或删除。

执行顺序：**工具包 → bash → PowerShell 7**。

---

## 快速开始

### 前置条件

- **Node.js `^22.19 || >=24`**（`package.json` 的 `engines` 要求）
- Windows x64
- 目标 DSH 应用已初始化

### 安装

**方式一：官方插件市场（推荐）**

在目标 DSH 应用的插件市场中输入 npm 包名 **`dsh-ops`**，安装后选择启用。安装归属于当前运行的 profile，桌面端为 `desktop`。

**方式二：npm 一键安装**

```console
npx --yes dsh-ops@latest install --profile desktop
```

必须显式选择目标 profile；`tui` 映射到 **dsh-TUI 产品的 `dsh-tui` profile**，不是旧的 `tui` 目录。请先初始化目标应用。

桌面端必须使用桌面应用自带的 CLI；默认探测 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。安装在其它位置时加 `--dsh-cli "<安装目录>\resources\runtime\cli\bin\dsh.cmd"`。

> ⚠️ **`node_modules/@dsh-ops/` 下没有 `bash-win32-x64` 或 `pwsh-win32-x64` 不是安装损坏。** 这两个载荷由本包的 `postinstall`（`postinstall.mjs`）按需安装：机器上已有可用 shell 就不重复下载；registry 未同步该平台包、或安装脚本被跳过时，`postinstall` 只打印一行提示，安装仍以退出码 0 结束。`fastctx-win32-x64` 仍是精确钉版的**可选依赖**（`optionalDependencies`），registry 未同步时包管理器会静默跳过它。需要钉版副本（例如受限模式要用它）时跑 `dsh-ops provision-shells --bash --pwsh`，它不经 registry 直接取上游发布件。

> **不要**用 `allowSystemShellFallback: true` 绕过：那是安全姿态降级（改用未固定摘要的系统 bash），且首次升级启动的配置迁移会把它改回 `false`。

> **`bashPath` 仅在 `danger-full-access` 下生效**：只读/工作区内修改模式只运行固定摘要的随包或 provision 的 bash，自带 Git for Windows 会按设计返回 `EXECUTOR_UNAVAILABLE`，不要靠它绕过受限模式问题。见 [配置参考](docs/配置参考.md)。

> 普通 DSH CLI 不能管理保留的 `desktop` profile；不要把它与桌面自带入口混淆。

详情与兜底办法见 [常见问题](docs/常见问题.md)。

### 卸载与查看状态

```console
npx --yes dsh-ops@latest status --profile desktop
npx --yes dsh-ops@latest uninstall --profile desktop
```

把 `desktop` 换成 `web` 或 `tui` 即可。

---

## 组件

Bundle 声明四个组件，分别启停，首次安装默认开启前两个：

| 组件 | 介绍 | 默认 | 发布的工具 |
| --- | --- | --- | --- |
| `dsh-ops/shell` | 将默认终端改为 bash，以及 bash 覆盖不到时提供 PowerShell 7 | 开 | `ops_bash`；宿主 `pwsh` 使用随包 PowerShell 7 |
| `dsh-ops/file` | 更快、更高性能、输出更精简更省 token 的 Rust 文件检索 | 开 | 四个文件工具 |
| `dsh-ops/background` | 为科研仿真、模型训练及其他长进程后台任务提供托管 | 关 | 启动、输出、列出、终止后台任务 |
| `dsh-ops/ptc` | 独立 Rust 安全批处理和有界结果引用，仅纯 PTC 会话加载 | 关 | `ops_batch`、`ops_result` |

“默认终端改为 bash”指模型提示优先使用 `ops_bash`，**不修改系统默认终端、PATH 或宿主原有 shell 工具名称**。

工具的完整参数、配置项与权限要求见 [组件参考](docs/组件参考.md) 与 [配置参考](docs/配置参考.md)。

> 配置迁移的完成标记：完成后重启/热加载不再覆盖；你之后主动改回 `true` 会被保留。不要删除迁移标记，否则会重新自检。

---

## 详细文档

| 想了解 | 看这里 |
| --- | --- |
| 安装、更新、卸载的完整流程与全部选项 | [docs/使用指南.md](docs/使用指南.md) |
| 配置项逐个说明、哪个键属于哪个组件 | [docs/配置参考.md](docs/配置参考.md) |
| 四个组件分别发布什么工具、参数与权限 | [docs/组件参考.md](docs/组件参考.md) |
| 报错怎么读、装不上怎么办、常见问题 | [docs/常见问题.md](docs/常见问题.md) |
| 原生 PTC 的设计与使用 | [docs/native-ptc.md](docs/native-ptc.md) |
| 版本变更历史 | [CHANGELOG.md](CHANGELOG.md) |
| 来源与载荷许可记录 | [PROVENANCE.md](PROVENANCE.md) |

---

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
