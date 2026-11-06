# ops-win-index 依赖评审

`native/crates/ops-win-index` 是 #584 设计的 Windows 平台数据源。它的 crate 根是
`#![cfg(windows)]`，全部依赖位于 `[target.'cfg(windows)'.dependencies]`，因此 Linux/macOS
构建只编译空库、构建期不解析任何 Windows 包。lockfile 仍会记录 Windows 目标包（Cargo 锁定所有
目标），所以 workspace 的 `--locked` 检查同样覆盖它们。

## 可选 feature：`win-index`（#718）

`ops-win-index` **默认不参与编译**。`ops-search` 把它声明为可选依赖，挂在 `win-index` feature 下
（`default = []`），因为 `usn-journal-rs` 会发起 COM 调用，使链接后的 worker 导入
`OLEAUT32.dll`；默认的 Windows 安装必须在没有该依赖的情况下启动。未启用 feature 时
`platform_source()` 在 Windows 上返回 `NullSource`，所有搜索继续走 live walk，计数不变。

仅在评估 W1 冷枚举时显式启用：

```console
cargo build --release --features win-index            # 在 native/ 下
cargo build --release --features ops-search/win-index # 在工作区根目录
npm run build:ptc                                     # 同步已 staged 的 runtime
```

默认 Windows worker 证据（交叉编译 `x86_64-pc-windows-gnu`，2026-11-06）：**7,817,886 字节**，sha256
`dadad4db93ed6559facbb00bfd541f2f0fadb573f772fc7df6911236a6435006`；PE 导入表为
`advapi32.dll`、`api-ms-win-core-synch-l1-2-0.dll`、`bcryptprimitives.dll`、`kernel32.dll`、
`msvcrt.dll`、`ntdll.dll`、`userenv.dll`、`ws2_32.dll` —— **没有 `oleaut32.dll` / `ole32.dll`**。
同一构建加上 `--features ops-search/win-index` 后为 **8,014,093 字节** 且导入 `oleaut32.dll`，
说明正是该 feature 门控了 COM 依赖。Linux 构建机上没有 `dumpbin`；等价命令是
`x86_64-w64-mingw32-objdump -p <exe>` 及其 DLL 导入表。

本文是该 crate 的依赖台账：直接依赖给出精确版本与 crates.io 发布时间（2026-11-04 UTC+08 依据
crates.io API 核对），传递依赖由 lockfile 固定。完整许可证正文见
[`licenses/windows-index/THIRD-PARTY-NOTICES.txt`](../licenses/windows-index/THIRD-PARTY-NOTICES.txt)。

## 直接依赖（1 个）

| crate | 精确版本 | 发布时间（UTC） | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `usn-journal-rs` | `=0.5.0` | 2026-10-13 | MIT | 为 W1 的 MFT 冷枚举提供 `FSCTL_ENUM_USN_DATA` 安全封装，W2 起提供 USN 变更日志封装。本切片唯一的 Win32 代码都在它内部：本 crate 保持 `#![forbid(unsafe_code)]`，源码不出现任何裸 Windows 类型。运行期需要 Administrator 权限，未提权即按文档回退。MSRV 1.88，与本 crate 地板相同。 |

该依赖必须 target-gate，因为 `usn-journal-rs` 自身包含
`#[cfg(not(windows))] compile_error!`；它绝不能出现在 `ops-index` 或其它平台无关 crate。

## Windows 目标实际解析的传递依赖

这些包不是本 crate 编写的，来自 `usn-journal-rs` 及其 Windows bindings。版本取自
`native/Cargo.lock`，许可证字段取自解包后的 crate 源码，不做推测。

| 包 | 版本 | 发布时间（UTC） | 许可证 | 作用 |
| --- | --- | --- | --- | --- |
| `foldhash` | 0.2.0 | 2025-08-23 | Zlib | `lru` 内部哈希表的哈希实现 |
| `log` | 0.4.34 | 2026-08-22 | MIT OR Apache-2.0 | `usn-journal-rs` 使用的日志门面 |
| `lru` | 0.18.5 | 2026-09-23 | MIT | 实时路径解析器的目录缓存 |
| `syn` | 2.0.119 | 2026-07-15 | MIT OR Apache-2.0 | 下列派生宏的 proc-macro 解析器 |
| `thiserror` | 2.0.21 | 2026-09-23 | MIT OR Apache-2.0 | `usn-journal-rs` 使用的错误派生 |
| `thiserror-impl` | 2.0.21 | 2026-09-23 | MIT OR Apache-2.0 | `thiserror` 的派生实现 |
| `windows` | 0.62.2 | 2025-10-06 | MIT OR Apache-2.0 | `usn-journal-rs` 使用的 Win32 bindings |
| `windows-collections` | 0.3.2 | 2025-10-06 | MIT OR Apache-2.0 | `windows` bindings 的集合类型 |
| `windows-core` | 0.62.2 | 2025-10-06 | MIT OR Apache-2.0 | `windows` 的核心 trait 与句柄 |
| `windows-future` | 0.3.2 | 2025-10-06 | MIT OR Apache-2.0 | `windows` bindings 的异步支撑 |
| `windows-implement` | 0.60.2 | 2025-10-06 | MIT OR Apache-2.0 | `windows` 的派生支持 |
| `windows-interface` | 0.59.3 | 2025-10-06 | MIT OR Apache-2.0 | `windows` 的接口宏 |
| `windows-numerics` | 0.3.1 | 2025-10-06 | MIT OR Apache-2.0 | `windows` 的数值类型 |
| `windows-result` | 0.4.1 | 2025-10-06 | MIT OR Apache-2.0 | `windows` 的结果与错误类型 |
| `windows-strings` | 0.5.1 | 2025-10-06 | MIT OR Apache-2.0 | `windows` bindings 的字符串类型 |
| `windows-threading` | 0.2.1 | 2025-10-06 | MIT OR Apache-2.0 | `windows` 的线程辅助 |

`log` 特意固定在 0.4.34（2026-08-22）：准备本切片时最新解析结果是 0.4.35（2026-10-30），
发布不足七天，因此 lockfile 保留旧版本，与文档解析依赖评审采用同一纪律。上表所有版本在
2026-11-04 UTC+08 均已发布满七天，且无 yanked 版本。

本切片之前已存在于 `native/Cargo.lock` 的包（`proc-macro2`、`quote`、`unicode-ident`、
`windows-link`、`windows-targets`、`windows-sys` 0.61）由引入它们的 crate 记录；本切片不新增
它们的大版本副本。

## MSRV、安全与平台边界

- `usn-journal-rs` 0.5.0 及所有新入 lock 的包声明的 `rust-version` 都不高于 1.88（workspace
  地板）。CI 使用 1.97.1 并以 `--locked` 构建。
- Win32 面收敛在 `usn-journal-rs` 内；`ops-win-index` 只调用其安全 API，源码不出现裸 `windows`
  类型，因此保持 `#![forbid(unsafe_code)]`。
- `windows` 0.62 与 workspace 既有的 `windows-sys` 0.61 并存，只影响 Windows 编译时间与 lock
  体积；Linux/macOS 构建两者都不编译。
- W1 不支持 ReFS：128 位 file id 无法放入 `ops_index::FileKey` 的 64 位 file 半区，遇到扩展 id
  时切片返回 `Unsupported`。
- 运行期权限：打开卷句柄需要 Administrator。未提权时 source 报 `Unsupported`，调用方回退自己的
  遍历；不伪造错误。
