# 在 Linux x64 与 arm64 上构建与运行 dsh-ops

Linux x64 是 **file**、**ptc**、**shell** 三个组件的发布目标；Linux arm64（aarch64）在解析器的
`PLATFORMS` 里被接受但不在发布矩阵中，arm64 宿主自行构建并 stage worker（见
[Linux arm64（本机 staged）](#linux-arm64本机-staged)）。Linux 上 shell
组件的 `ops_bash` 使用发行版自带的 bash（见[配置 shell 通道](#配置-shell-通道)）；随包
PowerShell 7 与 bash IPC 代理仍仅限 Windows x64。

Linux 上**没有任何东西随安装包下载**：原生 worker 一律由本地源码构建后落到安装相对
目录，这正是本文档存在的原因。npm 包仍然只携带 Windows x64 载荷
（`@dsh-ops/*-win32-x64`），Linux 没有对应的载荷包可取。

| 组件 | Linux x64 / arm64 | 说明 |
| --- | --- | --- |
| `dsh-ops/mode-standard` | 支持 | 常驻 OPS 文件工具，`ops_bash` 使用宿主 bash；Linux 上不替换官方工具 |
| `dsh-ops/mode-cordis` | 支持 | 与 Standard 相同的工具面，使用自己的路由段 |
| `dsh-ops/mode-minimal` | 支持 | 动态加载入口与 `ops_bash` |
| `dsh-ops/mode-ptc` | 支持 | PTC SDK：`ops_batch`、`ops_result` 及类型化目录 |

## 前置条件

| 依赖 | 版本 | 依据 |
| --- | --- | --- |
| Node.js | `^22.19 \|\| >=24` | `package.json` 的 `engines` |
| Rust | `1.88` 或更高（`cargo`） | `native/Cargo.toml` 的 `rust-version` |
| pnpm | 近期版本即可 | `dsh plugin` 会转发给它 |
| DSH | `0.2.0-rc.2` | 本版目标宿主 |

## 1. 取源码

```console
$ git clone https://github.com/T-Auto/dsh-ops.git
$ cd dsh-ops
```

## 2. 安装依赖

```console
$ npm install
added 45 packages in 499ms
```

根包的 `os` 已声明为 `["win32", "linux"]`，因此 npm 在 Linux 上不会施加平台否决。
若你手上的树其 `os` 仍是 Windows-only（例如已发布的 0.3.0 tarball），同一条命令会在
`EBADPLATFORM` 停下，已发布的 `npx dsh-ops@latest install` 入口在 Linux 上也不可用。
与 tarball 如何发布无关、始终可用的路径见
[第 5 节：安装进 profile](#5-安装进-profile)。

确实需要把 Windows-only 的树强行装上时，`npm install --force` 可以做到；注意它同时会
跳过 npm 的脚本闸门。有三个依赖带 install 脚本（`node-pty`、`koffi`、
`@deepseek-ai/dsh-subprocess-local`），需要它们的测试套件会明说，而不是静默通过。

## 3. 构建原生 worker

```console
$ npm run build:ptc
toolchain: cargo 1.98.1
    Finished `release` profile [optimized] target(s) in 3.05s
linux-x64: 3665672 bytes, sha256 327420ad9660…f9c8b0efc9445c0c
Validated 1 native runtime(s); no install-time scripts or permission changes.
```

该命令编译 `native/`，并把产物落到运行时解析器所读的安装相对布局：

```text
runtime/linux-x64/dsh-ops-worker
runtime/linux-x64/provenance.json
```

`provenance.json` 记录 target、包版本、可执行文件名与二进制的 SHA-256。
`resolveWorker()` 在**每一次**解析时重算该摘要，凭据不匹配就直接拒绝，因此半拷贝或
被手工改过的 `runtime/` 是 fail-closed，而不是照跑。

确认接线正常：

```console
$ node bin/dsh-ops.mjs ladder
```

报告第一节 `Native worker (file tools)` 会写明已落地的 worker 及其解析来源。

## 4. 在本机验证

门禁有三种结果 —— 通过、失败、跳过 —— 且**跳过永远不计入通过**。
`DSH_OPS_REQUIRE_RUNTIME=1` 会把跳过变成失败（例如在 `npm run build:ptc` 之前运行原生
worker 套件），这是最严格的形式：

```console
$ DSH_OPS_REQUIRE_RUNTIME=1 npm run verify
```

以其它平台为对象的套件（例如 Windows ACL）会自行跳过，并在汇总行中写明原因。

Rust worker 自身的 barrier 测试：

```console
$ cargo test --release --locked --manifest-path native/Cargo.toml
test result: ok. 1 passed; 0 failed
```

### Linux 边界套件

有六个套件绕过宿主桥接层，直接驱动发布的 worker，专测那些会被桥接层归一化掉的边界。
它们在 `test/linux-*.test.mjs`，共用 `test/lib/boundary.mjs`：

| 套件 | 主题 |
| --- | --- |
| `linux-paths` | 怪异与 CJK 文件名、名称/NUL 长度上限、深度、符号链接拒绝 |
| `linux-args` | `offset`/`limit` 边界、glob 模式、正则安全性、上下文上限、分页是否诚实 |
| `linux-sandbox` | `read_only`、`write_roots` 围栏、符号链接拒绝、特殊对象 |
| `linux-protocol` | 畸形帧、超大请求、重复调用、并发原子性 |
| `linux-attributes` | 内容/mtime/无残留、硬链接 inode 替换、`0444`、稀疏文件 |
| `linux-scope` | 平台闸门、provenance 篡改与伪造、三层作用域、已 stage 摘要 |

它们被写成「Windows 上绝不会把 Linux 专属检查报成通过」：`linux-attributes` 整套
跳过，`linux-paths` 与 `linux-sandbox` 就地守护其 POSIX 专属用例，其余三个与平台无关。
**已知未修缺陷是刻意不写断言的**，这样修好一个不会反而让闸门变红；每个套件的文件头都
列明了它留空的是哪一条。跨平台缺陷会带自己的套件，而不是塞进名字带 linux 的套件 ——
`inspect-hex` 对应报告 L2 的 hex 行语义，`output-budget` 对应 L4 的 96 KiB 响应上限，
`replace-concurrency` 对应 L14 的更新锁，`file-metadata` 对应 L1/L9 的元数据保留，
`grep-multiline` 对应 L6 的跨行匹配。
仍需 Windows 宿主回答的问题见
[Windows 验证清单](windows-verification.md)。

### 在 Linux 上回答「发布闭包」问题

`npm run verify:release` 在上面的门禁之上再加发布闭合检查。它从 `package.json`
推导声明的作用域，断言它与解析器的 `PLATFORMS` 完全一致，然后校验**本包实际
stage 的**目标。在只构建 Linux 的机器上那就是 `linux-x64`，而 Windows 的 IPC 闭包
会被明确报告为跳过，而不是被悄悄略过：

```console
$ npm run verify:release
…
dsh-ops test: 30 suite(s) passed in 15s
linux-x64: 3665672 bytes, sha256 327420ad…
Release closure OK: dsh-ops@0.3.1, linux-x64 worker (Bash IPC closure skipped: win32-x64 is not staged; DSH_OPS_REQUIRE_ALL_TARGETS=1 demands it).
```

`npm run check:ptc-runtime` 回答的是更窄的问题 —— 已 stage 的运行时是否完好 ——
所以它在单平台构建上同样通过：

```console
$ npm run check:ptc-runtime
linux-x64: 3665672 bytes, sha256 327420ad…
Validated 1 native runtime(s); no install-time scripts or permission changes.
```

不带参数的 `node bin/native-runtime.mjs check` 仍然要求**每个**已声明平台都在场，
因为那是发布装配脚本在发布之前要问的问题。组装跨平台发布版、希望缺平台即失败时，
设 `DSH_OPS_REQUIRE_ALL_TARGETS=1`。

## 5. 安装进 profile

`npx dsh-ops@latest install` 是文档里的 Windows 路径，依赖一个 Windows-only 的 npm
tarball。在 Linux 上，请通过 DSH 自己的插件管理器从检出目录安装，它会转发给 pnpm：

```console
$ dsh plugin --profile <profile> add /absolute/path/to/dsh-ops
```

要安装别处已经建好的构建，先打包（`files` 列表包含 `runtime/`，因此已 staged 的
worker 会随 tarball 一起走）：

```console
$ npm pack
$ dsh plugin --profile <profile> add ./dsh-ops-0.3.1.tgz
```

确认宿主到底合成了什么：

```console
$ dsh --profile <profile> --dump-config
```

## Linux arm64（本机 staged）

`linux-arm64` 只存在于解析器的 `PLATFORMS`，不在 `RELEASE_TARGETS` 里：发布 tarball 仍只携带
`win32-x64`、`linux-x64`、`darwin-arm64` 与 `darwin-x64`，因此发布包里**没有**
`runtime/linux-arm64` 的 worker，也不会去下载。arm64 宿主用包里自带的 `native/` 源码构建，再用带
回执的方式 stage：

```console
$ npm run build:ptc -- stage --platform linux-arm64          # 先 cargo build --release --bin dsh-ops-worker
$ node bin/native-runtime.mjs check --platform linux-arm64   # 回执、摘要与 ELF machine（183）
$ node bin/native-runtime.mjs check --staged                 # 校验本树实际携带的全部运行时
```

`npm run build:ptc` 使用宿主工具链编译，因此需要 Rust 1.88 与 C 链接器。`runtime/linux-arm64/provenance.json`
由 stage 写入；回执与 worker 摘要不符时解析器拒绝，把 x64 ELF 改标签冒充 arm64 也会被拒绝。只要
`runtime/linux-arm64` 存在，`node bin/check-release.mjs` 就会失败——发布必须正好是四个
`RELEASE_TARGETS`。

支持范围要说明清楚：

- **本机支持，不是发行支持。** `linux-arm64` 只在宿主源码构建里可用；npm 包、发布 workflow 与
  `check-release.mjs` 仍按四个目标描述，不能把 staged 的 arm64 worker 理解为发行承诺。
- **源码未打补丁。** staged worker 由随包 `native/` 源码原样构建，该宿主上 worker 原有的平台限制照样成立。
- **Android/proot 证据很窄。** 在 Android arm64 的 proot 环境里只观察到读取与有界枚举可用；
  rename、`linkat`、xattr 与 SELinux 行为尚未验证，因此不能推广到全部写入路径、非 proot 的
  GNU/Linux arm64，或操作系统级沙箱验收。
- **不会用别的架构顶替。** 放宽 `PLATFORMS` 不等于允许 x64 载荷顶替 arm64 宿主：解析器按
  `runtime/<platform>-<arch>` 取文件，并同时校验回执与 ELF machine。

## 配置 shell 通道

Linux 上 `ops_bash` 开箱可用：`shell` 组件不随包提供 shell，而是解析发行版自带的
bash（`config.bashPath` → `PATH` → `/bin/bash`、`/usr/bin/bash`、`/usr/local/bin/bash`）；
受限模式必须由宿主沙箱落实约束，沙箱无法约束时拒绝执行，绝不无约束运行。

要使用另一个 bash，在模式行显式指定：

```yaml
- id: dsh-ops-mode-standard
  config:
    bashPath: /usr/bin/bash
```

> Linux 上 `allowSystemShellFallback` 不起作用：宿主 bash 本身就是这一档。配置的
> `bashPath` 是权威的：它胜过 `PATH` 与常见安装位置。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Unsupported runtime target linux-x64` | 该构建的 `PLATFORMS` 列表早于 Linux 支持 | 换用列出 `linux-x64` 的版本，或用已支持的检出构建 |
| 编译成功后 `build:ptc` 报 `Error: Unsupported target` | stage 步骤拒绝了该 target | 同上；编译本身没有问题 |
| `npm error code EBADPLATFORM` | 已发布的 tarball 声明 `os: ["win32"]` | 从检出目录（或 `npm pack`）经 `dsh plugin` 安装 |
| file 工具无声消失、没有任何报错 | `resolveWorker()` 抛错后组件降级，而 `required` 缺省为 `false` | 给 `dsh-ops/mode-standard` 行设 `required: true`，让它变响 |
| `preflight` 阶段报 `Bad file descriptor (os error 9)` | 审计库或原子替换对 cap-std 在 Linux 上以 `O_PATH` 打开的目录句柄执行 `fsync`，内核拒绝 | 已在 `native/src/lib.rs` 修复；用 `npm run build:ptc` 重建 |
| 被拒命令报成普通失败而非 `POLICY_DENIED` | 宿主提供的英文拒绝签名去匹配被本地化的 libc 消息 | bash 通道已固定 `LC_MESSAGES=C`；旧构建在非英文宿主上会命中此问题 |

## 为什么要本地构建

npm 包只发 Windows x64 载荷。因此 Linux 部署没有可回退的已下载 worker，而插件的运行时
解析在设计上就是安装相对的：它不会静默地从无关位置捡一个二进制来用。从检出目录构建是
受支持的路径，而它产出的每一件产物在运行前都会经过摘要校验。
