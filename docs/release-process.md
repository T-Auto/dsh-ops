# 发布流程与如何启用

> 0.4.0 仍是[未发布候选](0.4.0发布候选.md)，验收采用已批准的 OPS 0.3.x BM-01 基线与文件/发现 BM-03 预算，最终结果须单独核验。下面的仓库工作流状态是历史记录，实际发布前须重新检查；本次更新不启用发布、不打 tag、不发布包。
> The [0.4.0 candidate](release-0.4.0.md) uses the approved OPS 0.3.x BM-01 comparator and file/discovery BM-03 budget; verify final results separately. Workflow state below is historical and must be checked before any release; this update does not enable publishing, tag or publish packages.
> 指纹口径：外部产物的字节以 `SHA256SUMS` 为准；Release 正文（notes）不是摘要的权威，本工作流发布时抄进 run summary 的只是它的副本。由维护者本机发布的旧版本没有 run summary，也不一定带 `SHA256SUMS` 资产；它们的指纹以包内 `runtime/<target>/provenance.json` 为准（历史正文里的数值，见 `docs/PROVENANCE.md` 的更正记录）。任何公布的指纹都必须写明对象（哪一个文件的指纹），不得只手抄数值。
> Checksum scope: the bytes of every external artifact are authoritative in `SHA256SUMS`; the Release body (notes) never defines a checksum, and the run summary is only a copy of that manifest. Releases published from a maintainer machine have no run summary and did not always carry a `SHA256SUMS` asset; for those, the in-package `runtime/<target>/provenance.json` is the record (see the correction in `docs/PROVENANCE.md`). Every published checksum must name its object, never a bare number.

对象是 `.github/workflows/release.yml`（workflow 名 `Release`）。发布目标只有一个：**GitHub Release**（tag + 自动 notes + 一个可安装主包 tarball + `SHA256SUMS`）。npm publish 不在这条流水线里，理由见下。

## 历史状态记录：`disabled_manually`

```
$ gh api repos/T-Auto/dsh-ops/actions/workflows --jq '.workflows[]|"\(.name) | \(.state)"'
Cross-platform validation | active
Release | disabled_manually
Sync master with main | active
```

`disabled_manually` 是仓库级设置：**即使推 `v*` tag 也不会触发它**。历史上 0.2.x／0.3.1 的发布都是维护者本机执行的（见 [release-0.2.1.md](release-0.2.1.md)、[release-0.3.1.md](release-0.3.1.md)），`.github/workflows/` 当时只作为"预期的门禁与流水线"保留。所以：

- 读到本文件不代表打 tag 就会出 Release；
- 反过来，这条工作流在真正启用前不会消耗 Actions 额度，也不会在 tag 上失败刷红。

## 触发条件（仅两条，保持保守）

| 触发 | 行为 |
| --- | --- |
| `push` tag `v*` | 完整跑：四个目标构建 → 门禁 → 打包 → 创建/更新 GitHub Release |
| `workflow_dispatch`（在 `main` 等分支上） | 干跑：构建 → 门禁 → 打包 → 上传 artifact，**不发布**（`publish` job 被 `github.ref_type == 'tag'` 挡掉，运行期也不授予写权限） |
| `workflow_dispatch`（tag 选为 ref） | 完成一次中断的发布：每个发布步骤幂等，重跑不会重复上传或重造内容 |

没有新增任何隐式触发：普通 push、PR 都不会走到这里。

## 流水线三段与失败语义

1. **`native`（矩阵：`windows-latest`/`win32-x64`、`ubuntu-24.04`/`linux-x64`、`macos-latest`/`darwin-arm64`、`macos-15-intel`/`darwin-x64`）**
   - 只构建 [lib/ptc/runtime.js](../lib/ptc/runtime.js) 里声明的那四个目标；Windows ARM64 与 Linux ARM64 不在矩阵内。
   - 固定 Rust 1.97.1 与已锁定的 `Cargo.lock`；npm 平台名和 Rust triple 分列（例如 `win32-x64` 对应 `x86_64-pc-windows-msvc`），`cargo build --release --locked --target <triple>` 失败即整次发布失败。
   - `bin/native-runtime.mjs stage` 为目标写入 `runtime/<target>/provenance.json`（version／target／executable／sha256）——这就是本仓库的 provenance 约定；缺二进制或不是常规文件都会报错。
   - Windows 目标额外跑 `npm run build:bash-ipc`，其 receipt 由门禁按仓库内的 `native/bash-ipc/*` 源码哈希复核。
   - 产物以 `native-<target>` 上传，路径就是 CI 使用的 `runtime/<target>/`，`if-no-files-found: error`。
   - 这里**故意不做 `actions/cache` 恢复**：发布二进制在冷目录里由该 tag 的源码构建，不会被上一次运行的缓存顶替。
