# PTC 引擎 2.1.1 —— 以源码入库并实测

引擎以源码形态入库 `engine/ptc/`（26 个文件、含声明 194 KiB），不再走压缩包。`src/ptc/engine.ts` 是
类型化入口；`@ast-grep/napi` 本就是本包的依赖，无需额外安装。

## 实测环境与结果

环境：Windows 11 / x64，Node 24.22.1，`dsh-ops-worker.exe` 由本仓库构建
（`cargo build --release --locked`，22.5 s）。

| 路径 | 耗时 | 说明 |
| --- | --- | --- |
| 400 行 TS 文件的进程内 locate | **热态 0.13 ms** | 首次要付解析成本（14.7 ms） |
| 同一请求走原生 worker | 18–24 ms | 耗时几乎全在进程创建，不在解析 |
| 小树进程内改写 | 亚毫秒 | 无进程、无临时文件 |

18–24 ms 是 worker 的进程创建加一次 JSON 往返；引擎自身在这个规模下是微秒级。这个差距就是工具走进程内的全部理由。

## 降级行为（未装可选工具时）

| 缺失 | 行为 |
| --- | --- |
| `@ast-grep/napi` | 五个 `ops_ptc_*` 返回 `EXECUTOR_UNAVAILABLE`，不写任何文件 |
| `es.exe`（Everything） | 枚举回落递归遍历；`esCandidates()` 返回列表，绝不抛异常 |
| `ast-grep` CLI | `sgCrossCheck` 返回 `agree: false`，不抛异常 |

`test/ptc-engine.test.mjs` 把这四条钉成断言（4 项）。

## 为什么是源码而不是产物

已发布的 2.1.1 产物与 TypeScript 原型曾经漂移（`tools.ts` 还停在 2.0.5）。把产物**当作**源码入库，
就没有第二份真相，也就无从漂移。
