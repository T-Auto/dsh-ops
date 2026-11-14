# 会话 Shell 性能工作

English: [Session shell performance work](session-shell-performance.md)。跟踪 #872；
基线为 PR #933，`06c22a65b93e89d3a452724dc0a2e813f6b80af9`。

## Windows 通道唤醒测量 — 2026-11-14

验收目标仍为 p50 ≤1 ms / p95 ≤3 ms，**尚未达标**。第一轮在通道封存时通知待连接操作；
第二轮同时改为等待读取线程句柄，去除 join 检查间的睡眠。两轮均保留物理输出排空、认证
EOF、受检查的溢写结算，以及释放缓冲区前等待已取消的重叠 I/O 完成。

| 配对轮次 | 基线空命令 p50 / p95 | 候选空命令 p50 / p95 | 基线 printf p50 / p95 | 候选 printf p50 / p95 |
| --- | --- | --- | --- | --- |
| 连接唤醒 | 46.48 / 48.77 ms | 16.05 / 17.22 ms | 46.61 / 49.45 ms | 16.54 / 28.25 ms |
| 连接唤醒及线程句柄等待 | 46.33 / 51.10 ms | 9.04 / 10.30 ms | 46.64 / 117.02 ms | 9.48 / 13.10 ms |

每轮在同一 Windows x64 主机先运行基线再运行候选：Ryzen 7 6800HS、15.2 GiB RAM、
Node 26.12.1、Rust 1.97.1 release 构建；与维护者的 i9-13900H 不同。
空命令预热 30 次后采样 300 次，printf 采样 100 次。完整运行保留原始 256 MiB 大块 I/O、
管道与朴素载荷对照，计时期间没有并发构建或测试。单轮配对不能证明尾延迟稳定；第二轮
基线 printf 的长尾如实报告，未过滤。

[原始报告与可执行 harness](../bench/probes/872/channel-wakeup-evidence/) 保留测量证据。
`compare.mjs` 仅增加可配置的可执行文件路径及 `OPS_DRIVER_SOURCE` 记录。设置 `OPS_ROOT`、
`OPS_NIU`、`OPS_DRIVER`、`OPS_DRIVER_SOURCE`、`REPORT`、`ONLY_NIU=1`、`SAMPLES=300`、
`WARMUP=30`、`BULK_MB=256`，使用 Node 运行。两个 driver 必须使用独立 Cargo target 目录；
早期共用目录曾复用出与基线相同的候选二进制，该无效候选已在测量前排除。

可执行文件 SHA-256：

- Stock Niubash：`7ec3ec04ce91bae64c23d7150e6b16574e9d91df8fcf0df997006e2b37bf2f1e`。
- 基线 driver：`d311330e52aaec8eb9e352762be3304bfa3cc79638abd0e49fa7a82aaa0a3920`。
- 连接唤醒：`66aaa96ce4067d8409d7a6d336ff1296d2c11dec3ae9d6e7105ff1beb4f01bdd`。
- 连接唤醒及线程等待：`13e554dc3ac5cef0ea7f16ac94a1acd1b850abd211a2458a01997e5b158db4c2`。

报告的 `head` 标识未变更的宿主工作树，`driverSource` 与 `driverSha256` 标识原生候选。
沿用的 harness 限制文字不能代替架构事实：生产实现使用私有命名管道，各对照臂宿主开销
相等尚未获证实。这些数字不含宿主编排，也未测量 106 操作场景、冷启动、Linux 或完整功能
验收；两轮场景合计仍为**未测量**。通道池化、driver 完成轮询、prompt 装配和文件重复 I/O
仍待完成。

附件 `scenario.out` 的合计为 17.1923 / 120.6023 / 0.7497 秒，与正文的
7.38 / 73.14 / 0.69 秒不一致。`suite.out` 的读取测量针对不存在的文件，虽提供修正脚本，
但没有修正结果。在据此进行端到端验收前，需要厘清这些差异。