2. **`gate`（`windows-latest`，只读权限）**
   - tag 与 `package.json` 版本不一致 → 直接失败（不进入打包）。
   - 下载四个 artifact 分别放回 `runtime/win32-x64`、`runtime/linux-x64`、`runtime/darwin-arm64`、`runtime/darwin-x64`，不把各目标的 `provenance.json` 展平覆盖。
   - 单独编译 gate 宿主 worker 到 `native/target/release` 供固定路径的真实套件使用；这份测试 build 不替换来自冷构建矩阵的 staged 发布产物。
   - **`npm run verify:release`**（`validate-manifest` + 全部仓库测试 + `bin/check-release.mjs`）是硬门禁：四目标缺一、receipt 与字节哈希不符、Windows IPC 二进制/源码哈希不符、`dsh-plugin.json` 与 runtime 白名单不一致，任一都失败。
   - 之后才 `build-platform-packages.mjs --dist`（组装主包与固定的 Windows bash 载荷包并打 tarball，写 `provenance.json` 与 `SHA256SUMS`），再 `... check --dist`（只重读已记录的摘要，不下载不构建）。
   - dist 目录以 `release-dist` 上传，`if-no-files-found: error`。
   - 同号载荷包的权威字节在 npm registry：Release 里附带的 `dsh-ops-bash-win32-x64-<pin>.tgz` 是本次构建记录（`provenance.json` 带 `builtAt`/`builtFromCommit`），与 registry 上同版本 tarball 不会字节相同；离线校验以 registry 的 `integrity` 为准。
   - 组装当前仍在 Windows gate 执行；`build-platform-packages.mjs` 产出主包与固定的 Windows bash 载荷包（PowerShell 不在其中）。Windows 构建和测试必须使用 `npm ci` 安装的 bash 载荷；缺失即失败（只有显式设置 `DSH_OPS_TEST_BASH` 的离线场景允许替代），并在 CI 中有独立断言。
3. **`publish`（`ubuntu-24.04`，`needs: gate`，仅 tag）**
   - 唯一持有 `contents: write` 的 job；不用任何 secret，只用 Actions 自带 `github.token`。
   - `gh release create ... --verify-tag` 创建，已存在则 `gh release upload --clobber` 覆盖资产；tarball 数量为 0 或缺 `SHA256SUMS` 时显式报错退出，不会发出空 Release。
   - 最后把 `SHA256SUMS` 写进本次 run 的 summary，便于核对。

## npm 发布：不在本工作流内（要改需 admin）

- 本仓库的 GitHub Release 与 npm registry 是两个渠道；[PROVENANCE.md](PROVENANCE.md) 明确记录"GitHub 发布不会自动发布 npm"，而 `npm publish` 需要 `NPM_TOKEN`。
- 这条工作流**不引用任何 secret**：写一个引用未知 secret 的步骤，结果只会是启用后第一次运行才发现它不存在。当前流程仍是维护者本机 `npm publish`（当前只发布主包；旧版平台包流程见 [release-0.2.1.md](release-0.2.1.md)，不再适用于此版本）。
- 若将来要让 CI 发布 npm，需要 admin 做的事：在仓库 secrets 里添加 `NPM_TOKEN`（带 2FA bypass 的 granular token），并新增一个 `needs: gate`、`permissions: contents: read` 的 job 显式读取 `secrets.NPM_TOKEN`——**这一半没有实现，属人为占位**。

## 如何启用（需要 admin）

```
# 需要仓库 admin（或对 Actions 有写权限的凭据）：
gh workflow enable Release --repo T-Auto/dsh-ops
gh api -X PUT repos/T-Auto/dsh-ops/actions/workflows/release.yml/enable

# 验证
gh api repos/T-Auto/dsh-ops/actions/workflows --jq '.workflows[]|select(.name=="Release")|.state'
# 期望：active
```

非 admin 的凭据调用上面两条会拿到 403／404；`gh api repos/T-Auto/dsh-ops/branches/main/protection` 同样如此（分支保护本身仍未开启，见 issue #162）。

## 启用后：先手动干跑一次，再打 tag

1. Actions → Release → **Run workflow**，分支选 `main`，不选 tag。预期：`native` 矩阵四个分支全绿、`gate` 绿、`publish` **skipped**，并产出 `native-win32-x64`／`native-linux-x64`／`native-darwin-arm64`／`native-darwin-x64`／`release-dist` 五个 artifact。
2. 检查 `release-dist` 里有一个主包 tarball、`SHA256SUMS`、`provenance.json`；把 `SHA256SUMS` 与 run summary 里的摘要对上。
3. 干跑全绿之前**不要**打 tag：`push` tag 会立即发布，而 Release 一旦创建就对外可见（可以改 notes、可以替换资产，但"没发布过"这件事收不回来）。
4. 需要真正发布时：`git tag v<package.json 版本>` → push tag（或按上面第 1 步改用 tag 作为 ref 手动 dispatch）。tag 与 `package.json` 版本必须一致，否则 `gate` 会拒绝。
5. 万一中断：重新 dispatch 同一个 tag 即可，`gh release upload --clobber` 会替换资产而不是叠一份。
