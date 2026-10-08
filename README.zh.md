# dsh-ops

一个 DSH 插件：给 profile 一个**统一的仓库工具面**，并把 shell 从这条路上请出去。

它把 [FastCtx](https://github.com/yc-duan/fastctx) —— 一个本地 Rust 运行时，
通过 MCP 提供读文件、搜内容、找路径、批量替换、跑命令 —— 以标准 DSH bundle 的
形式托管起来：插件自己 spawn 这个服务端、自己通过 stdio 说 MCP，并把它的工具
以 `ops_*` 发布在**本插件自己的**注册作用域里；既不挂任何桥，也不改写任何共享
注册表。在此之上，它注入一段提示词策略，把命令执行写成一条明确的阶梯 —— 先
FastCtx，再用插件自带的 shell，最后才是宿主自己的 shell 工具 —— 并且可以把那些
宿主 shell 工具从 agent 的视野里直接遮掉。

| | |
| --- | --- |
| 插件名 | `dsh-ops` |
| 工具命名空间 | `ops_*` —— 9 个 FastCtx 工具，外加 `ops_bash` |
| 目标宿主 | DSH `0.2.0-rc.2` |
| 清单 | dsh-std Community `dsh-plugin.json` v0.15 |
| 许可证 | `MIT AND Apache-2.0` —— 见[许可证](#许可证) |

## 为什么

在 Windows 上，一个用 PowerShell 读文件的 agent，注意力花在引号、转义、路径写法
和编码上，而不是花在代码库上。`Select-String` 的输出不是搜索结果，
`Get-ChildItem` 的输出不是文件列表，被截断的终端缓冲不是文件。FastCtx 把这些换成
结构化的工具：输入是参数，输出有边界、可翻页、带标记。

但这只有在模型真的去用它们时才有意义。一个和 shell 并排放着的工具，就是模型会忘记
的工具。所以本插件还把这条规则写进系统提示词，并可以在工具闸口上强制执行。

## 它做什么

四项贡献，各自只依赖它需要的服务：

1. **把命令执行写成阶梯。** 两段提示词：一段始终存在的 host shell 规则；一段只列出
   **模型真能调到**的各级、并按该用的顺序排列。工具没发布的级不出现在文案里，而不是
   照写不误。
2. **托管它自带的 shell。** `ops_bash` 用本插件解析到的 bash 跑一条命令，执行走宿主的
   subprocess 服务；Windows 上，只要包内带着自己的 PowerShell 7，bundle patch 就会把
   宿主的 `pwsh-sandbox` 行指向它。两个 shell 都是可选的：没有它们只是让阶梯少一级，
   别的都不受影响。
3. **可以拒绝并遮蔽 host shell。** 配置 `shellPolicy: deny-host-shell` 后，插件会在
   **自己还有一级 shell 可用**时，把配置里的宿主 shell 工具从每个新 agent 的视野里遮掉
   （`tools.restrict`），同时用 `tools/pre-execute` 监听器按名字拒绝它们，理由里点名
   对应的 FastCtx 工具。遮蔽是便利，栅栏才是保证，而栅栏只由这个模式决定、与解析结果
   无关。
4. **托管 FastCtx MCP 服务端。** 插件解析出 FastCtx 可执行文件、验证它能跑，然后
   **自己** spawn 它，按 `fastctx serve` 启动（需要 shell 工具时再加
   `--enable-shell`）。stdio 连接、握手、重连策略与工具注册都由本插件拥有：服务端
   列出的每个工具都以 `ops_<名字>` 通过**本插件自己的** `ctx.tools.register`
   发布。插件被卸载，这些工具随之注销，子进程也随之停止。

### 命令执行阶梯

工具说明段是一条阶梯，站在模型的角度写，各级按该用的顺序排列：

1. **第 1 级 —— FastCtx（`ops_*`）**：读、搜、列、替换，以及普通命令执行，走下面
   那些工具。
2. **第 2 级 —— `ops_bash`**：本插件解析到的 bash，用于 POSIX 管道、shell 脚本，以及
   `git`/`gh`/构建工具链。
3. **第 3 级 —— PowerShell 7**：Windows 原生的事 —— cmdlet、环境变量、注册表或服务
   操作、原生路径。
4. **第 N 级 —— 宿主自己的 shell 工具**：最后手段，只用于上面任何一级都跑不了的
   操作。

**「优先」只是措辞，没有任何东西替你换级。** 文案把这句话写得很直白，插件也照此
约束自己：一次调用失败，它**不会**替你换一级重试，不会在运行期把哪一级标成不可用，
也不做任何级联。**每一级都是「模型能不能调到」的事实**，每次组装时向活注册表问一次：
第 1 级在有任何 FastCtx 工具在册时成立，第 2 级在 `ops_bash` 在册时成立，第 3 级在本
平台确实带着插件自带的 PowerShell 7 时成立 —— 也就是 bundle patch 作用的同一个事实。
解析只回答另一个问题（解析到哪个可执行文件、走哪条路、为什么不可用），**不决定**有
没有这一级。不成立的级不提，其下的级重新编号，所以模型读到的编号不会出现空档。文本
之外的行为只有下面说的 `shellPolicy`。

### 工具面

| 工具 | 用途 | 替代 |
| --- | --- | --- |
| `ops_inspect_local_file` | 读文本/图片/PDF/十六进制视图，带行号与分页 | 用 shell 打印文件 |
| `ops_grep` | 在单文件或整棵树里搜内容 | `Select-String`、`findstr`、shell 的 `rg`/`grep` |
| `ops_glob` | 按路径模式找文件 | `Get-ChildItem`、shell 的 `dir`/`ls`/`find` |
| `ops_replace` | 跨文件做一次机械替换 | `-replace`、`sed`、`perl` |
| `ops_run` | 在 bash 里跑一条命令 | host shell 工具 |
| `ops_run_background` | 启动长时任务 | `Start-Job`、`&` |
| `ops_job_output` / `job_list` / `job_kill` | 查看与停止任务 | 用 shell 记账 |
| `ops_bash` | 用本插件解析到的 bash 跑一条命令（第 2 级） | POSIX 活儿上的 host shell 工具 |

前四个始终发布；接着五个来自 FastCtx 的 `--enable-shell`，可用
`enableShellTools: false` 关掉。`ops_bash` 是本插件自己注册的工具：bash 解析得到它、
**并且**宿主挂了 subprocess 服务来跑它，它才出现；`publishBashTool: false` 可以关掉它。

`ops_bash` 返回一次命令的最终结果：`stdout` 与 `stderr`（各含 `text`、`truncated`，
输出被溢出到文件时还有 `spillPath`）、`timedOut` 与 `timeoutMs`。`exitCode` 与
`signal` 只在进程真的报出来时才存在 —— 未知的退出事实是**键不存在**，而不是 `null`。

## 安装

装进需要这套 FastCtx 工具面的 profile：

```console
dsh plugin --profile desktop add dsh-ops
dsh plugin --profile web     add dsh-ops
```

`dsh plugin --profile <名称> <参数…>` 把参数转发给 profile 目录里的 pnpm，所以 pnpm
的所有动词都可用，pnpm 接受的任何 spec 都合法。由于本包声明了 `dsh.bundle`，同一条命令
还会把它追加进 profile 的 `dsh.profile.bundles`。`cordis.patch.yml` 只插入一行，
profile 里别的东西都不动。

要在本地开发时用 checkout，就按路径安装——`dsh plugin` 是**链接**目录而不是拷贝：

```console
dsh plugin --profile desktop add <checkout 的绝对路径>
```

pnpm 会把它记成 `link:<路径>`。**不要把运行时状态写进被链接的目录**：profile 持有的是
指向它的活链接，往包目录里写临时文件、构建产物或日志，可能让宿主在会话运行期间重建组成。
`provision` 之所以写到 `<DSH_HOME>/dsh-ops/`，正是这个原因。

不启动也能先验证这一层，然后再启动：

```console
dsh --profile desktop --dump-config   # 会看到一段 "# == dsh-ops" 的层
dsh --profile desktop
```

agent 可以走 GUI 用的同一个服务安装：

```text
plugin_manager { action: "install_bundle", target: "<spec>" }
```

`install_bundle` 负责装包并选中 bundle，`remove_bundle` 是它的逆操作；这两步都不要在
profile 目录里用 shell 命令自己重做。它有两个入参在这里需要说明：

- `approvedBuilds` 是允许某个包的安装脚本在本机执行的授权，只有在用户明确同意后才传这
  些名字；
- `registry` 是用户点名时优先询问的 registry。

安装失败、被取消、或装上的包没有 bundle patch 时，profile 的 `package.json` 与
`pnpm-lock.yaml` 会被复原；已下载的文件可能留下。本插件自己没有安装脚本，也没有构建步骤。

从 npm 或 git 托管平台安装是同一个命令换 spec（`dsh-ops`、`@T-Auto/dsh-ops@<版本>`、
`github:T-Auto/dsh-ops`）。git 安装取到的是**源码而不是构建产物**，所以只有用
`prepare` 脚本自我构建的包才装得成——本包不需要，因为它直接发布 JavaScript。

### 安装带来什么

安装走的是上面那条 profile 命令，或 `plugin_manager` 的 `install_bundle` ——
**不是** `npm i -g`。插件必须成为**该 profile 自己的依赖**：把包装进去的同一个动作，
才是把它追加进 `dsh.profile.bundles` 的动作；全局安装只是把包装到机器上，装不进任何
profile。

进 registry 的那份包，会把本分发自己的平台包注入为可选依赖：

| 平台包 | 内容 | 体积 |
| --- | --- | --- |
| `@dsh-ops/fastctx-<平台>-<架构>` | 本 fork 自己的瘦身 FastCtx 构建，`bin/fastctx.exe` | 解包 49,492,480 B，打包 23.5 MiB |
| `@dsh-ops/bash-<平台>-<架构>` | 一枚 **pin** —— Git for Windows PortableGit 的上游 URL、release、版本与 SHA-256。**不含二进制** | 几 KB |
| `@dsh-ops/pwsh-<平台>-<架构>` | 一枚 **pin** —— PowerShell 7 的同样信息。**不含二进制** | 几 KB |

**两个 shell 的字节都不在我们发布的任何东西里**：它们留在上游，由
`dsh-ops provision-shells` 在**想要它的那台机器上**取回被 pin 的官方资产、按 pin 里的
SHA-256 校验，再解到 `<DSH_HOME>/dsh-ops/shells/<名字>/<版本>/`：

```console
node bin/dsh-ops.mjs provision-shells            # 两个 shell 都装
node bin/dsh-ops.mjs provision-shells --bash     # 从 Git for Windows 下 60,027,568 B，解包约 390 MiB
node bin/dsh-ops.mjs provision-shells --pwsh     # 从 PowerShell 7 下约 101 MiB，解包约 245 MiB
```

这些下载我们**既不转发、也不重新打包、更不再分发**：命令指向的是上游自己的 release
资产，校验 pin 记下的摘要，用上游自己的解包器解包。加载期不下载任何东西，不跑这条命令
就什么都不下载。

**没有它们只是阶梯更短，不是插件坏了。** 插件这边没有 bash（既没有 provision 出来的
副本，也没有包内副本），而 `allowSystemShellFallback` 为 true 时 `PATH` 与已知安装位置
里也没有，就没有第 2 级；插件这边没有 pwsh，就没有第 3 级，bundle patch 也就不动宿主的
`pwsh-sandbox` 行。机器上**本来就有**的 bash 或 PowerShell 7 会按下面的解析顺序继续
可用；`node bin/dsh-ops.mjs ladder` 会打印哪几级 live、各自出自哪里。

**同样这几份 tarball 也挂在对应 tag 的 GitHub Release 上**，旁边带一份 `SHA256SUMS`：
主包、本分发的 FastCtx 平台包，以及两个 pin 包。上游的东西都不是 release 资产。这条
通道不需要 registry 账号，除了一次下载之外也不需要网络：

```console
# Release 带 SHA256SUMS：把你下载的每个资产都对着它校验
sha256sum -c SHA256SUMS

# PowerShell：逐个文件比对该文件在 SHA256SUMS 里的那一行
(Get-FileHash .\dsh-ops-fastctx-win32-x64-0.2.0.tgz -Algorithm SHA256).Hash.ToLower()
Select-String -Path .\SHA256SUMS -Pattern 'dsh-ops-fastctx'

# 然后按路径安装你下载到的包
dsh plugin --profile desktop add <下载到的包路径>
```

Release 上的 tarball 就是同一批包的 npm tarball，所以 registry 会给你的文件和从
Release 下载到的文件是同一份字节。

## 更新

新版本需要什么，取决于改了什么：

| 改动 | 生效方式 |
| --- | --- |
| 某一行的 `config`（包括本插件的行） | 热生效，走 `ctx.hmr` |
| 某一行的 `disabled` | 热生效，走 `ctx.hmr` |
| 新装一个此前没加载过的 bundle | 可由 HMR 生效 |
| **替换**一个已安装的包 | **需要重启** |
| profile `dsh.profile.bundles` 的顺序 | **需要重启** |

区别在**模块世代**。HMR 服务（`ctx.hmr`：`runExclusive`、`watchConfig`、`getLinked`，
以及 `hmr/change`、`hmr/reload` 事件）能重新应用配置、能加载还没加载过的模块；但 Node
不会重新求值已经加载过的模块，所以**已安装的包**里的新 JavaScript 只有新进程才会读到。
上游把这条规则写得很直白：新装 bundle 可以经 HMR 激活，而**替换已安装的包必须重启**
才能加载新的 JavaScript 模块世代。

所以更新路径是：

```console
dsh plugin --profile desktop add dsh-ops@<版本>   # 或重新 add 本地路径
# 重启 DSH，然后再确认一次这一层
dsh --profile desktop --dump-config
```

只改配置则不需要这个重启。在 DSH GUI 里，Plugin Manager 的组件行编辑的是同一批值，
改不动时会给出 `restart-required`——那是诚实的答复，不是失败。

**运行时是例外。** FastCtx 可执行文件可以不重启 DSH 就换掉，因为插件拥有的是子进程
而不是一个已加载的模块：改 `config.binaryPath` 或 `DSH_OPS_FASTCTX_BIN`（行配置经
`ctx.hmr` 热生效），或把解析到的那个路径上的文件换掉，下一次连接就会 spawn 新的。
每次连接成功，插件都会重新发布那 9 个 `ops_*` 工具。

**阶梯跟随注册表，解析跟随挂载。** 第 1、2 级由「工具在不在册」决定，所以文案每次都
跟随活注册表 —— FastCtx 重连会重新发布整代工具，下一次读取就反映出来。解析与发布本身
发生在插件被应用的那一次，所以之后才装上或删掉某个 bash／pwsh，要等这一行被重新应用
（或 DSH 重启）才会生效；第 3 级就是这同一个事实，所以它不是「活注册表」问题。

## 卸载

```console
dsh plugin --profile desktop remove dsh-ops
```

agent 侧则是 `plugin_manager { action: "remove_bundle", target: "dsh-ops" }`。

卸载会同时删掉 profile 依赖与 bundle 层，这正是把 profile 退回安装前状态所需的两件事：
没有 `dsh-ops` 行、没有 `ops_*` 工具、没有提示词段。它**不会**删掉不属于 profile 的东西：

| 留下什么 | 为什么，以及该怎么办 |
| --- | --- |
| `<DSH_HOME>/dsh-ops/bin/fastctx[.exe]` 与 `<DSH_HOME>/dsh-ops/runtime.json` | 托管运行时及其回执。卸插件不等于删掉运维用 `provision` 装上的二进制。 |
| `<DSH_HOME>/dsh-ops/shells/` | `provision-shells` 下载并解开的两个 shell（如果跑过）。同一条规矩：卸插件不删它们，`dsh-ops uninstall --yes` 才删。 |
| `~/.fastctx/`（`config.toml`、`jobs/`） | FastCtx 自己的用户状态，不是本插件的。它按设计活得比插件久；除非要退役 FastCtx，否则别动。 |
| 本包与它带进来的平台包在 pnpm store 里的条目 | pnpm 自己的 store，和其它 profile 共享。都不要手工删。 |
| 提到过 `ops_*` 调用的会话记录 | 历史记录。它们照常可读，而没有这些工具的模型不会去调它们。 |

插件做的每一处注册——提示词段、`ops_*` 工具注册（托管的 9 个与 `ops_bash`）、子进程、
`tools/pre-execute` 栅栏，以及它给各 agent 装上的可见性遮罩——都由 `ctx.effect` 或
`ctx.on` 拥有，卸载即释放，因此运行中的进程里不会残留插件的东西。

`dsh-ops uninstall` 负责收尾 profile 之外的部分：它报告自己拥有的运行时目录
`<DSH_HOME>/dsh-ops/`（托管二进制、回执，以及已 provision 的 shell），带 `--yes` 时
删除它；不带 `--yes` 就是干跑。`~/.fastctx/` 只报告不删，只有加 `--purge-fastctx` 才
一并删除。

## 运行时与二进制来源

本包自己的 tarball 里没有任何 FastCtx 二进制，加载期也不会下载任何东西。它按以下顺序
查找：

1. `config.binaryPath` —— 权威；路径不可用即失败，不会继续往下找；
2. `DSH_OPS_FASTCTX_BIN`；
3. 托管副本 `<DSH_HOME>/dsh-ops/bin/fastctx[.exe]`；
4. 源码内构建产物 `vendor/fastctx/target/release/fastctx[.exe]`；
5. 本分发自己的平台包 `@dsh-ops/fastctx-<平台>-<架构>`（`optionalDependency`）；
6. 上游的 npm 平台包 `@fastctx/<平台>-<架构>`，如果该部署装了的话；
7. `PATH` 上的 `fastctx`。

全都找不到时，失败信息会列出每个候选以及它哪里不行。
`node bin/dsh-ops.mjs status` 会打印最终答案、版本号，以及该可执行文件**实际**
发布的工具列表。

显式配置的路径与 `DSH_OPS_FASTCTX_BIN` 都是权威的：两者之一指向不存在、或跑不起来的
东西时，解析就失败，而不是悄悄去托管另一个二进制。剩下的五步是偏好顺序，每一处未命中
都会被报告，而不是被跳过。

拿到运行时有三条路，且不互斥：

- **用安装带上来的那一份。** registry 安装会声明 `@dsh-ops/fastctx-<平台>-<架构>` 为
  可选依赖，于是解析链直接找到运行时，不需要再做任何事。见
  [安装带来什么](#安装带来什么)。
- **优先用 vendored 源码。** `vendor/fastctx/` 是完整的 FastCtx 源码，所以 checkout 可以
  把运行时**编译出来**，而不是信任一次下载；
- **provision 到托管位置。** `provision` 把那份构建安装到 `<DSH_HOME>/dsh-ops/bin/`，
  并在旁边写一份回执，让运行时跨包升级保持稳定，也让它待在**被链接的包目录之外**。

vendored 构建与 provision 都是随包 CLI 的命令：`build` 是对 `vendor/fastctx/` 的 Rust
构建，`provision` 是把结果放到解析最先找到的位置的安装步骤。需要 Rust 1.88 或更新
（Cargo 包是 edition 2024）。

```console
node bin/dsh-ops.mjs build        # 对 vendor/fastctx 执行 cargo build --release
node bin/dsh-ops.mjs provision    # 过期则重建，然后安装到 <DSH_HOME>/dsh-ops/bin
```

`provision` 会写 `<DSH_HOME>/dsh-ops/runtime.json`，记录来源、版本号和已安装
可执行文件的 SHA-256。工具链不在默认位置时，用 `CARGO_HOME`、`RUSTUP_HOME`、
`DSH_OPS_RUST_HOME` 或 `DSH_OPS_CARGO` 指定。

### 插件自带的两个 shell

FastCtx 下面那两级有自己的解析逻辑，而且全程只读：不写 `PATH`、不写 profile、不调
`process.chdir`；解析不到就报 `available: false`，绝不让插件加载失败。解析回答的是
「解析到哪个可执行文件、走哪条路、为什么不可用」——**详情与报告**；它**不决定**有没有
这一级：第 2 级在 `ops_bash` 发布出来时存在，第 3 级在自带可执行文件确实在时存在。

`ops_bash`（第 2 级）按以下顺序解析：

1. `config.bashPath` —— 权威；路径不可用即该级失败，不会退到另一个 shell；
2. **provision 出来的副本** —— `dsh-ops provision-shells --bash` 解开的那一份，
   `<DSH_HOME>/dsh-ops/shells/bash/<版本>/bin/bash.exe`；
3. **包内副本** —— 本包内的 `vendor/bash/<平台>-<架构>/bash.exe`，或一个真的带着它的
   已安装 `@dsh-ops/bash-<平台>-<架构>` 包；
4. `PATH` 上的 `bash`；
5. 已知安装位置（Git for Windows、Scoop、Chocolatey、msys64）。

第 4、5 步只在 `allowSystemShellFallback` 为 true 时使用。Windows 上的 WSL 启动器
`%SystemRoot%\System32\bash.exe` **刻意永不使用**：它不是跑在本文件系统上的 POSIX
shell。另外，解析到的 bash 还得**发布得出去**：宿主没有 subprocess 服务时就没有
`ops_bash`，也就没有第 2 级。

PowerShell 7（第 3 级）没有配置路径、没有 `PATH` 这一步、也没有自己的工具：本插件在这台
机器上确实有 pwsh 时这一级才 live，而真正跑它的是宿主自己的 `pwsh-sandbox` 行 ——
`cordis.patch.yml` 用一段 `!!js` 的 `pwshPath` 把它改指过去。pwsh 可能落在的**每一处
布局都按同一个顺序**探测：先是 `<DSH_HOME>/dsh-ops/shells/pwsh/<版本>/` 下 provision
出来的那一份，再是包内副本（本包内的 `vendor/pwsh/<平台>-<架构>/pwsh.exe`，或一个真的
带着它的已安装 `@dsh-ops/pwsh-<平台>-<架构>` 包）—— 也就是 `lib/shells.js` 里
`BUNDLED_LAYOUT_ORDER` 命名的顺序；patch 里那段表达式**实现的就是这同一个顺序**，并带
基于 `lstat` 的可用性判定（Windows Store 的执行别名算数、名叫 `pwsh.exe` 的目录不算）、
Windows 平台门，以及外层 `try`/`catch`。所以哪一处都没有 pwsh 的部署得到的是
`undefined` —— 也就是那一行自己的默认值 —— 宿主原来的 PowerShell 解析完全不受影响，
而阶梯里没有第 3 级。

这一处重写**故意没有配置键**：bundle patch 在本插件的行挂载**之前**就被求值，配置键
根本到不了那个表达式。不想要这次重写的 profile，在自己那份 `cordis.patch.yml` 里改掉或
删掉这条 entry 即可 —— 那一层在所有 bundle 层之后应用，拥有最后决定权。

两个 pin 包都不带可执行文件，所以 registry 安装**不会**顺带装上任何 shell：把 shell 放到
机器上的是 `dsh-ops provision-shells`；没跑过它的部署，用的就是机器本来就有的东西 ——
bash 走 `PATH` 与已知安装位置，第 3 级则回落到宿主自己的 pwsh 工具。解析不到某一级不是
错误，那只是一条更短的阶梯；`node bin/dsh-ops.mjs ladder` 会打印每级的可用性、各自出自
哪个可执行文件，以及按这个答案提示词实际会渲染哪几级。

## 工具面是怎么发布的

插件**自己** spawn FastCtx —— `fastctx serve`，`enableShellTools` 打开时再加
`--enable-shell` —— 并在挂载期间持有这个子进程。随后它在这条 stdio 上说 MCP，
一行一个 JSON-RPC 请求：连接时 `initialize` 与 `tools/list`，每次调用
`tools/call`，重连后重新 `tools/list`。服务端列出的每个工具都以 `ops_<名字>`
通过**本插件自己的** `ctx.tools.register` 发布，释放则用那次调用返回的 disposer
—— 一整代工具同生同灭。**本插件绝不改写共享工具注册表**：不给 `ToolRuntime`
实例挂任何自有属性，也不替换 `ctx.get('tools')` 上的任何方法。守住这条边界的
代价是一次事故 —— 给 `register` 装拦截器会让**每一个外来注册**都被当成本插件的
注册，于是宿主第二次注册 `subagent` 这样的名字就会抛错、**新建会话全部失败**
（2026-10-08）。机制、病征与钉住它的回归断言记在 [`PROVENANCE.md`](PROVENANCE.md)
的「The boundary the 2026-10-08 incident established」一节。

`ops_bash` 用的是同一套发布方式 —— 一个普通定义，通过**本插件自己的**
`ctx.tools.register` 注册、用那次调用返回的 disposer 释放 —— 所以
`dsh-plugin.json` 里的两个工具命名空间描述的都是本插件自己拥有的注册。

## 配置

每个键都可选，bundle patch 里写了默认值。未知键会让插件在加载时失败，而不是被忽略。

```yaml
- insert:
    - id: dsh-ops
      name: dsh-ops
      config:
        binaryPath: 'C:\tools\fastctx.exe'   # 默认：自动解析
        serverName: fastctx                  # 默认：fastctx
        enableShellTools: true               # 默认：true
        toolCallTimeoutMs: 300000            # 默认：300000
        required: false                      # 默认：false
        shellPolicy: advise                  # advise | deny-host-shell
        deniedHostTools: [pwsh, bash, pwsh_persistent]
        promptPolicy: true                   # 默认：true
        extraGuidance: ''                    # 追加到工具说明段
        bashPath: 'C:\Program Files\Git\bin\bash.exe'   # 默认：自动解析
        publishBashTool: true                # 默认：true
        allowSystemShellFallback: true       # 默认：true
```

- **`serverName`** —— 托管服务端自己的名字。它只决定 FastCtx 服务端自己的指令挂在哪个
  提示词段的段名下（`mcp:<serverName>`，放在宿主的 `MCP_SERVERS` 槽位）；它**不再是**
  工具命名空间 —— 每个工具都由本插件自己以 `ops_<名字>` 发布。
- **`required`** —— 为 true 时，运行时无法解析、无法验证或无法启动都会让插件激活
  失败。为 false（默认）时，插件记录失败、保留提示词策略，并让工具说明段保持为空，
  而不是让模型去调用并不存在的工具。
- **`shellPolicy`** —— `advise` 只注入策略；`deny-host-shell` 做两件事：把
  `deniedHostTools` 里的名字从每个新 agent 的视野里遮掉（`tools.restrict`，装在那个
  agent 自己的 scoped context 上），并在 `tools/pre-execute` 上按名字拒绝它们 ——
  后者才是保证，而且只由这个模式决定是否安装。遮蔽只在**本插件自己还有一级可用的
  shell** 时才提供（`ops_bash` 在册，或第 3 级 live）；一级都没有时宿主 shell 保持
  可见、栅栏照样拒绝，插件只报告一次原因。FastCtx 自己的工具永不被拒，所以跑命令的
  能力仍在。
- **`bashPath`** —— `ops_bash` 要跑的那个 bash，权威：路径不可用即第 2 级失败，而不是
  悄悄去跑另一个 bash。不设时优先 provision 出来的副本，其次包内副本，再次 `PATH`，
  最后已知安装位置。
- **`publishBashTool`** —— 设为 false 就完全不发布 `ops_bash`；无论 bash 是否解析成功，
  第 2 级都会从阶梯里消失。
- **`allowSystemShellFallback`** —— 设为 false 就把第 2 级限制在**本插件提供的东西**上
  （provision 出来的副本、包内副本，或 `bashPath`），并从第 3 级的报告里去掉「宿主的
  pwsh 工具是最后一档」那句。它**不**影响第 3 级跑不跑：宿主的 `pwsh-sandbox` 行跟随的
  是本插件自己的 pwsh 在不在。
- **`extraGuidance`** —— 原样追加到工具说明段，用来放部署特有的规矩。
- `pwshPath` 与 `overridePwshExecutor` **不是**键，现在按未知键报错并点名：bundle patch
  在本插件的行挂载**之前**就被求值，任何配置键都指挥不了第 3 级。见
  [插件自带的两个 shell](#插件自带的两个-shell)。

## 验证

```console
npm install
npm run verify      # dsh-std 清单门禁 + 测试套件
```

`npm run verify` 跑两道门禁：

- **`scripts/validate-manifest.mjs`** 用固定版本的 `@dsh-std/manifest`
  Community v0.15 解析器解析 `dsh-plugin.json`、做 host 投影，然后检查这个仓库
  有可能写错的关于自己的事实：版本与许可证和 `package.json` 一致、声明的 host
  入口与 bundle patch 存在、声明的**两个**工具命名空间与 `lib/policy.js` 一致
  （托管的 9 个 + 自注册的 `ops_bash`）、自注册命名空间里的每个工具都被「全级打开」
  的阶梯文案点名为 `ops_<名字>`、声明的提示词段就是实际注册的那些。共 47 项检查。
- **`node test/run.mjs`** 让每个 `test/*.test.mjs` 在各自进程、各自临时
  `DSH_HOME` 下运行 —— 7 个套件、133 项检查。挂载套件是**真实组合**：真实 Cordis
  `Context`、宿主真实的 `@deepseek-ai/dsh-tools` 注册表、
  `@deepseek-ai/dsh-system-prompt` 组装与 `@deepseek-ai/dsh-scope` 的 agent
  scope，以及由插件自己的 MCP 客户端 spawn 的真实 FastCtx 二进制。它断言 9 个工具
  完成注册、工具调用能跑通、两段提示词都渲染、`deny-host-shell` 拒绝 `pwsh` 而放行
  FastCtx 并在本插件自己还有一级 shell live 时把 `pwsh` 从新 agent 的视野里遮掉、
  卸载后不残留任何东西，以及**钉住那次事故的三条**：共享注册表上没有自有 `register`、
  同一个外来工具名在两个注册作用域里各注册一次都不被归到本插件名下、FastCtx 子进程
  永不继承形似凭据的环境名。shell 套件覆盖解析顺序与各种拒绝（`System32\bash.exe`
  永不当作 bash）、`ops_bash` 经一个只记录不执行的 subprocess 服务得到的 spawn spec、
  该定义能过真实注册表的 schema 门禁，以及 L3 覆盖与插件自己的探测在**每一处布局**上
  按**同一顺序**一致。policy 套件钉住阶梯：各级按序、缺级时重新编号、每一级跟随
  「工具在不在册」而不是解析结果，以及文案绝不承诺插件做不到的回退。

## 已知限制

- **FastCtx 自己的命令执行器是 POSIX bash。** Windows 上 FastCtx 会从环境里找 bash
  （Git for Windows 的 MSYS bash 可用；`dsh-ops provision-shells --bash` 也可以把一份
  放到 `<DSH_HOME>/dsh-ops/shells/`）。没有 bash 的部署应当设 `enableShellTools: false`；
  四个文件工具、`ops_bash` 与阶梯其它级都不受影响。
- **第 3 级取决于一个可执行文件落在三处布局之一，而其中只有一处由我们下载。** 本插件
  有 pwsh，这一级就 live；每一处可能的布局都由插件与改指宿主 `pwsh-sandbox` 行的
  bundle patch **按同一顺序**探测：先是 `<DSH_HOME>/dsh-ops/shells/pwsh/<版本>/` 下
  provision 出来的那一份，再是包内副本（`vendor/pwsh/<平台>-<架构>/pwsh.exe`，或一个
  真的带着它的已安装 `@dsh-ops/pwsh-<平台>-<架构>` 包）—— 也就是 `lib/shells.js` 的
  `BUNDLED_LAYOUT_ORDER`。任何一处都没有这个可执行文件时，表达式给出 `undefined`、宿主
  那一行原样不动，阶梯里也没有 PowerShell 这一级。profile 在自己那份
  `cordis.patch.yml` 里改指或删掉这条 entry，就完全压过插件的设定。
- **第 2 级要的不只是 bash，还需要宿主的 subprocess 服务。** 只有 bash 解析成功**并且**
  挂了 `ctx.subprocess` 时才会发布 `ops_bash`；没有那个服务时插件什么都不发布、只在
  告警里点名解析到的 bash，阶梯里也没有第 2 级。宿主 base bundle 构成的 profile 都挂了
  那个 provider（`@deepseek-ai/dsh-subprocess-local`）。
- **服务端死掉后，工具会一直挂着，直到重连预算耗尽。** 崩溃是**事件**而不是一次失败
  的请求，所以插件在两次调用之间就发现并报告它；`ops_*` 注册**不会**被撤下，调用会
  立刻大声失败（`ops_grep is unavailable: …`）。只有连续 10 次重连失败后插件才注销
  它们，工具说明段也在那时才变空。这里没有通知机制，只有下一次读取。
- **MCP 客户端是本插件自己的，而且刻意做得很小。** `lib/handshake.js` 说的是换行
  分隔的 JSON-RPC 2.0，只实现本插件用得到的那几个方法：`initialize`、
  `notifications/initialized`、`tools/list`、`tools/call`、`close`。需要 MCP 其余
  面（resources、prompts、sampling、服务端发起的请求）的服务端不受支持。
- **外来工具占用了某个 `ops_` 名字，代价是整代工具。** 工具是**一整代**发布的：只要
  本插件作用域里已经有人注册了某个 `ops_<名字>`，这一代就整体回滚，本次尝试按连接
  失败上报，而不是发布半张工具面。
- **vendored FastCtx 已削成纯 MCP 服务端。** 上游的控制终端、自更新器与 Codex
  集成是**删掉**而不是「留着但不可达」，二进制里只剩 `serve` 与 shell/session
  机制内部使用的子命令入口。本 fork 改过的每个 `src/` 文件都带自己的
  Apache-2.0 §4(b) 改动声明。见 `vendor/fastctx/FORK.md`。

## 许可证

本分发采用复合许可证表达式 **`MIT AND Apache-2.0`**：

- **dsh-ops 插件**（除 `vendor/fastctx/` 之外的一切）为 MIT（`LICENSE`）；
- **vendored FastCtx 源码**（`vendor/fastctx/`）为其作者的 Apache-2.0
  （`vendor/fastctx/LICENSE-APACHE`、`vendor/fastctx/NOTICE`）。

完整声明见 [`NOTICE`](NOTICE)。

## 致谢

FastCtx 是 [yc-duan](https://github.com/yc-duan) 的作品。本插件是它的一个分发
形态，而不是它的替代品：没有上游的运行时、工具设计与输出纪律，这里什么都不会
存在。

FastCtx 的 `NOTICE` 要求逐字转载下面这段致谢，以下即逐字转载：

> This product includes FastCtx
> (https://github.com/yc-duan/fastctx), Copyright (c) 2026 yc-duan,
> used under the Apache License 2.0.
>
> FastCtx is redistributed and/or modified here by the maintainer of
> this distribution. Any such change is that maintainer's own work
> and their sole responsibility. It is not endorsed by, not
> supported by, and not attributable to the author of FastCtx, who
> accepts no liability of any kind arising from this distribution or
> from anything built on top of it.

### 改了什么

`vendor/fastctx/` 是上游 `main` 在
`ccaa157790d02328a60786eb94ee5ad698995a5f` 的快照，移除了上游的分发与 CI
机器：`.github/`、`packages/`（npm launcher、`codex-fastctx` 包、五个
`@fastctx/<平台>` 二进制包）、`scripts/`（PowerShell 发布工具）。**没有修改任何
FastCtx 源码文件**。每处差异都列在
[`vendor/fastctx/FORK.md`](vendor/fastctx/FORK.md)，固定的 revision 记在
[`vendor/fastctx/UPSTREAM.md`](vendor/fastctx/UPSTREAM.md)。
