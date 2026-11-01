# `read_files` 由进程内应答

`read_files` 不再有原生 worker 臂：`native/crates/ops-files/src/file_many.rs` 已删除，改由
`src/execution/files.ts` 在本进程内用 `engine/parallel-read/` 应答。没有开关——一个读取器，一种行为。

## 为什么删掉那条臂

worker 的成本全在进程创建：1 MiB 的文件，它还没碰到一个字节就花了约 18 ms，同样的事在进程内是 0.3 ms；
24 个小文件是 35 ms 对 1.6 ms。那条臂存在的意义就是读文件，而读文件不需要沙箱进程。

## worker 原来做的事，现在由谁做

The native read had two side effects, both now done on the host side:

| 副作用 | 现在在哪 |
| --- | --- |
| 对每条请求路径做凭据闸门 | 不变，仍在读取之前的 `src/execution/files.ts` |
| 为 read-before-edit 写 `fs/observed` | 每次读成功后由 `emitObserved` 发出 |

观测这一半不是可选项：没有它，模型可以编辑一个它从未“读过”的文件。进程内分支发出的正是 worker 读取
原本会产生的那个 `fs/observed` 事件。

## 成本

| 请求 | 改动前（worker） | 现在（进程内） |
| --- | --- | --- |
| 24 文件 × 30 行 | 35.0 ms | 1.6 ms |
| 8 文件 × 800 行 | 22.4 ms | 1.1 ms |
| 1 文件 × 20 000 行 | 18.4 ms | 0.3 ms |

字节数不变：每文件 200 行的 schema 默认值与 96 KiB 的页预算都与 worker 当时的返回对齐，同一请求返回同样的文本。
