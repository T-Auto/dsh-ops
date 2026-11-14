# Windows 会话资格交接

English: [Windows session qualification handoff](windows-session-qualification.md).

本 2026-11-14 交接记录 [#872](https://github.com/T-Auto/dsh-ops/issues/872) 的 Windows 优先审查范围。
它描述未发布采用提交 `511f9920044c1aa38d7ca8443e1a6e26f7bc61c5` 的本地资格验证，
不表示运行时已经发布或整个 issue 已验收。合格候选清单已记录供审查，stock pin 仍仅支持 fresh；
[会话契约](会话Shell.md) 仍以合格的完整运行时为前提。

## 已完成的 Windows 证据

| 检查 | 记录结果 |
| --- | --- |
| 干净 `511f992` 上的完整发行 gate | `node scripts/verify-gate.mjs --skip-install --target win32-x64` 通过：739 项 Rust 测试通过、0 失败、8 忽略；263 个测试套件通过、0 失败、4 个许可跳过；92 项 manifest 检查通过。 |
| 四个真实 DSH CLI 实例 | 使用生产包根激活和公开 fresh/session/Jobs 工具，共用临时 home/workspace：61 个事件、53 个已观察 PID/创建时间身份，紧急清理前存活数为 0。 |
| 静默任务与隔离 | 观察到的静默区间为 310047.7863 ms。对已建立的进程范围验证状态隔离、定向取消、控制断连、内核崩溃、正常关闭和强制宿主死亡。 |
| 公开 Jobs 返回 | 该功能运行中观察到约 17–29 ms 的返回时间。这些个别观察不是延迟分位数、基线对照或性能验收。 |
| 进程冷启动激活 | `872-activation-windows-511f992/report.json` 的 10 组基线/候选配对全部通过。每组使用新的 Node 进程和 fixture home；未清空 OS 缓存，配对中未运行命令工作负载。 |

四个许可跳过套件为 `linux-attributes`、`linux-shell`、`tui-host` 和 `tui-native`。
Release worker SHA-256 为
`36f2a4c47abdf54c82569703d29c8887d6f40a7a22ab0d05be70f24eb06b7c4a`。
以下本地回执保存在仓库外：

| 回执 | SHA-256 |
| --- | --- |
| `reset-runtime-adoption-511f992-full-windows-gate.json` | `215a18bc05eddbe4f89e5be6fbad7ebc5159f71abc94ec1da2c1641a9d3d2ac0` |
| `1794627071145-report.json` | `a08a28d82ebc4571c7bdaa03f3bc22373716be7590ff1e4aa6a41c3ae6904072` |
| `872-activation-windows-511f992/report.json` | `1ff04ec013e231907381d679d9680f53a3d8bf17a4a582dd430cf635a1b94454` |

## 延后的验收与分发

200 样本基准按要求的交接期限停止，仍未完成。冷启动激活配对和功能计时不能证明性能提升；
完整交错工作负载及资源对照仍需完成。

Linux 资格验证延后：本地 WSL 执行错误阻止了计划运行，内核停止响应后的宿主死亡回收缺口仍未关闭。
Windows 证据覆盖已建立的进程范围，不能消除公开宿主外层从创建进程到加入 Job 之间的崩溃窗口。
边界详见[常驻所有权与证据](常驻内核.md)。

本交接不发布运行时归档、软件包、发行资产或 tag，合格运行时发布仍待完成。
可以基于已完成的 Windows 证据继续审查；Linux 所有权、Windows 外层启动窗口和完整性能验收
仍是明确的后续工作，不因本交接而豁免。
