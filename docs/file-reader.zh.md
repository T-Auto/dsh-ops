# 选择 `read_files` 的读取器：`fileReader`

`fileReader` 决定由哪个实现来应答 `read_files`。它是显式开关、不是静默升级——两个读取器
在某个维度上的差异，不该由默认值替你做决定。

| 取值 | 读取器 | 写宿主 `fs/observed` | 成本 |
| --- | --- | --- | --- |
| `native`（默认） | `dsh-ops-worker`（Rust，每次调用起进程） | **是** | 每次约 20–40 ms |
| `inproc` | `engine/parallel-read`（进程内） | **否** | 每次 0.3–1.6 ms |

```yaml
dsh-ops:
  fileReader: inproc   # 留空即 native
```

## 为什么默认是 `native`

写宿主 read-before-edit 表的是原生那次读。切到 `inproc` 后，模型可以编辑一个它只经宿主未记录的
路径“读过”的文件——这是正确性变化，所以必须显式开启。

## `inproc` 换来什么

本包基准实测（`bench/read-path-comparison.mjs`，三轮取中位）：

| 请求 | `native` | `inproc` | 加速 |
| --- | --- | --- | --- |
| 24 文件 × 30 行（34 KiB） | 35.0 ms | 1.6 ms | 21× |
| 8 文件 × 800 行（317 KiB） | 22.4 ms | 1.1 ms | 20× |
| 1 文件 × 20 000 行（1 MiB） | 18.4 ms | 0.3 ms | 53× |

token 成本相同：两边都按 schema 默认的每文件 200 行，都在 worker 输出预算处停，同一请求返回同样字节。

## 错误处理

`fileReader` 有校验：未知取值是配置错误并列出可接受值，绝不静默回落到 `native`。

## 在哪里设置

在**profile**配置里设置 `fileReader`（或用插件的设置页）。不要写进随包发布的 `cordis.patch.yml`：
manifest 校验器会拒绝那里未声明的 row 键，而该文件本就应当与代码默认值（`native`）一致。
