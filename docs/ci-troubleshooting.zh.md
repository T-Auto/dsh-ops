# CI 排错说明

`ci.yml` 里的每一个 job 都是合并门禁，`release.yml` 拒绝从未经验证的 commit 或被移动过的 tag 发布。所以一条红检查**一定**对应某种东西：缺陷、缺工具链、环境问题，或者在跑完之前被取消。本页是自查路径——先做 60 秒定位，再按日志关键字跳到对应小节。

英文版本：[ci-troubleshooting.md](ci-troubleshooting.md)。

## 0. 60 秒定位

```console
gh pr checks <pr>                                        # 哪一项红、对应 job URL
gh pr view <pr> --json mergeStateStatus,reviewDecision    # 这里的 BLOCKED 是「待审核」，不是 CI 红
gh run view <run-id> --json event,conclusion,jobs --jq '.jobs[] | .name + " => " + .conclusion'
gh run view <run-id> --log-failed                         # 失败 step 的日志
```

读堆栈之前先确认四件事：

1. **什么事件触发的？** `pull_request`、`push`、`workflow_dispatch`、`merge_group`、`dynamic`。分支上的 `workflow_dispatch` 是 dry run；fork PR 的第一次 run 可能停在 `action_required`（见 §2.1）。
2. **是不是被取消了？** `conclusion: cancelled` 表示有更新的 push 顶掉了这次 run（PR 上的 `concurrency.cancel-in-progress`）。被取消 run 的红聚合不是缺陷信号——重跑即可。但如果取消前某个阻塞 job 已经真失败，那部分要看。
3. **是 job 红还是 run 红？** `gh run view <run-id> --json jobs` 指出哪个 job 失败。在 `ci.yml` 里 run 级红只会是 `CI required` 判到了某个 job 失败。
4. **是门禁还是发布链路？** `ci.yml` 与 `release.yml` 互相独立；tag run 只会在 `v*` tag（或手动 dispatch）出现。

如果 `gh run view --log-failed` 报 `stream error` 或漏掉失败行（大 step 会出现），直接下完整日志包：

```console
gh api repos/T-Auto/dsh-ops/actions/runs/<run-id>/logs > run.zip && unzip -o run.zip -d run-logs
# 或单个 job：
gh api repos/T-Auto/dsh-ops/actions/jobs/<job-id>/logs
```

## 1. 索引：日志行 → 小节

| 看到什么 | 去哪看 |
| --- | --- |
| 0 个 job、红叉、`action_required` | §2.1 fork 审批 |
| job 显示 `cancelled` | §2.2 被顶掉的 run |
| `npm ci` / `rustup` / cache 期间 `ENOTFOUND`、`ECONNRESET`、registry 报错 | §2.3 网络 |
| `No space left on device` | §2.4 磁盘 |
| `check-workflows: N of M check(s) failed` | §3.1 workflow-lint |
| `check-file-size: … FAIL` | §3.2 source-size |
| `rustfmt` diff / `warning: … clippy` / `error: could not compile` | §3.3 rust-lint |
| `verify-gate` 里 `step failed (…): <step>` | §3.4 门禁步骤 |
| `--- <suite> exited 1` | §3.4.7 某个套件失败 |
| `--- <suite> skipped while DSH_OPS_REQUIRE_RUNTIME=1` | §3.4.3 不允许的 skip |
| `suites skipped that must not skip on <target>` | §3.4.4 skip 策略 |
| `the runner discovered N suite(s); M test file(s) are on disk` | §3.4.2 套件清单 |
| `manifest checks: expected at least 59` | §3.4.5 manifest |
| `no suite summary line` | §3.4.6 runner 死掉/超时 |
| `grep -Eq 'statically linked'` 失败 | §3.4.8 musl |
| `native-runtime check` 报错 | §3.4.9 运行时闭包 |
| `niu: line 1: … Permission denied` | §3.5.1 Niubash 执行 |
| `Pinned Bash is unavailable` / `DSH_OPS_TEST_BASH` | §3.5.2 Bash 载荷 |
| `EPERM … .tgz.modes-…` 重命名 | §3.5.4 EPERM |
| `no FSEvents event … within 30s` | §3.6 macOS |
| Node 22.19 上 `spawnSync … ETIMEDOUT` | §3.7 node floor |
| `tools-trial: N tool(s) failed` / `tools-trial-report.md` | §3.8 tools trial |
| `CI required` 打印出非 `success` 的 job | §3.9 聚合 |
| `tag vX does not match the package version` | §4.2 |
| `tag … points at …, but this run builds …` | §4.3 tag 被移动 |
| `no successful 'CI required' check` | §4.4 commit 未验证 |
| `check-release` / receipt / `SHA256SUMS` 不匹配 | §4.5 发布闭包 |
| `Publish the GitHub Release` 显示 skipped | §4.6 不是 tag / dry run |
| `gh release upload` 缺资产报错 | §4.7 只追加发布 |

