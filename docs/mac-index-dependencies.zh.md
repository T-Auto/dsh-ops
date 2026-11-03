# ops-mac-index 依赖评审

`native/crates/ops-mac-index` 是 `ops-index` 数据源边界的 macOS 生产者：读取目录树与逐条元数据，
不打开文件内容、不启动进程、也不替调用方做授权。它的依赖声明在
`[target.'cfg(target_os = "macos")'.dependencies]` 下，因此 Linux/Windows 的 workspace 构建不会编译
它们；crate 本身是 `#![cfg(target_os = "macos")]`，在其他平台上是一个空库。本文是该 crate 的依赖
台账：每个新增依赖都记录精确版本、crates.io 发布时间（2026-11-04 UTC+08 依据 crates.io API 核对）
与引入理由。完整许可证正文见
[`licenses/mac-index/THIRD-PARTY-NOTICES.txt`](../licenses/mac-index/THIRD-PARTY-NOTICES.txt)。

## 运行时依赖（2 个，仅 macOS）

| crate | 精确版本 | 发布时间（UTC） | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `walkdir` | `=2.5.0` | 2024-03-01 | Unlicense OR MIT | 单根有界冷遍历（M1）。walker 使用 `follow_links(false)`、`min_depth(1)`、`max_depth(budget)`，不跟随后代链接、不越过深度预算。纯 Rust、无构建脚本。 |
| `rayon` | `=1.12.0` | 2026-04-14 | MIT OR Apache-2.0 | 冷枚举中的逐条并行 `stat`（M1）。#423 实测 `symlink_metadata` 占一次 walk 的 71–87 %，正是值得并行的那部分。`rayon` 只在 `src/walk.rs` 使用；`ops-index` 永不依赖它。 |

两者均为精确 pin。`walkdir` 自 2024 年起没有比 2.5.0 更新的发布，版本范围只可能带来一次静默的
edition 上调；`rayon` 1.12.0 的 MSRV（`rayon-core` 1.80，workspace 地板 1.88）仍在地板之内。

## 当前 lock 中的传递依赖（7 个）

除上面两个直接依赖外，同一 PR 提交的 lockfile 还解析出下列包。在可选择时本项目选用 MIT。

| 包 | 版本 | 发布时间（UTC） | 许可证 | 作用 |
| --- | --- | --- | --- | --- |
| `rayon-core` | 1.13.0 | 2025-08-12 | MIT OR Apache-2.0 | `rayon` 背后的线程池与 join 原语 |
| `either` | 1.19.0 | 2026-10-06 | MIT OR Apache-2.0 | `rayon`、`walkdir` 使用的迭代器辅助 |
| `crossbeam-deque` | 0.8.8 | 2026-09-05 | MIT OR Apache-2.0 | `rayon-core` 背后的工作窃取队列 |
| `crossbeam-epoch` | 0.9.21 | 2026-09-05 | MIT OR Apache-2.0 | `crossbeam-deque` 的 epoch 回收 |
| `crossbeam-utils` | 0.8.23 | 2026-09-05 | MIT OR Apache-2.0 | 上述包的原子操作与缓存行辅助 |
| `same-file` | 1.0.6 | 2020-01-11 | Unlicense OR MIT | `walkdir` 内部的文件身份比较 |
| `winapi-util` | 0.1.11 | 2025-09-07 | Unlicense OR MIT | `walkdir` 的 Windows 专用辅助；为 Windows 目标进 lock，macOS/Linux 不编译 |

## 为什么仍然引入 `walkdir`

`reports/deps.md` §3.10 曾建议**不**引入 `walkdir`、改用 `std::fs::read_dir`。切片 issue #609
（“walkdir + rayon 冷启动”）明确要求它，本 crate 就是该切片的实现。两条结论并不矛盾：

- 该报告的反对理由是“按路径字符串遍历会绕过 `cap-std` 句柄边界”。这条理由针对的是**授权**结果的
  代码。本 crate 从不授权：它只产出 `Candidate` 提示，#584 的安全规则 1 要求 `ops-search` 用自己
  的 no-follow 句柄、跳过规则与身份复验逐条重新验证，都不能进入结果集。
- 冷遍历是索引 crate 的内部实现，只有调用方显式调用 `enumerate` 时才会到达（M1 的 `state` 是
  `Unsupported`，因此当前发行路径根本不会走它）。

决策记录：issue #609 评论 “M1 dependency decision”。若平台层之后被要求退回 `read_dir`，只需替换
`src/walk.rs` 的遍历实现；两阶段形状、预算语义与整套测试保持不变。

## 仍然生效的规则

- `ops-index` 不依赖任何平台 crate，也不依赖 `walkdir`/`rayon`：trait 所有者保持纯净，OS 工作归
  平台 crate。
- 无 `unsafe`（crate 首行 `#![forbid(unsafe_code)]`）、无 `cfg(any(...))`、无 Windows API、无
  `goz_core::` 导入、不复制 goz 源文件。
- 7 天规则：上述每个包在本 PR 之前均已发布满 7 天。
- 未改动任何安全设置；workspace 仍以 `--locked` 构建。
