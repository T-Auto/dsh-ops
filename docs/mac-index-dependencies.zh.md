# ops-mac-index 依赖评审

`native/crates/ops-mac-index` 是 `ops-index` 数据源边界的 macOS 生产者：读取目录树与逐条元数据，
不打开文件内容、不启动进程、也不替调用方做授权。它只有一个第三方依赖 `rayon`，声明在
`[target.'cfg(target_os = "macos")'.dependencies]` 下；crate 本身是
`#![cfg(target_os = "macos")]`（在其他平台是空库），因此 Linux/Windows 的 workspace 构建既不编译
crate 正文，也不编译 `rayon`。遍历是 `std::fs::read_dir` 递归，`rayon` 只负责并行兄弟目录与逐条
`stat`。本文是该 crate 的依赖台账：每个新增依赖都记录精确版本、crates.io 发布时间
（2026-11-04 UTC+08 依据 crates.io API 核对）与引入理由。完整许可证正文见
[`licenses/mac-index/THIRD-PARTY-NOTICES.txt`](../licenses/mac-index/THIRD-PARTY-NOTICES.txt)。

## 运行时依赖（1 个，仅 macOS）

| crate | 精确版本 | 发布时间（UTC） | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `rayon` | `=1.12.0` | 2026-04-14 | MIT OR Apache-2.0 | 冷枚举的工作共享（M1）：并行扫描兄弟目录、并行映射每条收集项的 `stat`。#423 实测 `symlink_metadata` 占一次 walk 的 71–87 %，正是值得并行的那部分。只在 `src/walk.rs` 使用；`ops-index` 永不依赖它。 |

精确 pin。`rayon-core` 1.13.0 的 MSRV 为 1.80，workspace 地板是 1.88，因此该 pin 不会静默抬高地板。

## 当前 lock 中的传递依赖（5 个）

除上面的 `rayon` 外，同一 PR 提交的 lockfile 还解析出下列包。在可选择时本项目选用 MIT。

| 包 | 版本 | 发布时间（UTC） | 许可证 | 作用 |
| --- | --- | --- | --- | --- |
| `rayon-core` | 1.13.0 | 2025-08-12 | MIT OR Apache-2.0 | `rayon` 背后的线程池与 join 原语 |
| `either` | 1.19.0 | 2026-10-06 | MIT OR Apache-2.0 | `rayon` 使用的迭代器辅助 |
| `crossbeam-deque` | 0.8.8 | 2026-09-05 | MIT OR Apache-2.0 | `rayon-core` 背后的工作窃取队列 |
| `crossbeam-epoch` | 0.9.21 | 2026-09-05 | MIT OR Apache-2.0 | `crossbeam-deque` 的 epoch 回收 |
| `crossbeam-utils` | 0.8.23 | 2026-09-05 | MIT OR Apache-2.0 | 上述包的原子操作与缓存行辅助 |

## 为什么遍历用 `std::fs::read_dir` 而不是 `walkdir`

`reports/deps.md` §3.10 建议**不**引入 `walkdir`、改用 `std::fs::read_dir`：按路径字符串遍历会新增
一个依赖，而其遍历语义同样要接受搜索路径已有的句柄边界审查。本 crate 遵循该建议。M1（#609）的
第一版点名了 `walkdir`；切片随后更新，PR #619 现在把冷枚举实现为 `read_dir` 递归 + `rayon`
并行兄弟目录与逐条映射。只剩 `rayon`，且它在 #584 白名单内。

数据源必须保持的语义并不需要第三方遍历库：递归用 `max_depth` 限深；不跟随符号链接（`read_dir`
的条目自带文件类型，`symlink_metadata` 提供大小/mtime）；root 自身的符号链接像任何按路径打开一样
被跟随；不可读目录让整次枚举失败，而不是静默截断。

## 仍然生效的规则

- `ops-index` 不依赖任何平台 crate，也不依赖 `rayon`：trait 所有者保持纯净，OS 工作归平台 crate。
- 无 `unsafe`（crate 首行 `#![forbid(unsafe_code)]`）、无 `cfg(any(...))`、无 Windows API、无
  `goz_core::` 导入、不复制 goz 源文件。
- 7 天规则：`rayon` 与上述每个传递包在本 PR 之前均已发布满 7 天。
- 未改动任何安全设置；workspace 仍以 `--locked` 构建。