## 2. 任何 job 开始之前

### 2.1 fork PR：红叉但 0 个 job

fork PR 的第一次 run 需要维护者批准（`conclusion: action_required`）。有些 fork run 完全不启动，被记为 `failure` 但**没有任何 job**、没有 annotation——这是 fork 审批/权限门，**不是**贡献者的代码问题。不要让贡献者「修 CI」，批准即可：

```console
gh api -X POST repos/T-Auto/dsh-ops/actions/runs/<run-id>/approve
```

同样的机制也解释了「PR head 早于当前 `ci.yml`」的情况：`pull_request` 事件读的是 PR 自己的 workflow 文件，旧分支跑的是旧 workflow（或什么都不跑）。请对方 rebase。

### 2.2 被取消的 run

`ci.yml` 用 `concurrency: cross-platform-${{ github.ref }}`，`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`。新 push 会取消上一条 PR run。被取消的 job 不是缺陷证据——重跑。只有在取消**之前**阻塞 job 已经真失败时才需要读它。

### 2.3 网络、registry 与缓存

如果只有这一步失败、重跑就绿，按环境问题处理：

- `npm ci` — `ENOTFOUND`、`ECONNRESET`、`EAI_AGAIN`、registry 5xx；workflow 用 `--ignore-scripts --registry=https://registry.npmjs.org`。
- `rustup toolchain install 1.97.1` — 工具链下载失败。
- `actions/cache` — restore/save 的告警不致命，save 失败不会让 job 红。
- `actions/upload-artifact` — `Failed to CreateArtifact: … ENOTFOUND` 是 GitHub 侧 DNS 抖动，不是 action 版本问题；重跑即可（235 次里只出现过 1 次）。
- 发布门禁里的 `gh api` / `git ls-remote` — 5xx 或 DNS 失败会让 gate 红；重新 dispatch。

### 2.4 磁盘

托管 runner 约 14 GB。Windows 腿要装固定的 Bash 载荷（411 MB）与 Niubash 载荷；macOS 的 cargo 缓存约 1.3 GB。`cargo test` 或 `npm ci` 期间 `No space left on device`，通常是「旧的大 tree 留下的 `native/target` 缓存 + 载荷下载」叠加。删缓存条目或换缓存 key，产品代码无需改动。

## 3. 逐个门禁的错误字典

### 3.1 `workflow-lint` — `scripts/check-workflows.mjs`

每条失败都是结构不变量，不是测试。消息本身说明了要改哪里；改 workflow 或 lint 常量，绝不改断言本身。

| 消息片段 | 含义 | 处理 |
| --- | --- | --- |
| `every job is classified in EXPECTED_BLOCKING / EXPECTED_NON_BLOCKING` | `ci.yml` 加了 job 但没分类 | 把 id 加进 `scripts/check-workflows.mjs` 的 `EXPECTED_BLOCKING`，以及 `ci-required` 的 `needs` 与失败循环 |
| `"CI required" waits on exactly the blocking jobs` | `needs` 与常量不一致 | 改 `needs` |
| `failure loop covers exactly the blocking jobs` | `for job in …` 循环与常量不一致 | 改循环 |
| `no blocking job sets continue-on-error` | 有门禁「退出」了 | 去掉 `continue-on-error`；只有测量类 job 才应移到 `benchmark-gates.yml` |
| `"CI required" runs even when a dependency fails` | 丢了 `if: always()` | 加回来 |
| `native/rust-toolchain.toml pins a channel` / `rustup installs the toolchain pinned by …` | Rust 版本在文件与某个 workflow 之间漂移 | 两处改成同一 channel |
| `release.yml: refuses a tag that was force-moved …` / `requires a green CI required check` / `runs the same verify-gate` / `checks the release closure` / `publishing is append-only` | 发布守卫被删除或改名 | 按名字找回 step；删掉这些守卫只有 lint 会发现 |
| `release.yml: the gate may read the tagged commit's check runs` | 丢了 `checks: read` | 恢复 job 权限 |
| `benchmark-gates.yml: carries the bench smoke` / `schedules the measurement monthly` | 测量 job 位置或 schedule 被改 | 放回 `benchmark-gates.yml`；它不能回到 `ci.yml` |
| `does not ask for write-all` / `does not use pull_request_target` | 安全不变量 | 去掉；越权 workflow 应重设计，而不是豁免 |

