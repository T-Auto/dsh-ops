# macOS（arm64 与 Intel x64）

支持 **macOS 12 或更高版本**，原生覆盖 Apple Silicon（`darwin-arm64`）与 Intel（`darwin-x64`）。
精确原生目标是 `win32-x64`、`linux-x64`、`darwin-arm64` 和 `darwin-x64`；npm 的 `os`/`cpu`
字段不能表达配对矩阵，实际支持以运行时常量和组件 `targets` 为准。

macOS 12 的内核缺少 `CLONE_ACL`；worker 在既有的扩展 ACL 检查之后，以不带该 flag 的 APFS clone
重试，并在写入前复查源文件。带扩展 ACL 的源文件在所有 macOS 版本上仍然以
`METADATA_UNSUPPORTED` fail closed。见 [macOS 12](#macos-12)。

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

`replace`、`copy` 和覆盖已有文件的写入会创建 copy-on-write 副本。macOS 13、14、15（`xnu-8792`、
`xnu-10002`、`xnu-11215`）使用 `fclonefileat(..., CLONE_ACL)`。macOS 12（`xnu-8020`）对该 flag
返回 `EINVAL`，worker 因此去掉该 flag 重试；发布管线本来就拒绝带扩展 ACL 的源文件，重试会在
clone 之后、写入任何字节之前再次检查。带扩展 ACL 的源文件仍然返回 `METADATA_UNSUPPORTED`，不会
发布。新文件与只读操作不做 clone。macOS 12 不在 CI 中；见下方手动结果。

## Shell

Bash 是主包的 **Windows-only 可选 npm 载荷**；PowerShell 由宿主管理。macOS 不落地任何载荷，也没有
postinstall 下载器。macOS 的 `ops_bash` 默认开启，按显式 `bashPath`、PATH、Homebrew/系统位置解析：

- Apple Silicon Homebrew：`/opt/homebrew/bin/bash`
- Intel Homebrew：`/usr/local/bin/bash`
- 系统 Bash：`/bin/bash`

```yaml
- id: dsh-ops-mode-standard
  name: dsh-ops/mode-standard
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
- macOS 上的 `replace` 与覆盖写要求 APFS clone 支持。macOS 13+ 使用 `CLONE_ACL`；macOS 12 在
  扩展 ACL 检查之后去掉该 flag 重试。不支持 clone 的文件系统会在发布前失败，而不是丢掉 deny
  项；普通 mode/owner/xattr 在最终 fsync 与 rename 前恢复。
- 隐藏的 `.dsh-ops-update-*.lock` sidecar 是协作式路径锁，由持有它的写入者删除。被杀死写入者留下的
  sidecar 会被同名文件的下一次写入复用并删除，不会成为死锁。

## 验证证据

- CI 在 `macos-latest`（arm64，阻塞）与 `macos-15-intel`（x64，非阻塞；该 leg 实测 318 秒，
  超过 300 秒线，见 [CI](ci.md)）上跑完整门禁。
- Intel leg 会构建并暂存 `darwin-x64`、跑全部套件、校验 Mach-O x86_64 worker 及其收据，并打包/解包
  artifact。
- 贡献者在 Intel macOS 12.7.6 上的手动结果（非 CI）：`cargo test --workspace --locked`
  47 通过 / 0 失败，包含新增的 plain-clone 回归；`node test/run.mjs` 149 个套件中 148 通过、
  2 跳过。唯一失败是 `review-snapshot`，因为 Apple Git 2.37.1 不支持
  `git merge-tree --write-tree`，与文件发布无关。
- [贡献者的 PR 事件运行](https://github.com/OldLigant/dsh-ops/actions/runs/39772711519) 通过了
  Intel macOS 15 完整门禁。收据校验通过的 x86_64 Mach-O 最低加载版本为 10.12；macOS 12 是手动
  结果，CI 验证的是 macOS 15。该 CI 没有运行 macOS 13/14。苹果的
  [xnu-8792 实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/vfs/vfs_syscalls.c)
  接受 `CLONE_ACL` 并复制源 ACL，仍需文件系统支持。
- 0.3.1 只发布 Apple Silicon；当前支持在 macOS 12+ 上增加 Intel，CI 验证路径为 macOS 15。替换包
  之后，桌面 GUI 会话仍需正常重启应用。
