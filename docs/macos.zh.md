# macOS（arm64 与 Intel x64）

支持 **macOS 13 或更高版本**，原生覆盖 Apple Silicon（`darwin-arm64`）与 Intel（`darwin-x64`）。
精确原生目标是 `win32-x64`、`linux-x64`、`darwin-arm64` 和 `darwin-x64`；npm 的 `os`/`cpu`
字段不能表达配对矩阵，实际支持以运行时常量和组件 `targets` 为准。

macOS 12 不是完整支持：其内核缺少 `CLONE_ACL`，覆盖已有文件、`replace` 与 `copy` 会 fail closed。
读取与不改写文件的工具可用。原因和后续回退见下文 [macOS 12](#macos-12)；该回退是独立的后续项，
不属于本次变更。

## 原生 worker 与源码构建

发布包使用 `runtime/darwin-arm64/dsh-ops-worker` 或 `runtime/darwin-x64/dsh-ops-worker`，各自带
version/target/executable/SHA256 收据。Git 检出目录不包含生成的 worker。

```console
npm ci --ignore-scripts
cargo build --release --locked --manifest-path native/Cargo.toml

# Apple Silicon
node bin/native-runtime.mjs stage --platform darwin-arm64 --input native/target/release
node bin/native-runtime.mjs check --platform darwin-arm64

# Intel
node bin/native-runtime.mjs stage --platform darwin-x64 --input native/target/release
node bin/native-runtime.mjs check --platform darwin-x64
```

`npm run build:ptc` 构建并暂存宿主目标，因此在 Apple Silicon 上选 `darwin-arm64`，在 Intel 上选
`darwin-x64`。自定义 `CARGO_TARGET_DIR` 或 `cargo --target` 必须用匹配的显式 stage `--input`；
不要把默认目录里的旧构建误当成本次构建。解析器拒绝缺失/损坏的收据和矩阵之外的目标。

## macOS 12

`replace`、`copy` 和覆盖已有文件的写入会通过 `fclonefileat(..., CLONE_ACL)` 创建 copy-on-write
副本，以保留 APFS ACL 与扩展属性。macOS 12 的 xnu（`xnu-8020`）没有实现 `CLONE_ACL`，返回
`EINVAL`；worker 返回 `METADATA_UNSUPPORTED`，不会发布任何内容。macOS 13、14、15（`xnu-8792`、
`xnu-10002`、`xnu-11215`）实现了该 flag。新文件与只读操作不使用它。在回退落地前，不要把
macOS 12 当作完整支持；该回退是独立后续项，不属于本次变更。

## Shell

Bash 是主包的 **Windows-only 可选 npm 载荷**；PowerShell 由宿主管理。macOS 不落地任何载荷，也没有
postinstall 下载器。macOS 的 `ops_bash` 默认开启，按显式 `bashPath`、PATH、Homebrew/系统位置解析：

- Apple Silicon Homebrew：`/opt/homebrew/bin/bash`
- Intel Homebrew：`/usr/local/bin/bash`
- 系统 Bash：`/bin/bash`

```yaml
- id: dsh-ops-shell
  name: dsh-ops/shell
  config:
    bashPath: /opt/homebrew/bin/bash   # Intel Homebrew: /usr/local/bin/bash
```

没有 Homebrew Bash 时 `/bin/bash` 可用。受限调用仍然要求 DSH 的宿主隔离；隔离不可用是执行器失败，
绝不是无隔离运行的理由。宿主在 macOS 上禁用 pwsh 工具，因此 provision 一个 pwsh 可执行文件也不会
产生该工具。

## PTC 与文件系统边界

- file 与可选的 PTC 使用独立的 Rust worker。
- PTC 工具只在纯 PTC 呈现中发布。提供 `batch.root` 时必须为绝对路径；批处理审计的分页在与会话根
  不同时必须使用同一个根。
- macOS 的 `/tmp`、`/var` 是系统别名。文件桥会规范化 **父目录链**，保留最后一项用于 no-follow
  检查；这些别名的后代可用，直接点名软链仍然 fail closed。规范化写根检查保持不变。
- macOS 上的 `replace` 与覆盖写要求 APFS clone 支持与 `CLONE_ACL`（macOS 13+）。不支持 clone 的
  文件系统会在发布前失败，而不是丢掉 deny 项；普通 mode/owner/xattr 在最终 fsync 与 rename 前恢复。
- 隐藏的 `.dsh-ops-update-*.lock` sidecar 是协作式路径锁，由持有它的写入者删除。被杀死写入者留下的
  sidecar 会被同名文件的下一次写入复用并删除，不会成为死锁。

## 验证证据

- CI 在 `macos-latest`（arm64，阻塞）与 `macos-15-intel`（x64，非阻塞；该 leg 实测 318 秒，
  超过 300 秒线，见 [CI](ci.md)）上跑完整门禁。
- Intel leg 会构建并暂存 `darwin-x64`、跑全部套件、校验 Mach-O x86_64 worker 及其收据，并打包/解包
  artifact。
- 贡献者在[原 PR](https://github.com/OldLigant/dsh-ops/pull/1) 中报告 Intel macOS 12.7.6
  上 42 个 Rust 单测通过、1 个预期 `CLONE_ACL` 失败。这是其本地报告，不是本次变更的 macOS 12 验收。
- [贡献者的 PR 事件运行](https://github.com/OldLigant/dsh-ops/actions/runs/39772711519) 通过了
  Intel macOS 15 完整门禁。收据校验通过的 x86_64 Mach-O 最低加载版本为 10.12；macOS 13 下限
  来自所需 ACL 克隆能力。该 CI 没有运行 macOS 13/14。苹果的
  [xnu-8792 实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/vfs/vfs_syscalls.c)
  接受 `CLONE_ACL` 并复制源 ACL，仍需文件系统支持。
- 0.3.1 只发布 Apple Silicon；当前支持在 macOS 13+ 上增加 Intel。替换包之后，桌面 GUI 会话仍需
  正常重启应用。