### 3.2 `source-size` — `scripts/check-file-size.mjs`

某个被 git 跟踪的代码文件超过 1000 行。拆模块（仓库里已有 `src/shells/`、`scripts/lib/build/`、`bench/lib/fixtures/` 的先例）。不要提上限、不要加排除。本地 `node scripts/check-file-size.mjs` 会列出文件。

### 3.3 `rust-lint` — 格式与 clippy

工具链由 `native/rust-toolchain.toml`（1.97.1，含 rustfmt/clippy）钉住。本地必须用同一个：

```console
cargo +1.97.1 fmt --all --manifest-path native/Cargo.toml            # 修复
cargo +1.97.1 fmt --all --check --manifest-path native/Cargo.toml    # 校验（CI 跑的就是这条）
cargo +1.97.1 clippy --workspace --all-targets --locked --manifest-path native/Cargo.toml -- -D warnings
```

- `cargo fmt` 失败：永远用钉住的工具链跑 formatter，不要手改格式。不同 rustfmt 版本结果可能不同，这正是版本只写在一处的原因。
- `clippy` 失败：`-D warnings` 把每条 lint 变成错误。本地复现后，要么按建议改（`cargo clippy --fix`），要么在**该处**用注释说明并只静音那一条 lint。不要加 crate 级 `#![allow(...)]`。
- 新的 Rust 版本会引入新 lint；版本被钉住，所以 lint 集合只有在改 `native/rust-toolchain.toml` 时才会变——那应该在单独 PR 里做。

### 3.4 功能门禁（`validate-posix`、`validate-macos-intel`、`validate-windows`、`node-floor`）

它们跑同一个入口：

```console
node scripts/verify-gate.mjs --skip-install
```

顺序是：`node --version`、`cargo --version`、`npm run build`（tsc）、`cargo test --workspace --locked`、`npm run build:ptc`、`npm run stage:niubash`、（Windows）legacy MSYS fixture + `npm run build:bash-ipc`、`npm run validate:manifest`、`npm run verify`（全部套件）、`native-runtime check`、`npm pack`、解包、对包内再 check。失败会打印 `step failed (<code>): <step>` 和 summary；之后 6 条断言专门抓「静默失败」。

#### 3.4.1 `step failed (101): native worker unit tests`

`cargo test --workspace --locked` 失败。这是 Rust 单测/集成测试，读 `---- <test> stdout ----`。本地：

```console
cargo +1.97.1 test --workspace --locked --manifest-path native/Cargo.toml
cargo +1.97.1 test --workspace --locked --manifest-path native/Cargo.toml <filter> -- --nocapture
```

macOS 专属测试（`ops-mac-index`、FSEvents、ACL clone 路径）与 Windows 专属测试（`windows-metadata`、UNC）在 Linux 上复现不了。如果失败的是托管 runner 上的计时测试，先看 §5 再改代码。

#### 3.4.2 `the runner discovered N suite(s); M test file(s) are on disk`

每个 `test/*.test.mjs` 都必须被收集。常见原因：套件文件改名但旧名仍被引用；套件在打印汇总行前崩溃；平台门槛写成了「发现过滤」而不是 skip。本地数一下即可：

```console
ls test/*.test.mjs | wc -l
DSH_HOME=$(mktemp -d) node test/run.mjs        # 打印 "N suite(s) passed, M skipped"
```

#### 3.4.3 `--- <suite> skipped while DSH_OPS_REQUIRE_RUNTIME=1`

POSIX 上门禁设置了 `DSH_OPS_REQUIRE_RUNTIME=1`，套件说「这台机器答不了」就变成失败。典型原因：

- 原生 worker 没构建/没 stage —— 先 `npm run build:ptc`（门禁自己会跑；若这里失败说明前一步 worker 构建已失败）；
- `niubash-consumer` / `niubash-payload-integration` 因缺 `DSH_OPS_NIUBASH_ARCHIVE` 而 skip —— 门禁会自己 stage 冻结归档，所以 skip 说明 `stage complete frozen Niubash payload` 失败了；
- Windows 上没设 `DSH_OPS_TEST_BASH` 且 legacy MSYS fixture provision 失败；
- `mount` 因没有可解析的原生 worker 而 skip（POSIX 只在这种情况允许 `mount` skip；其它原因跳过会同时触发下面的 skip 策略）。

