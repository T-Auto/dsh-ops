# Windows 运行时证据

载荷能解析但命令仍失败时，请记录实际加载的 DSH core/Desktop、OPS、Bash 版本、
安装来源、Native/PTC、会话沙箱档及可执行文件完整路径。使用受影响 profile 已安装
的副本运行 `ladder --json`，不要用另一份 npx 缓存。提交前脱敏用户名、令牌与私有命令数据。

## 载荷兼容只证明什么

`shells.bash.restricted.compatible` 比较所选 MSYS 载荷与 IPC 兼容回执，
不会启动命令、查询子进程令牌、检查可执行文件完整性标签、验证杀软决定或测试宿主 runner。
`available: true` 同样只表示解析到了 shell。这些是静态检查，不是端到端健康结论。

## 完全权限与 Low 子进程（#446、#463）

OPS 在 `danger-full-access` 下跳过 `sandbox.confine`，但 Windows 仍可能让带 Low
标签的可执行文件以 Low 令牌启动。Low 进程通常不能写 Medium 对象，即使 DACL 允许；
无标签对象按 Medium 处理。这与会话选择器是两回事。
[Microsoft 强制完整性控制文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)
说明了进程创建与写入限制。

在同一调用环境对实际使用的文件收集只读证据：

```powershell
whoami.exe /groups
icacls.exe '<实际 bash.exe 路径>'
icacls.exe '<工作区根目录>'
icacls.exe '<编辑失败的既有文件>'
Get-FileHash -LiteralPath '<实际 msys-2.0.dll 路径>' -Algorithm SHA256
```

在受影响的 `ops_bash` 中执行 `MSYS2_ARG_CONV_EXCL='*' whoami.exe /groups`，
记录子进程令牌，保留完整的完整性 SID（`S-1-16-4096` 为 Low，`S-1-16-8192` 为 Medium），
与同会话的宿主 shell 对照。无法读取标签表示未知，不能判为 Medium。

同一工作区可同时含新建的 Low 文件与旧的 Medium 文件，因此“新建成功、改旧失败”
必须同时记录两个文件的标签。哈希相同不代表安全元数据相同。Bash 最后返回 0 也不能
证明前面的命令成功，后续成功命令可覆盖最终退出码；请保留 stderr 并验证实际效果。

不要把递归重标记 DSH_HOME 或工作区当作诊断步骤；由管理员或宿主维护者核对预期边界。
显式 `bashPath` 是权威选择，不再自动跟随 provision 升级；移动载荷也不是受限模式兼容性的通用修复。

## MSYS 共享对象与启动状态（#409、#417、#480）

`CreateFileMapping S-<用户 SID>.<n>, Win32 error 5` 表示共享对象访问失败。
#389 代理修复为受限 Low 令牌下**新建**的特定 IPC 对象准备权限，不修复既有外部对象的 DACL。
停止 DSH 不会停止独立外部 MSYS 持有者。记录精确载荷/根目录、自己拥有的普通令牌进程
是否仍存活、stderr、退出值及受限正向对照。只停止自己拥有的任务，不要杀死所有 Bash
或重写外部对象 ACL 来让测试通过。

`3221225794` 与 `-1073741502` 都表示 `0xC0000142`；数字本身不说明哪个 DLL
失败，也不证明哪个进程已执行命令。不支持用普通令牌手动启动 staged 受限载荷：其 IPC
代理要求受限 Low 令牌。请通过 OPS 工具测试宿主实际 confinement 路径，保留完整 stderr，
并与同策略下的宿主 shell 对照。
普通应用的退出码 49 不应被直接归为 MSYS 启动失败。

## 杀软时间相关性（#439）

收集安全产品/版本、时间戳、事件/动作、精确被拦截程序或文件、父进程和对应 OPS callId。
对该文件计算哈希，并以 `Get-AuthenticodeSignature -LiteralPath '<文件>'` 记录签名状态。
区分安装/硬链接事件、程序执行和工作区写入。未签名文件数量或接近的时间戳不能单独证明原因。
取证时不要关闭防护或整树加入信任区；只有事件明确指向具体路径和操作，才能确认与 OPS 的关系。

## Heredoc 与自动审批反馈（#425、#426）

Heredoc 请给出包含真实换行、结尾换行和引号的完整命令，实际 Python/Bash 版本及
stdout/stderr/exit/status。在同工具、策略与呈现下比较最小 heredoc、`python -c`
和临时 `.py`。终端成功不等于 Desktop/PTC 成功；来源未确定时保留应用退出值。

自动审批请给出脱敏的最小规则及提供者、工具名、callId、参数、请求档/当前档、审批请求与结果。
说明实际是多次询问、拒绝、取消还是卡住。受控审批服务测试不能证明真实规则提供者集成正常；
请在隔离 profile 复现，不改真实审批策略。

缺少这些精确证据时，应记录“未复现、缺少证据”，不能标为“已修复”。本文不会修复宿主
令牌构造、安全产品决策、文件标签或尚未观察到的审批冲突。
