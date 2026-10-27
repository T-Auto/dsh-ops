# macOS（arm64 与 Intel x64）

支持 **macOS 13 或更高版本**，原生覆盖 Apple Silicon（`darwin-arm64`）与 Intel（`darwin-x64`）。
精确原生目标是 `win32-x64`、`linux-x64`、`darwin-arm64` 和 `darwin-x64`；npm 的 `os`/`cpu`
字段不能表达配对矩阵，实际支持以运行时常量和组件 `targets` 为准。

Intel macOS 12.7.6 的 APFS 回退为**手动验证的尽力兼容**，不扩大通用平台保证。它要求源文件和
目标目录均无扩展 ACL，且宿主与 Node 22 兼容。macOS 12 的 Apple Silicon 尚未验证。
见 [macOS 12](#macos-12)。

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
返回 `EINVAL`；worker 先拒绝带扩展 ACL 的目标目录，再去掉该 flag 重试。普通 clone 会继承目录的
ACL，`chmod 0600` 不会清除它。重试在写入前检查源文件和副本；发现扩展 ACL 或检查失败时，以
`METADATA_UNSUPPORTED` 拒绝操作。带扩展 ACL 的源文件在所有 macOS 上仍不受支持。
复查失败会删除临时副本；删除失败则返回 `CLEANUP_FAILED`、`effectState=unknown`，如实说明可能
残留未发布字节，重试前应检查提示中的副本。新文件与只读操作不做 clone，本回退不改变它们的行为。

这是过渡性兼容，手动验证环境为 Intel macOS 12.7.6、Node 22.23.4。此前的宿主验证使用
DSH 0.2.1-rc.2；宿主仍须属于 `engines.dsh` 声明范围。它不证明依赖 Node 24 的新版宿主可用；
[Node 24 官方 macOS 二进制要求 macOS 13.5+](https://nodejs.org/en/blog/migrations/v22-to-v24)。
没有 macOS 12 CI、没有 macOS 12 arm64 验证，也未声称已将 CI 构建的发布二进制拿到 macOS 12
运行。Mach-O 最低加载版本较低本身不能替代运行验证。

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
  确认源文件和目标目录均无扩展 ACL 后去掉该 flag 重试，并复查源文件与副本。不支持 clone 的
  文件系统会在发布前失败，而不是丢掉 deny 项；普通 mode/owner/xattr 在最终 fsync 与 rename 前恢复。
- 隐藏的 `.dsh-ops-update-*.lock` sidecar 是协作式路径锁，由持有它的写入者删除。被杀死写入者留下的
  sidecar 会被同名文件的下一次写入复用并删除，不会成为死锁。

## 验证证据

- CI 在 `macos-latest`（arm64，阻塞）与 `macos-15-intel`（x64，非阻塞；该 leg 实测 318 秒，
  超过 300 秒线，见 [CI](ci.md)）上跑完整门禁。
- Intel leg 会构建并暂存 `darwin-x64`、跑全部套件、校验 Mach-O x86_64 worker 及其收据，并打包/解包
  artifact。
- ACL 继承修复后，已 rebase 的 0.5.0 检出在 Intel macOS 12.7.6、Node 22.23.4、Rust 1.99.1
  上于代理沙箱之外手动验证（非 CI）：Rust 工作区测试 54 通过 / 0 失败；完整门禁收集 150 个 JS
  套件，147 通过、1 失败、2 跳过（`tui-host` 与 `tui-native` 需要外部检出）。唯一失败是
  `review-snapshot`：Apple Git 2.37.1 不支持 `git merge-tree --write-tree`。构建/暂存、manifest
  （140 项）、打包/解包与运行时收据检查均通过；由于 Git 相关失败，完整门禁仍非全绿。
- [贡献者此前的 PR 事件运行](https://github.com/OldLigant/dsh-ops/actions/runs/39772711519) 通过了
  Intel macOS 15 完整门禁。收据校验通过的 x86_64 Mach-O 最低加载版本为 10.12；macOS 12 是手动
  结果，CI 验证的是 macOS 15。该 CI 没有运行 macOS 13/14。苹果的
  [xnu-8792 实现](https://github.com/apple-oss-distributions/xnu/blob/xnu-8792.61.2/bsd/vfs/vfs_syscalls.c)
  接受 `CLONE_ACL` 并复制源 ACL，仍需文件系统支持。该运行早于此次 ACL 继承修复；修复后的
  分支仍需新的 PR 事件 CI。
- 回退回归测试在新版 macOS 上也直接调用 plain-clone 本体，覆盖目录/副本 ACL 拒绝、源 ACL
  变化、no-follow 检查与清理失败；它们不模拟全部并发元数据变化，也不能替代 macOS 12 产物验证。
- 0.3.1 只发布 Apple Silicon；当前支持在 macOS 13+ 上增加 Intel，CI 验证路径为 macOS 15；
  Intel macOS 12.7.6 为手动验证的尽力兼容。替换包之后，桌面 GUI 会话仍需正常重启应用。