允许跳过集合在 `scripts/verify-gate.mjs`：

- POSIX（`linux-x64`、`darwin-arm64`、`darwin-x64`）：`mount`、`result-storage-cache-prep`、`windows-security`、`niubash-consumer`、`niubash-security-host`，加上可选外部 checkout 的 `tui-host`、`tui-native`（`DSH_OPS_ALLOW_SKIPS`）。
- Windows（`win32-x64`）：`file-metadata`、`linux-attributes`、`linux-shell`，以及同一组外部套件。

其它任何 skip 都是缺陷——这是设计。不要为了转绿往集合里加名字：skip 不是通过。

#### 3.4.4 `suites skipped that must not skip on <target>`

同一条策略，按名字报出来：某套件跳出了平台允许集。修套件（或它需要的环境），不要在没有说明的同一 PR 里放宽集合。

#### 3.4.5 `manifest checks: expected at least 59, got none`

`npm run validate:manifest` 失败或打印的检查数低于下限。下限是下限、不是当前计数。读 `manifest contract` 步骤输出；validator 崩掉时什么都不会打印。

#### 3.4.6 `no suite summary line; the runner did not finish`

runner 死了（OOM、测试外的 panic、子进程死掉）。看 `full suite verification` 输出末尾。如果是 deadline，会打印 `--- <suite> exceeded the <N>s suite deadline`，直接判失败、不重试；检查挂死或资源争用，不要靠调大超时掩盖。

#### 3.4.7 `--- <suite> exited 1`

套件本身失败。每个套件会打印 `FAIL <检查名>` 与断言；读了之后本地复现：

```console
DSH_HOME=$(mktemp -d) node test/run.mjs <filter>
```

`DSH_HOME` 必须是新的临时目录，否则 harness 拒绝运行。

#### 3.4.8 `file runtime/linux-x64/dsh-ops-worker | grep -Eq 'statically linked|static-pie linked'`

Linux worker 不是 musl 静态二进制。前一步（`build-ptc --target x86_64-unknown-linux-musl`）必须执行；`gnu` 构建或缺 target 会产出带 GLIBC 下限的动态二进制，在更老的宿主上会坏。

#### 3.4.9 `native-runtime check` —— staged 或 packed 运行时闭包

`runtime/<target>/` 或包内 `runtime/` 缺 worker、架构不对，或丢了 `provenance.json` 收据。检查构建产物：

```console
node bin/native-runtime.mjs check --platform linux-x64
ls runtime/linux-x64/
tar -tzf dist/*.tgz | grep '^package/runtime/' | head
```

### 3.5 Windows 专属

#### 3.5.1 `niu: line 1: … Permission denied`

Niubash 载荷无法执行被指定的文件。已知的真实缺陷在相关 issue 里跟踪；重复出现就是产品缺陷，不是 runner 问题。先收集套件打印的完整 `replace`/`bash` stderr（命令与退出码），再开 issue。

#### 3.5.2 `Pinned Bash is unavailable. Run dsh-ops bash-runtime install, or set DSH_OPS_TEST_BASH …`

固定的 legacy Bash 载荷不在 `node_modules/@dsh-ops/bash-win32-x64`（由 `npm ci` 安装），且没有显式 `DSH_OPS_TEST_BASH`。发布门禁会显式 provision；CI 腿依赖 `npm ci`。检查 `npm ci` 是否按 `--ignore-scripts` 跑过（它仍会安装该载荷包）、以及平台过滤步骤没有把它删掉。

#### 3.5.3 `UNC directory regression`

该步骤挂载 `\\localhost\C$\dsh-ops-unc` 并跑 `--ignored` 的 Rust 测试。它依赖托管 Windows 镜像暴露管理共享；镜像变更可能让它以 mount 错误失败。mount 错误按镜像漂移上报，断言失败按 `ops-search` 真实缺陷处理。

#### 3.5.4 `EPERM: operation not permitted, rename '….tgz.modes-…' -> '….tgz'`

tar 模式修复会把兄弟文件 rename 覆盖打包后的 tarball；Windows 上可能有人（杀软、未退出的 `npm pack` 子进程）持有句柄。它是环境相关的：先重跑该 job，看同一 commit 是否再次失败。**第二次仍失败**就按打包路径缺陷处理，不要当 flake。

