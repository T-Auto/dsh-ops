# ops-index 依赖评审

`native/crates/ops-index` 是平台无关的库：不调用任何 OS API、不打开文件、不启动进程。它的
运行时依赖只有纯算法，属性测试依赖只在测试构建中使用。本文是该 crate 的依赖台账：每个新增
依赖都记录精确版本、crates.io 发布时间（2026-11-04 UTC+08 依据 crates.io API 核对）与引入理由。
完整许可证正文见 [`licenses/index/THIRD-PARTY-NOTICES.txt`](../licenses/index/THIRD-PARTY-NOTICES.txt)。

## 运行时依赖（2 个）

| crate | 精确版本 | 发布时间（UTC） | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `unicode-normalization` | `=0.1.26` | 2026-10-16 | MIT OR Apache-2.0 AND Unicode-3.0 | 为大小写折叠键做 NFC/NFD 规范化（P1）。APFS/HFS+ 给出 NFD 名字，NTFS/ext4 给出 NFC；不归一化会把同一个名字索引成两条。纯 Rust、无构建脚本、无 OS 调用。 |
| `memchr` | `=2.8.3` | 2026-07-08 | Unlicense OR MIT | 查询预过滤在连续的 folded 名字 arena 上做 SIMD 双向子串搜索（P7）。该版本已通过其它 crate 存在于 `native/Cargo.lock`，因此 lock 只增加一条依赖边、不新增包；可选择的许可中选用 MIT。 |

该 crate 内嵌 Unicode 数据文件，因此许可证除 MIT/Apache-2.0 外还需要 `Unicode-3.0` 标识；在可
选择时本项目选用 MIT。

## 仅测试依赖（1 个）

| crate | 精确版本 | 发布时间（UTC） | 许可证 | 用途 |
| --- | --- | --- | --- | --- |
| `proptest` | `=1.12.0` | 2026-10-10 | MIT OR Apache-2.0 | WTF-8 任意 `u16` 序列往返、解码器对任意字节的完备性（P1）。关闭 `fork`/`timeout`（`default-features = false, features = ["std"]`），Windows CI 不会起子进程。 |

## 后续切片已登记、尚未进入 Cargo.toml/Cargo.lock

设计 #584 允许这些 crate，但每个切片只在使用它的那一片才加入。版本与发布时间先登记在此，后续
切片不必重新论证 7 天规则；每个切片仍需提交 `native/Cargo.lock`，并把 lock 实际解析出来的包
补进 `licenses/index/THIRD-PARTY-NOTICES.txt`。

| crate | 精确版本 | 发布时间（UTC） | 许可证 | 计划用途 |
| --- | --- | --- | --- | --- |
| `hashbrown` | `=0.17.1` | 2026-05-09 | MIT OR Apache-2.0 | 名字 intern 表只存 4 字节 id（P5）。已通过 `indexmap` 存在于 workspace lock。 |
| `rustc-hash` | `=2.1.3` | 2026-07-02 | Apache-2.0 OR MIT | 稀疏 record map 的 `FxHashMap`（P5）。 |
| `rayon` | `=1.12.0` | 2026-04-14 | MIT OR Apache-2.0 | 查询 API 内部确定性的并行名字扫描（P7）。结果按分块顺序合并，绝不按完成顺序。 |

白名单是封闭的：不使用 `zerocopy`（derive 生成 `unsafe impl`，与 crate 级
`#![forbid(unsafe_code)]` 冲突）、`thiserror`、`smallvec`、`regex` 与 `mimalloc`。平台数据源
（`usn-journal-rs`、`notify`）只属于平台 crate，绝不进入本 crate。

## 当前 lock 中的传递依赖

除上面两个直接依赖外，lockfile（随切片 PR 提交）解析出下列包。双许可证在可选择时选 MIT；
`unicode-normalization` 的 Unicode-3.0 正文必须保留。

| 包 | 版本 | 许可证 | 作用 |
| --- | --- | --- | --- |
| `autocfg` | 1.5.1 | Apache-2.0 OR MIT | `num-traits` 的构建脚本 |
| `chacha20` | 0.10.2 | MIT OR Apache-2.0 | `rand` 使用的 RNG |
| `core_detect` | 1.0.0 | MIT OR Apache-2.0 | `cpufeatures` 的 CPU 特性检测 |
| `cpufeatures` | 0.3.1 | MIT OR Apache-2.0 | 运行时特性检测 |
| `num-traits` | 0.2.19 | MIT OR Apache-2.0 | `rand` 的数值 trait |
| `rand` | 0.10.3 | MIT OR Apache-2.0 | `proptest` 的 RNG |
| `rand_core` | 0.10.1 | MIT OR Apache-2.0 | RNG 核心 trait |
| `rand_xorshift` | 0.5.0 | MIT OR Apache-2.0 | `proptest` 的确定性生成器 |
| `tinyvec` | 1.13.3 | MIT OR Apache-2.0 OR Zlib | `unicode-normalization` 内部的小向量 |
| `unarray` | 0.1.4 | MIT OR Apache-2.0 | `proptest` 的数组辅助 |
| `unicode-normalization` | 0.1.26 | MIT OR Apache-2.0 AND Unicode-3.0 | 直接依赖（见上） |
| `proptest` | 1.12.0 | MIT OR Apache-2.0 | 仅测试（见上） |

## MSRV 与解析

`native/Cargo.toml` 声明 `rust-version = "1.88"`，CI 使用固定的 `1.97.1` 工具链。上表所有版本
声明的 `rust-version` 都不高于 1.88；lockfile 入库且命令一律 `--locked`，一次静默的
`cargo update` 无法抬高地板。Cargo 的 MSRV-aware resolver 也不会选高于 workspace 地板的版本。
