# Bash 与 PowerShell 共存

English: [Bash and PowerShell coexistence](shell-coexistence.md).

`ops_bash` 是独立的 Bash 命令工具。Windows 上由选定的本地 Bash 运行时执行，默认使用 Niubash；不会变成 Linux、WSL 或 PowerShell，也不会改写宿主 OS。内置预设默认仅在 Bash 替代工具可调用时隐藏宿主 PowerShell。

## 默认值与显式选择

- 内置 preset 默认开启 Bash 和 `hidePwsh`；自定义 preset 的 `hidePwsh` 仍默认关闭，不随 `replaceOfficial` 文件工具设置推导。
- `global.hidePwsh` 仍默认开启，但只是允许隐藏的总闸。只有 preset 的隐藏开关开启、总闸允许、Windows 当前 Agent 确实可调用 Bash 且未开启 pwsh7 联动时，才隐藏 `pwsh` 和 `pwsh_persistent`。
- 旧配置中显式保存的 `hidePwsh: false` 或 `true` 均被尊重，不静默迁移；总闸显式关闭可阻止隐藏。Bash 路径缺失或权限/宿主服务使 Bash 无法发布时，保留官方 PowerShell fallback；同时提示词会明确说明该槽位不可用并引用解析的 `source` 与 `detail`（含部署侧修复办法），而不是留下一个空段落让模型以为这里本该没有 Bash。
- `other.pwsh7Link` 开启时保留官方 `pwsh`，让 `dsh-win-pwsh7` 继续管理其 PowerShell 版本。未保存此开关时仍按既有规则检测 companion；显式开/关优先，不要求安装 companion 才能共存。OPS 不修改第三方插件、安装顺序或 profile。

## 提示词与执行契约

OPS 在 Bash 槽位顺序注册自己的 `dsh-ops:tool-bash:<consumer>` 段，仅对实际可调用该工具的 Agent 输出。它不注册或覆盖 `tool:pwsh`；原 PowerShell schema 与提示词仍属于宿主。重载、停用与释放会清理 OPS 工具和段落，不重写共享 registry、不污染其它 Agent。

Bash 使用 Bash 引号、`$VAR`、`$(command)`、重定向和管道。默认 fresh，每次启动独立的非 login shell。`command` 与 `script_path` 二选一，后者指向既有 Bash 脚本。Fresh 的相对 `workdir` 以当前 session 工作目录为基准；Windows 可写 `D:/repo` 或 `/d/repo`，无驱动器的 `/tmp`、`/` 不是 Windows `workdir`。命令内部使用所选 Bash 运行时支持的路径并正确引用空格。

[显式 `execution: "session"`](会话Shell.md) 仅在完整运行时合格且所需常驻能力齐备时可用；默认仍为 `execution: "fresh"`。本公开分支的合格运行时清单为空，因此 stock pin 仍仅支持 fresh，配置不能绕过资格审查。会话模式可用时仅接受 `command`，按精确 Agent/Session 串行执行并保留 cwd、导出变量、函数和 shell 选项。初始化后省略或留空 `workdir` 会保留 shell 的 cwd；显式路径遵循文档中的宿主路径规则。会话命令到达硬期限且已启动时会重置其 shell，不会隐式转交 Jobs；排队超时不会停止无关活动命令。显式 fresh job 不继承会话 shell 状态。

权限仍由宿主 session sandbox 与审批决定，不能换 shell 绕过拒绝。`description` 必填。先检查 `kind`：`foreground` 有 `status`、可能为空的 `exitCode`、stdout/stderr 与失败时的 `failure.code/effectState/retry`；`background` / `promoted` 有 `jobId`，不是执行完成。Fresh 仅有宿主 jobs 时声明后台参数，使用 `job_output` 收集、`job_kill` 停止；没有 jobs 时 fresh 前台超时会停止命令。输出有界，截断与 spill 路径不表示内容完整。没有退出码不能当成功；effects unknown 先查后置状态，不盲目重复。不伪造 PowerShell 的退出 marker。

会话调用方取消保留公开 `ABORTED` 结果，工具卡仍显示取消。确认清理后，`additionalContexts` 携带重置通知；后续调用也会报告此前的状态丢失。两条路径都不重放被打断的命令。输出、重置与清理字段详见会话指南。

回归测试使用真实 Cordis tools / systemPrompt 注册、assemble 和 Bash subprocess，并包含固定版本第三方 bridge（来源与 MIT 许可证见 `test/fixtures/shell-slot-pwsh7/README.md`）；这不是所有未来 companion 版本的兼容保证。没有修改或部署真实 Desktop/Web/profile。