### 3.6 macOS 专属

- `no FSEvents event for … within 30s` —— `native/crates/ops-mac-index/src/fsevents_tests.rs` 里的投递上界。它是**有界等待**，不是延迟断言；忙碌的托管 runner 上投递可能晚十几秒。如果反复触发，应按 stream 代码缺陷处理，而不是继续调大上界。
- `macos-15-intel` 腿更慢（中位 ~494 s，p99 ~1292 s），30 分钟 job 超时就是为它留的；不要用「减少工作量」来让慢 run 变绿。
- 大小写不敏感文件系统：同一目录里创建 `Foo` 与 `foo` 的测试在这里行为不同，用可区分的名字。

### 3.7 `node-floor`

在声明的 Node 下限（22.19）上跑同一个门禁，单宿主。只在 22.19 复现的失败是真实的支持边界问题（用了高于下限的 API）。Windows + 22.19 的三个 npm-pack 套件失败跟踪在 #774 —— 在该问题解决前不要把 Windows 腿加回来。

### 3.8 `tools-trial`

`node scripts/tools-trial.mjs` 在临时 `DSH_HOME` 下启动真实宿主并调用每个已发布工具。`FAIL` 就是工具坏了：修掉或回滚破坏它的改动。带原因的 `skipped` 不是失败（这个 build 还没发布的工具），报告会以 `tools-trial-report` 上传。本地复现：先 `npm run build`、`npm run build:ptc`，再跑该脚本。

### 3.9 `CI required`

聚合 job 会逐行打印每个阻塞 job 的结果。这里红说明某一行不是 `success`，没有别的失败要查。如果每行都是 `success` 而聚合仍红，是 workflow 接线坏了（见 §3.1 的 `needs`/失败循环断言）。某 job 因 run 被取消而 `skipped`，重跑即可。

### 3.10 bench smoke（`benchmark-gates.yml`）

它是测量，永远不是合并门禁：只按 dispatch 与每月 schedule 跑，红也不挡任何东西。失败时证据在 `benchmark-gates.json` / `bench-smoke-*-report`。它只断言确定性结果（corpus 能建能删、同一 worker 两次回答一致、每个查询落在 `MATCH` 或声明的 `EXPECTED_*`），从不断言时长。不要把它的耗时变成门禁——共享 runner 的时序就是噪音。

## 4. 发布链路（`release.yml`）

### 4.1 它根本没跑

`release.yml` 只对 `v*` tag 的 `push` 或手动 dispatch 运行。分支 push、PR 永远不会发布。

### 4.2 `tag <name> does not match the package version v<version>`

tag 与 `package.json` 不一致。在 PR 里改版本、合并，然后给合并 commit 打 tag——绝不要移动 tag。

### 4.3 `tag <name> points at <commit>, but this run builds <commit>`

tag 在 run 排队后被 force-move 了（或 dispatch 的 ref 不是 tag 的 commit）。发布不可变，因此拒绝。发新版本。如果 tag 确实指向本次构建的 commit，重新 dispatch 同一 tag 来补齐中断的发布——它只追加缺失资产。

### 4.4 `the tagged commit <sha> has no successful 'CI required' check`

发布门禁要求 tag commit 的 `CI required` 为 `success`。原因：commit 直推 main 没跑 CI；跑失败；check 超出保留期；check 名变了。让 commit 走 PR 过 CI，或选对 commit——不要绕过这个守卫。

### 4.5 `check-release` / receipt / `SHA256SUMS` 失败

门禁会校验：四个目标齐全；每个 `provenance.json` 收据与 staged 字节一致；Windows IPC 二进制与源码摘要一致；manifest 与 runtime 白名单一致。按它指出的目标/收据排查：

```console
node bin/check-release.mjs
ls runtime/*/provenance.json
```

部分 artifact 下载、过期收据（重建了 worker 但没重新 stage）、缺目标，都会在这里失败而不是发出去。

### 4.6 `Publish the GitHub Release` 显示 skipped

`publish` 只在 `github.ref_type == 'tag'` 时运行。在分支（包括 `main`）上 dispatch 就是 dry run：构建、门禁、打包，然后停住——这是推荐的演练方式。

### 4.7 `publish` 因缺资产/已存在资产失败

发布是「只追加」：已有 Release 只接收缺失的资产。同名资产已存在且字节不同时不会替换（没有 `--clobber`）——请升版本。如果确实是文件缺失导致上传失败，重新 dispatch 同一 tag 与 commit。

