# 发布流程

对象是 `.github/workflows/release.yml`（workflow 名 `Release`）。发布目标只有一个：**GitHub Release**（tag + 自动 notes + 一个可安装主包 tarball + `SHA256SUMS`）。npm publish 不在这条流水线里，理由见下。

> 指纹口径：外部产物的字节以 `SHA256SUMS` 为准——the bytes of every external artifact are authoritative in `SHA256SUMS`; the Release body (notes) never defines a checksum, and a run summary is only a copy of that manifest. 因此本流程保证：`SHA256SUMS` 一旦发布就是该版本字节的权威记录，之后的发布只能补齐缺失资产，不能替换它（见下节）。凡公布的指纹都必须写明对象（哪一个文件的指纹），不得只手抄数值。

## 当前状态（2026-11-07 复核）

`Release` 是 **active**，并且已经端到端发布过：`v0.5.0` 于 2026-11-06 由 CI 发布（run `42154208390`，03:38Z），同日又因 tag 被移动而重发一次（run `42190984366`，09:15Z）。

> 历史记录：`v0.5.0` 的 tag 曾在一天内被 force-move 四次（`dda1d955` → `1a9e0e22` → `b5cd8c4e` → `904b4faa`），其中一次是在 `main` 的 5 条 validate 腿全红的 commit 上打的 tag；已发布的资产随后被 `--clobber` 覆盖。**这正是本流程现在禁止的两件事**，见下节。

## 三条不可违反的纪律

1. **tag 不可移动。** 发布只接受「tag 当前指向的 commit == 本次构建的 commit」。tag 被移动过则 `gate` 直接失败并提示发新补丁版本；**不允许**为了修一条红而 force-move 已发布的 tag。
2. **发布必须来自验证过的代码。** tag 触发的 run 会在 `gate` 里检查该 commit 的 `CI required` check 是否为 `success`；`main` 红着的时候不能发版。
3. **发布只追加，不覆盖。** 已有 Release 时只上传缺失的资产；**不使用 `--clobber`**。中断的发布可以重跑同一 tag 补齐，但已发布的字节不允许被替换。

`docs/PROVENANCE.md` 的约定随之成立：`SHA256SUMS` 一旦发布就是该版本字节的权威记录，不会再被后来的一次发布改写。

## 触发条件

| 触发 | 行为 |
| --- | --- |
| `push` tag `v*` | 完整跑：四个目标构建 → 门禁 → 打包 → 创建/补齐 GitHub Release |
| `workflow_dispatch`（ref 是分支，如 `main`） | **dry run**：构建 → 门禁 → 打包 → 上传 artifact，`publish` 因 `github.ref_type != 'tag'` 被跳过，且运行期不授予写权限 |
| `workflow_dispatch`（ref 是已存在的 tag） | 完成一次中断的发布：每一步幂等，只补缺失资产；tag 若已被移动则拒绝 |

没有其它隐式触发：普通 push、PR 都不会走到这里。

## 流水线三段

1. **`native`（矩阵：`windows-latest`/`win32-x64`、`ubuntu-24.04`/`linux-x64`、`macos-latest`/`darwin-arm64`、`macos-15-intel`/`darwin-x64`）**
   - 只构建 `lib/ptc/runtime.js` 声明的四个目标；Windows ARM64 与 Linux ARM64 不在矩阵内。
   - 固定 Rust 1.97.1（`native/rust-toolchain.toml`）与锁定的 `Cargo.lock`；npm 平台名与 Rust triple 分列。Linux x64 使用 musl 静态链接，stage 之后用 `file` 断言静态链接，回退到 gnu triple 会在这里失败。
   - `bin/native-runtime.mjs stage` 为目标写 `runtime/<target>/provenance.json`（version／target／executable／sha256）；缺二进制或不是常规文件都报错。
   - Windows 目标额外跑 `npm run build:bash-ipc` 与 `npm run stage:niubash`。
   - **故意不做 `actions/cache` 恢复**：发布二进制在冷目录里由该 tag 的源码构建，不会被上一次运行的缓存顶替。
   - `timeout-minutes: 20`（实测 max 304 s）。
