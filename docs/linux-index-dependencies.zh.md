# Linux 索引依赖评审

状态：`ops-linux-index` L1（#606）与 L2（#607），评审日期 2026-11-04。`native/Cargo.lock` 变化时必须重跑本评审。

## 范围

`ops-linux-index` 是 `ops-index` `FsDataSource` 边界的 Linux 实现：把活目录树变成索引可用的
`Candidate`。L1 新增一个直接依赖 `rayon` 与五个传递依赖；L2 新增 `notify`、约束 pin 的 `log` 及其闭包。全部位于
`[target.'cfg(target_os = "linux")'.dependencies]` 之下，macOS/Windows 构建既不编译也不链接它们。

`walkdir` 明确**不直接引入**用于枚举（issue #606；`reports/deps.md` §3.10）：此处 `std::fs::read_dir`
递归约四十行即可，且避免第二条按路径字符串遍历、绕过现有 cap-std/rustix 句柄边界。它只作为
L2 `notify` 的非 optional 传递依赖出现（见下文明示）。

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

L1 的六个 crate 均为 `MIT OR Apache-2.0` 双许可。L2 新增 CC0-1.0（`notify`）、ISC
（`inotify`、`inotify-sys`）、Unlicense/MIT（`walkdir`、`same-file`）与两个双许可
（`notify-types`、`libc`），另有 MIT 的 `mio` 与双许可的 `log`，均为宽松许可。完整文本收录在
`licenses/linux-index/THIRD-PARTY-NOTICES.txt`；dsh-ops 自身仍为 MIT，无需修改 NOTICE。


## L2 新增：notify 8.2.1 及其依赖闭包

L2（#607）新增增量监听。直接依赖是 `notify = "=8.2.1"`（CC0-1.0，MSRV 1.85，2026-10-25 发布），
另加一条 `log` 约束 pin：

| crate | 版本 | 许可证 | MSRV | 发布（UTC） | 用途 |
| --- | --- | --- | --- | --- | --- |
| `notify` | 8.2.1 | CC0-1.0 | 1.85 | 2026-10-25 | `RecommendedWatcher`（Linux 上走 inotify）以及降级用的 `PollWatcher` |
| `log` | 0.4.34 | MIT OR Apache-2.0 | 1.71 | 2026-08-22 | 通过 notify 已在用的 facade 记录 watch 降级；pin 用于把解析结果留在七天窗口之外（0.4.35 发布于 2026-10-30） |

### Linux 上实际编译的传递闭包

| crate | 版本 | 许可证 | MSRV | 发布（UTC） | 作用 |
| --- | --- | --- | --- | --- | --- |
| `notify-types` | 2.2.0 | MIT OR Apache-2.0 | **1.88** | 2026-10-27 | 事件与错误类型 |
| `inotify` | 0.11.5 | ISC | 1.70 | 2026-08-14 | Linux 内核事件后端 |
| `inotify-sys` | 0.1.8 | ISC | 未声明 | 2026-07-07 | inotify 原始绑定 |
| `mio` | 1.2.4 | MIT | 1.71 | 2026-10-03 | 后端使用的 poll/事件循环 |
| `libc` | 0.2.190 | MIT OR Apache-2.0 | 1.65 | 2026-10-02 | 系统调用常量 |
| `walkdir` | 2.5.0 | Unlicense/MIT | 未声明 | 2024-03-01 | notify 内部的递归 watch 注册（仅传递依赖） |
| `same-file` | 1.0.6 | Unlicense/MIT | 未声明 | 2020-01-11 | walkdir 的辅助 crate |

`notify-types 2.2.0` 的 MSRV 恰好等于我们的地板 1.88；`Cargo.lock` 入库且 CI 用 `--locked`
运行，因此 lock 更新不会悄悄抬版。七天规则同样适用于 `notify-types`（2026-10-27，距本次评审八天）。

### 传递依赖 `walkdir`（依赖政策的显式例外）

L1 明确不直接引入 `walkdir`（见上）。但 L2 获批的 `notify` 版本把它列为**非 optional** 的
`walkdir ^2.4`，在 Linux 上会被解析（2.5.0）并编译。`ops-linux-index` 从不 import 它，它也
不参与候选枚举或 cap-std 授权路径：notify 只在内部用它注册递归 watch。替代方案（手写 inotify +
轮询、不用 notify）会让 Linux 与 macOS watcher 实现分叉，并丢掉 notify 已验证的 poll 降级；
因此选择这个有记录的例外。若 notify 将来把 `walkdir` 变为可移除，应重新评估。

### 在 lock 中但 Linux 不编译

`Cargo.lock` 还会解析 notify 在其他目标上的依赖，它们不会进入 Linux 产物：
`kqueue 1.2.1`（MIT）、`kqueue-sys 1.1.2`（MIT）、`objc2-core-foundation 0.3.2` 与
`objc2-core-services 0.3.2`（Zlib OR Apache-2.0 OR MIT）、`wasi 0.11.1`（仅 wasm；上游许可是
Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT）、`winapi-util 0.1.11`（Unlicense OR
MIT）。登记于此以便完整核对 lock 差异。

L2 新增 14 条 lock 记录（含 `log`、`inotify*`、`mio`、`notify*`、`walkdir`、`same-file`
以及上述其他目标 crate），不删除任何包。

### L2 安全说明

- `ops-linux-index` 仍无 `unsafe`；`notify`/inotify 的 FFI 收敛在各自 crate 内，未新增安全设置。
- CC0-1.0（`notify`）与 ISC（`inotify`、`inotify-sys`）首次进入仓库许可证集合；两者都是宽松
  许可、无需额外 NOTICE，但全文仍收录在 `licenses/linux-index/THIRD-PARTY-NOTICES.txt`。
- 事件丢失或 watch 无法再可靠归因时会置 rescan 标记；会话绝不把降级后的 watcher 当作已追平
  （见 `src/watch.rs`）。

## 安全公告核对

本仓库目前没有 `cargo-audit`/`cargo-deny` 门禁，因此本次评审是对上述精确锁定版本做版本与许可证
审计。`native/Cargo.lock` 变化时必须重跑；将来若新增门禁，必须把该双许可对加入 allow-list。