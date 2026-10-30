# Windows 安全回归覆盖

本文逐项记录 PR #128（head d37f9e88c85dfa69f0ca48e1e0244d8fd5c58ca4）的有效增量；不把历史测量当作当前结果。英文：[windows-security-regressions.md](windows-security-regressions.md)。

| 历史项 | 当前断言 |
| --- | --- |
| W1a/b 显式、继承、deny DACL | 现有 file-operations 对写入、编辑、replace、copy 比较完整 SDDL，包含 protected/deny 夹具；不重复移植较弱的用户名/子串断言。 |
| W1c 同用户 owner/group、时间 | 现有 file-metadata 比较完整 SDDL 和 mtime；不同所有者、双账户验收仍需手工。 |
| W1d READONLY replace | windows-security 精确断言 ACCESS_DENIED、结构化 phase/effectState/retry 指引、原字节、READONLY 属性、完整 owner/group/DACL SDDL 均不变且目录无残留；仅清理时重置只读位。 |
| W1e FileShare.None | 子进程仅在获取独占句柄后输出 READY；replace 必须返回结构化 IO_ERROR 且无残留。正常释放并等待子进程退出后检查原字节。另一个允许读取但不共享 DELETE 的句柄用例必须到达原子发布失败：断言 ACCESS_DENIED 和发布阶段消息，释放句柄前后均检查原字节、SDDL 不变且无 staging 残片。 |
| W1g 无争用/争用更新 | 预先持有准确 sidecar 的字节范围锁，确定性强制 REVISION_CONFLICT；释放后真实 replace 只更改一项并删除 sidecar。现有 replace-concurrency/lock-sidecar 和 Rust 单测覆盖协作写者。 |
| W1h 读取兼容性 | 已确认持有 sidecar 锁时真实 inspect、普通文件和目录读取均成功。证明离目标锁不阻碍读取，不声称连续观测生产写者整个发布窗口；不采用概率性大文件读取竞态。 |
| W1f ADS | 现有 file-operations 对 write/copy 断言 METADATA_UNSUPPORTED 闭锁拒绝及流字节保留；新增套件不覆盖跨用户所有权、远端文件系统和所有 ADS/replace 组合。 |

构建后运行：

```console
node test/run.mjs windows-security file-metadata file-operations lock-sidecar replace-concurrency
```

runner 在所有平台发现新增套件；非 Windows 明确 exit 77，verify-gate 在允许 skip 集合与 strict runner 环境中仅加入此准确平台例外。Windows 不允许新增套件 skip，缺 worker 也不可被当作通过；不重试操作失败或并发失败。

未移植 PR #128 的 harness 删除重试：显式释放句柄并等待子进程关闭，避免已知夹具竞态，不扩大公共清理行为。对当前已知 Windows worker 契约精确限定错误码，不以任意非空系统错误当作成功。