2. **`gate`（`windows-latest`，`contents: read` + `checks: read`）**
   - **Refuse a moved tag**：`git ls-remote origin "refs/tags/$GITHUB_REF_NAME^{}"` 与 `$GITHUB_SHA` 比对，不一致即失败。
   - **Require a green CI required check**：`gh api .../commits/$GITHUB_SHA/check-runs` 要求 `CI required` 为 `success`。
   - tag 与 `package.json` 版本不一致 → 直接失败。
   - 下载四个 artifact 分别放回 `runtime/<target>`，保留各目标 provenance。
   - 宿主 worker 单独 release build（测试用，不替换 staged 发布产物）；取 legacy MSYS fixture 并把 `DSH_OPS_TEST_BASH` / `DSH_OPS_TEST_NIUBASH` 写入环境。
   - **Release gate**：`node scripts/verify-gate.mjs --skip-install` + `node bin/check-release.mjs`。
     - `verify-gate` 就是每个 CI 腿跑的那个门禁：它自己 stage 冻结的 Niubash 归档（所以两条 Niubash 载荷套件**真的会跑**，不是 skip），设 `DSH_OPS_REQUIRE_RUNTIME=1`，拒绝平台允许集之外的 skip，核对套件清单，并校验打包产物。
     - `check-release.mjs` 要求四个声明目标齐全、每个 receipt 哈希与 staged 字节一致、Windows IPC 二进制/源码哈希一致、manifest 与 runtime 白名单一致。
   - 之后 `build-platform-packages.mjs --dist` 打包主包与固定 Windows bash 载荷包，写 `provenance.json` / `SHA256SUMS`；`... check --dist` 只重读已记录摘要。
   - 上传 `release-dist`（`if-no-files-found: error`）。
3. **`publish`（`ubuntu-24.04`，`needs: gate`，仅 tag；唯一 `contents: write`）**
   - 只用 Actions 自带 `github.token`，**不引用任何 secret**。
   - Release 不存在 → `gh release create --verify-tag --generate-notes`；已存在 → 计算缺失资产并只上传缺失项；tarball 为 0 或缺 `SHA256SUMS` 显式失败。
   - 最后把 `SHA256SUMS` 抄进 run summary。

## 发版步骤（维护者）

1. 确认要发布的 commit 在 `main` 上且 `CI required` 绿。
2. `npm version` 更新 `package.json` 版本并合并（走 PR）。
3. Actions → Release → **Run workflow**，ref 选 `main`：dry run，确认四个 `native-*` 工件 + `release-dist` 产出、`publish` skipped、`SHA256SUMS` 与 `dist-release` 一致。
4. `git tag v<package.json 版本>` → `git push origin v<version>`。
5. 发布中断时：重新 dispatch 同一个 tag（同 commit），只补缺失资产；**不要**移动 tag。

## npm 发布：不在本工作流内（要改需 admin）

- GitHub Release 与 npm registry 是两个渠道；`docs/PROVENANCE.md` 记录「GitHub 发布不会自动发布 npm」。
- 这条工作流不引用任何 secret。若将来要让 CI 发布 npm，需要 admin 添加 `NPM_TOKEN`，并新增一个 `needs: gate`、显式读取该 secret 的 job；这一半**没有实现**，属人为占位。

## 规则集与 merge queue（admin 一次性动作）

分支保护不是 workflow 内容，只有 admin 能写。仓库已提供：

```bash
# 只读：打印 desired vs live 指纹
node scripts/apply-ruleset.mjs
# 写入：ruleset + required check + merge queue 同一次提交
GH_ADMIN_TOKEN=… node scripts/apply-ruleset.mjs --apply
```

脚本幂等、可审计，且 token 只从环境读取（不落仓库、不进 Actions secrets）。仓库里
`.github/required-ci-ruleset.json` 是模板，`scripts/check-workflows.mjs` 会在它缺少 merge queue 规则时让 PR 变红。
