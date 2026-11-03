# Linux 索引依赖评审

状态：`ops-linux-index` L1（#606），评审日期 2026-11-04。`native/Cargo.lock` 变化时必须重跑本评审。

## 范围

`ops-linux-index` 是 `ops-index` `FsDataSource` 边界的 Linux 实现：把活目录树变成索引可用的
`Candidate`。它只新增一个直接依赖 `rayon` 与五个传递依赖，全部位于
`[target.'cfg(target_os = "linux")'.dependencies]` 之下，macOS/Windows 构建既不编译也不链接它们。

`walkdir` 明确**不引入**（issue #606；`reports/deps.md` §3.10）：此处 `std::fs::read_dir` 递归约
四十行即可，且避免第二条按路径字符串遍历、绕过现有 cap-std/rustix 句柄边界。`notify` 属于 L2，
不在本片。

## 直接依赖

| crate | 版本 | 许可证 | MSRV | 发布（UTC） | 用途 |
| --- | --- | --- | --- | --- | --- |
| `rayon` | `=1.12.0` | MIT OR Apache-2.0 | 1.80 | 2026-04-14 | 按目录并行的冷枚举；遍历是 IO 瓶颈，并发读取并 lstat 同级目录正是本片要交付的能力 |

精确 pin 遵循 #584 的依赖白名单。rayon 只出现在平台 crate 内，`ops-index` 的任何类型都不会因此
多出 `Send`/`Sync` 约束。

## 传递依赖（由 `Cargo.lock` 固定）

| crate | 版本 | 许可证 | MSRV | 发布（UTC） | 作用 |
| --- | --- | --- | --- | --- | --- |
| `rayon-core` | 1.13.0 | MIT OR Apache-2.0 | 1.80 | 2025-08-12 | rayon 的线程池与 scoped join |
| `crossbeam-deque` | 0.8.8 | MIT OR Apache-2.0 | 1.61 | 2026-09-05 | rayon 底层的工作窃取队列 |
| `crossbeam-epoch` | 0.9.21 | MIT OR Apache-2.0 | 1.61 | 2026-09-05 | 基于 epoch 的内存回收 |
| `crossbeam-utils` | 0.8.23 | MIT OR Apache-2.0 | 1.60 | 2026-09-05 | 原子操作与 scoped thread 辅助 |
| `either` | 1.19.0 | MIT OR Apache-2.0 | 1.63.0 | 2026-10-06 | rayon 使用的迭代器选择辅助 |

`native/Cargo.lock` 新增以上六个包以及 `ops-linux-index` 这个 workspace 成员，不删除任何包。

## 七天发布期核对

所有新增版本都在本次评审（2026-11-04）之前超过七天发布；最近的是 `either` 1.19.0
（2026-10-06，29 天前）。七天窗口内发布的版本不得引入；若后续 lock 更新拉入此类版本，必须重跑
本表并停下。

## 为什么 `reports/deps.md` §3.5 推迟 rayon，这里却引入

那份报告推迟的是 `ops-index` 本身：记录到索引的变换是纯计算、当时没有大规模 fixture，且 rayon
会把 `Send`/`Sync` 约束泄进索引 API。本 crate 形状相反：冷枚举受系统调用约束，目录并发正是本片
要交付的能力，且并行性被平台 crate 边界挡住。#584 的白名单本就允许 `rayon 1.12.0` 用于此目的。

## 安全与范围属性

- `ops-linux-index` 是 `#![forbid(unsafe_code)]`；新增 crate 均无 build script、过程宏或原生库。
- 依赖边只存在于 Linux；macOS/Windows 上 `cargo test --workspace` 只为该成员构建一个空 crate。
- 未新增任何安全设置，无 registry/patch 覆盖。
- 本片不引入 `walkdir`、`notify`、`inotify`。

## 许可证义务

六个 crate 均为 `MIT OR Apache-2.0` 双许可。完整许可证文本收录在
`licenses/linux-index/THIRD-PARTY-NOTICES`；dsh-ops 自身仍为 MIT，无需修改 NOTICE。

## 安全公告核对

本仓库目前没有 `cargo-audit`/`cargo-deny` 门禁，因此本次评审是对上述精确锁定版本做版本与许可证
审计。`native/Cargo.lock` 变化时必须重跑；将来若新增门禁，必须把该双许可对加入 allow-list。