### 4.8 npm 没有被发布

这是设计。`npm publish` 需要本仓库不授予 Actions 的 `NPM_TOKEN`；见 [release-process.md](release-process.md)。

## 5. 噪音还是缺陷？

- **被取消** → 噪音，重跑。
- **fork 审批 / 0-job 失败** → 不是代码，批准。
- **网络 / DNS / registry** → 只有这一步失败且重跑绿时算噪音；同一步反复出现就开 issue。
- **托管 runner 上的计时测试** → 看同一 commit 在其它平台（Intel vs arm64、Windows vs Linux）是否绿、断言是否有有界等待。如果只是等待时间不够，那是**该宿主**的上界太紧——在修复里说明，不要改成重试循环来掩盖真实的 stream 缺陷。
- **flake 还是缺陷** → 同一 commit 跑两次。同一 job 第二次仍红 = 缺陷；同 commit 重跑变绿 = flake 候选：带上两个 run id 记录，让下一个人能判断比例。
- **runner 镜像漂移**（同一 commit，某个平台因镜像/工具假设失败）→ 从日志记下镜像版本（`ImageOS`、`ImageVersion`），再调整步骤。

噪音可以重跑，**但重跑不是缺陷的修复**：门禁翻转前 30 天的审计里 20 次重跑，没有一次把真实失败变成绿。

## 6. 本地复现

```console
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run build                                            # tsc + 资源
npm run build:ptc                                        # 原生 worker（多数套件需要）
cargo +1.97.1 test --workspace --locked --manifest-path native/Cargo.toml
node scripts/check-workflows.mjs                          # workflow lint
node scripts/check-file-size.mjs                          # 1000 行门禁
node scripts/tools-trial.mjs                              # 工具试用
node test/run.mjs <filter>                                # 单个/少量套件
DSH_HOME=$(mktemp -d) node scripts/verify-gate.mjs --skip-install   # 完整门禁
node scripts/apply-ruleset.mjs                            # admin：规则集 dry run（永不在 CI 跑）
```

Windows 上 `DSH_OPS_TEST_BASH` 指向校验过的固定 `bash.exe`（门禁会 provision），`DSH_OPS_TEST_NIUBASH` 指向 staged 的 `niu.exe`。CI 会设 `DSH_OPS_SUITE_TIMEOUT_MS`（300 s；Windows 600 s）；`DSH_HOME` 必须是临时目录。`DSH_OPS_TEST_JOBS` 可覆盖有界工作池的并发数（默认宿主可用并行度，`1` 为串行）。每套完成后整块打印输出与耗时，末尾列出最慢的十套；修改共享 payload 属性或重建 checkout 的套件在并行池结束后独占运行。

## 7. 不要做

- **不要**为了转绿移动或删除已发布的 tag；发新版本。
- **不要**给发布步骤加 `--clobber`。
- **不要**删除或削弱 skip 断言来让门禁变绿；补齐运行时或修套件。
- **不要**在没有说明和测试的情况下放宽 `ALLOWED_SKIPS` 或 `EXPECTED_NON_BLOCKING`。
- **不要**用调大 job 超时掩盖挂死、或用调大套件 deadline 掩盖慢测试。
- **不要**用重试通过确定性失败；deadline 失败也不重试。
- **不要**把修复直接 push 到 `main`；发布门禁检查的 `CI required` 就在那条路径上。

## 8. 已知问题登记

| 症状 | Issue | 状态 |
| --- | --- | --- |
| `linux-protocol` 的 "concurrent replaces of one file are atomic" 在 macOS 无关 run 中偶发失败 | #163 / #168 | 未关闭；真实原生并发窗口，需要 stress 复现 |
| Windows + Node 22.19 下三个 npm-pack 套件失败（`ETIMEDOUT`、`EPERM` rename） | #774 | 未关闭；修复前 `node-floor` 保持单宿主 |
| `replay_from_a_persisted_id_reports_a_new_file` 打不满 FSEvents 投递上界 | #775 | 已缓解（30 s 上界）；根因未关 |
| fork PR run 红但 0 个 job | #150 / 本页 §2.1 | 不是缺陷；审批流程 |
| `Release` 曾是 `disabled_manually`、tag 被 force-move | #767 | 已修复；发布已不可变 |

## 9. 新增门禁时

在**同一个 PR** 里给本页加一节：它断言什么、人看到的原始日志行、本地复现命令、触发时怎么办。没有登记的門禁，第一次红一定会被从零开始 debug。
