# ops-mac-index 依赖评审

`native/crates/ops-mac-index` 是 `ops-index` 数据源边界的 macOS 生产者：读取目录树与逐条元数据，
不打开文件内容、不启动进程、也不替调用方做授权。它有三个第三方依赖，全部声明在
`[target.'cfg(target_os = "macos")'.dependencies]` 下：两个 `objc2` 绑定 crate 供 FSEvents
流使用（M2）。crate 本身是 `#![cfg(target_os = "macos")]`（在其他平台是空库），因此
Linux/Windows 的 workspace 构建既不编译 crate 正文，也不编译这些依赖。遍历是
`std::fs::read_dir` 递归，`rayon` 只负责并行兄弟目录与逐条 `stat`。本文是该 crate 的依赖台账：
每个新增依赖都记录精确版本、crates.io 发布时间（2026-11-04 UTC+08 依据 crates.io API 核对）与
引入理由。完整许可证正文见
[`licenses/mac-index/THIRD-PARTY-NOTICES.txt`](../licenses/mac-index/THIRD-PARTY-NOTICES.txt)。

## 运行时依赖（3 个，仅 macOS）

| crate | 精确版本 | 发布时间（UTC） | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `rayon` | `=1.12.0` | 2026-04-14 | MIT OR Apache-2.0 | 冷枚举的工作共享（M1）：并行扫描兄弟目录、并行映射每条收集项的 `stat`。#423 实测 `symlink_metadata` 占一次 walk 的 71–87 %，正是值得并行的那部分。只在 `src/walk.rs` 使用；`ops-index` 永不依赖它。 |
| `objc2-core-services` | `=0.3.2` | 2025-10-04 15:47:08 | Zlib OR Apache-2.0 OR MIT | FSEvents C API 的生成绑定（M2）：`FSEventStreamCreate`/`Start`/`Stop`/`Invalidate`/`Release`、回调与 context 类型、event id 与两套 flag。只启用 `FSEvents` 框架 feature，不启用该 crate 默认的“全部框架”集合。 |
| `objc2-core-foundation` | `=0.3.2` | 2025-10-04 15:46:51 | Zlib OR Apache-2.0 OR MIT | 该 API 收发的 CoreFoundation 类型：路径列表与 run loop mode 用 `CFArray`/`CFString`，扩展事件数据用 `CFDictionary`/`CFNumber`。feature 限定为 `std`、`CFString`、`CFDictionary`、`CFNumber`；`CFArray`、`CFDate`、`CFRunLoop`、`CFUUID` 由上面的 `FSEvents` feature 带入。 |

三者均为精确 pin。`rayon-core` 1.13.0 的 MSRV 为 1.80，workspace 地板是 1.88，因此 `rayon` 的 pin
不会静默抬高地板。`objc2` 0.3 线是这些绑定已发布的最新系列、声明 MSRV 1.71，版本范围只可能拉进
未来重命名 Apple 框架绑定的 0.4。

## M2 的 lock 增量（2 个包）

`objc2-core-services` 的 `FSEvents` feature 只依赖 `objc2-core-foundation`，而所选 CoreFoundation
feature 除 `bitflags` 外不依赖任何新包；`bitflags 2.13.2` 早已由 `rustix`/`nix` 锁定。因此 M2 的
lockfile 恰好只增加两个包：

| 包 | 版本 | 发布时间（UTC） | 许可证 |
| --- | --- | --- | --- |
| `objc2-core-services` | 0.3.2 | 2025-10-04 15:47:08 | Zlib OR Apache-2.0 OR MIT |
| `objc2-core-foundation` | 0.3.2 | 2025-10-04 15:46:51 | Zlib OR Apache-2.0 OR MIT |

不会引入 `dispatch2`、`block2`、`objc2`、异步运行时或构建脚本。

## 为什么 FSEvents 绑定用 `objc2`（M2）

- **手写 `extern` 会复制一份需要维护的 ABI 面。** FSEvents 是建立在 CoreFoundation 对象上的 C
  API：回调签名、紧凑的 `FSEventStreamContext`、扩展数据字典的 key 都必须与 SDK 头文件逐字节
  一致，静默的不一致表现为内存破坏而不是编译错误。
- **`fsevent-stream` 维持否决。** `reports/deps.md` §4.2 以“async-only（tokio `Stream`）、2022 年
  起无维护、落后 CoreFoundation 两代”为由拒绝它。本 crate 需要在一次 worker 调用内做同步、有界的
  批量收取，而这正是框架 C API 的形状。
- **接线仍按目标平台收口。** crate 只在 macOS 编译，依赖也只为该目标解析，Linux/Windows 的
  workspace 构建不受影响。
- **unsafe 面是一个受审模块。** `src/ffi.rs` 独占所有指针与框架调用；crate 根 `deny(unsafe_code)`
  并只对该模块 `allow`，`unsafe_op_in_unsafe_fn` 也是 deny（每个 block 单独选择进入），每个
  block 都有 SAFETY 注释。`src/fsevents.rs` 是安全 Rust，对外 API（`EventStream`、`Event`、
  `Batch`）不暴露指针。
- **调度有意使用已弃用的 run loop 入口。** `FSEventStreamScheduleWithRunLoop` 被标记为
  deprecated（推荐 dispatch queue），但本 crate 只从调用方自己的 run loop 驱动一段有界批量，并且
  故意不是 `Send`；换成 dispatch queue 会为了同样的单线程投递把 `dispatch2`（连带
  `block2`/`objc2`）拖进 lockfile。调用点带 `#[allow(deprecated)]` 与注释，让这次弃用是记录在案
  的决策，而不是被所有人忽略的警告。

## 当前 lock 中的传递依赖（5 个）

除上面三个直接依赖外，lockfile 还解析出下列包。M2 不再增加包。在可选择时本项目选用 MIT。

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

- `ops-index` 不依赖任何平台 crate，也不依赖 `rayon`/`objc2`：trait 所有者保持纯净，OS 工作归
  平台 crate。
- 本 crate 不是“无 unsafe”，而是“一个受审的孤岛”：除 `src/ffi.rs` 外一律 deny，`ffi` 没有公共
  API，且每个 block 都有 SAFETY 注释。
- 无 `cfg(any(...))`、无 Windows API、无 `goz_core::` 导入、不复制 goz 源文件。唯一的 `cfg` 是
  crate 级 `target_os = "macos"` 门。
- 7 天规则：上述每个包在本 PR 之前均已发布满 7 天（`objc2` 0.3.2 对发布于 2025-10-04，早于一年
  以上）。
- 未改动任何安全设置；workspace 仍以 `--locked` 构建。
