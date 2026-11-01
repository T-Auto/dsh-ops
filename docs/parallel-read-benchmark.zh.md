# ops-parallel-read 4.1.8 —— 以源码入库并实测

读取器以源码形态入库 `engine/parallel-read/`（5 个模块、99 KiB），不再走压缩包。`src/file/parallel-read.ts`
是类型化入口。除 Node 标准库外零依赖，`npm install` 之后即可用。

## 原生 worker vs 进程内，同一请求

环境 Windows 11 / x64、Node 24.22.1，三轮取中位。`native` = 随包 Rust worker，每次调用起一个进程；
`inproc` = `engine/parallel-read` 在同进程内应答。

| 请求 | native | 进程内 | 加速 |
| --- | --- | --- | --- |
| 24 文件 × 30 行（34 KiB） | 35.0 ms | 1.6 ms | 21× |
| 8 文件 × 800 行（317 KiB） | 22.4 ms | 1.1 ms | 20× |
| 2 文件 × 8 000 行（824 KiB） | 22.4 ms | 0.4 ms | 51× |
| 1 文件 × 20 000 行（1 MiB） | 18.4 ms | 0.3 ms | 53× |

差距在进程创建而不是 I/O：1 MiB 那个用例里，worker 还没碰到任何一个字节就已经花了约 18 ms。

## token 一致性

两个读取器都按 schema 默认的每文件 200 行，都在输出预算处停，因此同一请求返回同样字节：

| 请求 | native | 进程内 |
| --- | --- | --- |
| 1 文件 × 20 000 行 | 10.7 KiB | **10.7 KiB** |
| 2 文件 × 8 000 行 | 21.3 KiB | **21.3 KiB** |
| 8 文件 × 800 行 | 34.1 KiB | 35.5 KiB（+4 %） |
| 24 文件 × 30 行 | 36.2 KiB | 37.9 KiB（+5 %） |

剩下的几个百分点是回执字段（`nextIndex`、`pending`），不是正文。

## 为什么默认仍是 `native`

写宿主 read-before-edit 表的是原生那次读，`inproc` 不写，所以默认切过去等于允许模型编辑一个它其实没读过的文件。
因此 `fileReader: inproc` 是显式选项，详见 `docs/file-reader.md`。
