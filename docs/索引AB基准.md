# 索引与遍历 A/B 证据（G4）

英文：[Index-versus-walk A/B evidence](benchmark-index-ab.md)。设计：[#584](https://github.com/T-Auto/dsh-ops/issues/584)；切片：[#614](https://github.com/T-Auto/dsh-ops/issues/614)；研究问题：[#423](https://github.com/T-Auto/dsh-ops/issues/423)。

本文是一份可复现的证据，回答一个问题：**在同一语料、同一 worker 二进制下，可选的文件名索引是否让 `ops_glob` 快于遍历，它又要付出多少内存？** 它是证据，不是性能门禁；本文不改变任何默认值，下面的数字也都不是 CI 阈值。

## 比较什么

同一语料、同一 worker 二进制、同一请求形状。两臂只差宿主在操作者开启 `indexCache` 时加入可信 envelope 的那一个字段：

| 臂 | 请求 | 宿主等价配置 |
| --- | --- | --- |
| walk | 无 `cache_dir` | `indexCache: false`（默认） |
| index | `cache_dir: <dir>` | `indexCache: true`，缓存以 0700 准备 |

请求是只读 `glob`，`limit: 10000`、`outputMode: paths`，因此两臂都不会被分页上限截断。计时范围是 worker 进程从 spawn 到 exit：包含两臂共同承担的进程启动成本，也包含索引路径自身的工作。

harness 位于 `bench/index-ab`，入口为 `node bench/cli.mjs index-ab`，直接使用发布二进制，不需要跑两个 profile、不需要模型、也不需要宿主构建。

## 本次记录的范围

在记录时的 revision 上，平台 source 已接线但**未 Ready**：`ops-linux-index` 的 `Phase::Unwatched` 返回 `SourceState::Unsupported`，`ops-win-index`/`ops-mac-index` 在 watcher 切片落地前同理，`ops-search` 对任何非 `Ready` 状态都逐字节回退到遍历。所以下面测的是**索引开关在回退时的成本**，不是一个已启用的索引：

- 每条查询字节相同是预期结果，并且被断言；
- 时间差是这道开关的开销，不是收益；
- 内存差是额外代码路径，不是已建好的索引；
- 真正的 A/B（warm 快照 + 增量 watcher）要在 L2/M2/W2 与持久化存储接线后，用同一命令、同一语料哈希重跑。

状态证据：`native/crates/ops-linux-index/src/source.rs`（阶段表，`Unwatched` 即 `Unsupported`）、`native/crates/ops-search/src/index_source.rs`，以及 `native/crates/ops-search/src/index_source_tests.rs` 中的 `a_ready_source_produces_the_same_glob_output` 与 `a_cache_directory_without_a_ready_source_falls_back_to_the_walk`。

## 语料

由 `bench/index-ab/plan.mjs` 按固定配方生成：seed `0xA1B2C3D4`，12 个 package × 7 个目录 × 18 个文件，另加根文件；内容长度 48..4096 字节。刻意放入 `.hidden/`、`node_modules/`、`target/`：遍历契约会排除它们，它们的体积能证明 A/B 没有偷偷扩大扫描面。

| 事实 | 值 |
| --- | --- |
| 文件 / 目录 | 1,552 / 154 |
| 内容字节 | 3,159,745 |
| 深度 | 4 |
| 被排除目录 | `.hidden`、`node_modules`、`target` |
| 树 sha256 | `6af8888faa0ec08dfdb4c376d24197ff6ee8ed0cb1654d721fcc441aadd018cd` |

哈希覆盖每个相对路径、大小与内容哈希，是后续运行必须复现的身份。生成配方固定在 `plan.mjs`，不写死在文档里，避免描述与实现悄悄漂移。

## 查询

| id | 模式 | 覆盖什么 |
| --- | --- | --- |
| ext-rs | `**/*.rs` | 全树扩展名 glob |
| basename-json | `*.json` | 基名 glob |
| nested-js | `packages/**/src/**/*.js` | 深层锚定路径 |
| name-mod-rs | `**/mod.rs` | 任意深度重复基名 |
| no-hit | `**/*.nomatch` | 完整覆盖但无命中 |

## 方法

1. 冷态：每条查询、每臂的第一次调用（**不**丢弃页缓存——那需要 root，所以这是首次触达，不是冷缓存；文档如实标注）。
2. 预热：每条查询、每臂丢弃 2 轮。
3. 测量：每条查询、每臂 9 轮，逐轮交替臂顺序（AB/BA）抵消漂移；报告同时保留独立中位数与**配对**的逐轮差值中位数。
4. 峰值 RSS 取自 `/proc/<pid>/status:VmHWM`，运行期间每 2 ms 采样（进程太短时记 `n/a`）。
5. 通过/失败只看两臂字节是否相同；耗时是证据，不是判决。

## 记录结果

| 事实 | 值 |
| --- | --- |
| 平台 | linux-x64 |
| node | v24.21.0 |
| 内核 | 6.12.113+deb13-amd64 |
| CPU / 内存 | 16 / 15,706 MiB |
| 记录 revision | `4b6d66a4656514ceccd39f10dead81adeb244a91`（G3 base；报告 JSON 的 `revision` 字段是运行时的 checkout HEAD） |
| worker sha256 | `9de72d53af9196da1cec911799fc33f4c5246f142f26439e279391957877a63e` |

### 冷态首次调用（ms）

| 查询 | walk | index | 差值 |
| --- | ---: | ---: | ---: |
| ext-rs | 12.92 | 8.84 | -4.08 |
| basename-json | 11.93 | 10.90 | -1.03 |
| nested-js | 9.44 | 11.02 | +1.58 |
| name-mod-rs | 8.89 | 8.69 | -0.20 |
| no-hit | 14.31 | 13.48 | -0.83 |

每臂仅一个样本：冷态差值被首次触达与进程启动噪声主导，因此单独列出、不参与结论。

### 热态重复调用（9 轮，p95）

| 查询 | walk 中位 | walk p95 | index 中位 | index p95 | 差值 | 配对差值 | 字节相同 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| ext-rs | 13.51 | 17.21 | 13.81 | 15.51 | +0.3 | -1.98 | 是 |
| basename-json | 11.77 | 16.01 | 13.68 | 16.26 | +1.91 | +1.43 | 是 |
| nested-js | 13.84 | 16.65 | 13.24 | 18.23 | -0.6 | -0.32 | 是 |
| name-mod-rs | 10.68 | 15.79 | 12.82 | 15.96 | +2.14 | +3.89 | 是 |
| no-hit | 12.71 | 16.98 | 10.74 | 17.18 | -1.97 | +0.2 | 是 |

配对差值在 -2.0 到 +3.9 ms 之间且没有一致方向；两臂都被进程启动与遍历本身主导。最宽的一对（name-mod-rs，+3.89 ms）不可重复（其独立中位差为 +2.14 ms，而 ext-rs 与 no-hit 为负），因此本运行既不能证明索引侧收益，也不能证明稳定的回退成本。

### RSS 与预算

| 查询 | walk 中位 RSS (kB) | index 中位 RSS (kB) | 差值 (kB) |
| --- | ---: | ---: | ---: |
| ext-rs | 3,944 | 3,988 | +44 |
| basename-json | 3,880 | 3,980 | +100 |
| nested-js | 3,884 | 3,980 | +96 |
| name-mod-rs | 3,932 | 3,968 | +36 |
| no-hit | 3,876 | 3,968 | +92 |

| 预算事实 | 值 |
| --- | --- |
| 该语料的索引载荷估算（57 B/条 + 名字字节 + 头） | 0.11 MiB |
| 持久化切片强制的快照上限（`MAX_SNAPSHOT_BYTES`） | 256 MiB |
| 该语料规模下的余量 | 255.89 MiB |

RSS 差值为 +36..+100 kB，方向与额外代码路径一致，但远低于 256 MiB 上限；本栈没有构建任何索引载荷。1,552 文件的语料无法压到上限，上限由持久化切片自己的测试覆盖。

## 结论

- **输出**：每条查询的冷态与热态调用都字节相同，索引开关不改变答案。
- **热态延迟**：无可重复差值；10-14 ms 调用上的配对差值为 -2.0..+3.9 ms，方向不一致。
- **内存**：本栈中没有可测的索引载荷，差值 +36..+100 kB，1,552 文件规模余量 255.89 MiB。
- **收益**：今天无法测出——G3 中索引从未变为 `Ready`，从这些数字宣称提速是不诚实的。
- **go/no-go**：保持 `indexCache` 可选，**不默认开启**。只有当 watcher + 持久化切片能返回 `Ready` 后，用同一命令重跑：要求字节相同、热态中位数超出配对噪声带、RSS 差值落在预算内。在那之前遍历仍是唯一生产路径。

## #423 四项条件逐条

| 条件 | 证据 |
| --- | --- |
| 1. 内存/RSS 有界并与预算对照 | 上面 RSS 表；`ops-index`/持久化的 57 B/条与 256 MiB 上限；余量表 |
| 2. 授权与身份在缓存之外重新校验 | `walk_indexed` 在访问 source 前先用 `authorize_path`；`candidates::revalidate` 对每个候选重新 stat；两臂都应用 `deny_roots`/凭据名策略；测试见 `native/crates/ops-search/src/candidates_tests.rs`、`index_source_tests.rs` |
| 3. 陈旧/覆盖不全不得伪装成完整答案 | 只有 `SourceState::Ready` 才能供数，其余一律回退遍历；第 2 页继承遍历域（s1/s2 cursor kind），跨 kind 续页被拒绝；`truncated` 始终显式。测试：`a_cache_directory_without_a_ready_source_falls_back_to_the_walk`、`index_source_tests.rs` 的 cursor 域用例 |
| 4. 资源配额、取消与清理存在 | `EnumBudget` 继承 scan 剩余时间；`MAX_WALK_ENTRIES`/`MAX_DEPTH` 限制遍历；宿主缓存准备在 EACCES/ENOSPC 时返回 null 且不虚构路径；卸载清理与锁测试在 `native/crates/ops-index/src/snapshot/{gc,lock}_tests.rs`，宿主测试在 `test/index-cache.test.mjs` |

权限变化、文件变化、失效、排除规则与取消的验证计划列在 #423 验收清单；对应的负向断言随 watcher 切片落地。本文不把它们冒充成已测量的结论。

## 复现

```console
npm run build
cargo build --release --locked --manifest-path native/Cargo.toml
node bench/cli.mjs index-ab --self-test
node bench/cli.mjs index-ab --fresh --repeat 9 --warmup 2 \
  --worker native/target/release/dsh-ops-worker \
  --out bench/runs/index-ab/evidence.json \
  --markdown bench/runs/index-ab/evidence.md
```

- `--root <dir>` 用操作者准备好的真实树替代生成语料；`--fresh` 只重建生成语料。
- `--out`/`--markdown` 拒绝覆盖：一次运行/revision 只归档一份证据。
- `--dry-run` 只打印解析后的计划、不创建任何东西；`--self-test` 在无 worker、无语料的情况下检查配方确定性、统计与报告形状。
- JSON 带 revision、worker 哈希、语料哈希与每轮原始样本；Markdown 就是上面的表。

## 限制

- 记录运行只有 Linux x64；harness 本身跨平台，但不宣称 Windows/macOS 数字。
- 不丢弃页缓存（无 root）：所谓「冷」是首次触达，文档如实说明。
- 每次调用一个 worker 进程，约 6-8 ms 进程启动计入每个样本；宿主调度被排除，两臂共同承担。
- RSS 是采样值，不是 `wait4` 读数：极短调用记 `n/a`，不猜数字。
- 本栈没有启用索引，数字界定的是开关开销，不是索引价值。

## 非目标

不宣称 MFT/USN 引擎、不引入 daemon、不装管理员服务、不改变默认扫描范围、不做内容搜索承诺（`ops_grep` 仍走遍历）。本切片不改变任何默认值。
