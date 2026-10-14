# dsh-ops 测试表（Windows 手动实测）

> 用途：在一台真实 Windows 机器上，按本表逐项执行，记录"实际结果"与证据。
> 每一行都必须填"通过 / 失败 / 跳过"，跳过要写原因。**不要只填通过**——失败和跳过同样有价值。
> 测试对象：本 zip 解压出的源码树（含 Linux 适配改动，未提交版本）。
> 测试人：＿＿＿＿　测试日期：＿＿＿＿　机器：＿＿＿＿

---

## 0. 环境记录（先填，后面所有结论都依赖它）

| 项 | 命令 | 填写 |
|---|---|---|
| Windows 版本 | `winver` 或 `[System.Environment]::OSVersion.VersionString` | |
| 架构 | `$env:PROCESSOR_ARCHITECTURE` | |
| Node 版本 | `node -v`（要求 ^22.19 或 >=24） | |
| npm 版本 | `npm -v` | |
| Rust 版本 | `rustc --version` + `cargo --version`（要求 >=1.88，推荐 1.97.1） | |
| MSVC 工具链 | `cl.exe` 是否可用（bash-ipc 代理需要） | |
| DSH 版本 | `dsh --version`（目标 0.2.0-rc.2） | |
| 解压路径 | 例：`D:\ops-test\dsh-ops` | |
| 是否有管理员权限 | 是 / 否 | |

---

## 1. 构建与门禁（必须先全过，否则后面的测试没有意义）

| 编号 | 步骤 | 命令 | 期望 | 实际 | 判定 |
|---|---|---|---|---|---|
| B-01 | 安装依赖 | `npm ci --include=dev` | 退出码 0；`node_modules/@deepseek-ai` 下有包 | | |
| B-02 | 构建 Rust worker | `cargo build --release --locked --manifest-path native/Cargo.toml` | 退出码 0；**无 warning**；产出 `native/target/release/dsh-ops-worker.exe` | | |
| B-03 | 暂存 Windows worker | `node bin/native-runtime.mjs stage --platform win32-x64 --input native/target/release` | 退出码 0；`runtime/win32-x64/dsh-ops-worker.exe` + `provenance.json` 出现 | | |
| B-04 | 构建 Bash IPC 代理 | `npm run build:bash-ipc` | 退出码 0；`runtime/win32-x64/bash-ipc/` 下有 `opsipc.dll`、`opsnt.dll`、`provenance.json` | | |
| B-05 | 清单校验 | `npm run validate:manifest` | `all 64 checks passed` | | |
| B-06 | 全量测试 | `npm test` | 退出码 0；14 个套件通过、2 个跳过（跳过需写明原因） | | |
| B-07 | 发布闭环（双平台） | `npm run verify:release` | **预期失败**：报"必须带 linux-x64"（本 zip 只有 Windows worker）。这证明门禁有效 | | |
| B-08 | 发布闭环（单平台） | `node bin/check-release.mjs --require win32-x64` | 退出码 0，报 `Release closure OK` | | |

---

## 2. Shell 组件（bash / PowerShell 7）

| 编号 | 步骤 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| S-01 | 启用 shell 组件后，让模型执行 `printf 'SHELL_OK'` | 输出 `SHELL_OK`，退出码 0 | | |
| S-02 | 受限模式（工作区写）执行写工作区的命令 | 成功，且返回里带 `sandbox.enforcement`（full 或 partial） | | |
| S-03 | 受限模式执行写 `C:\Windows` 的命令 | 失败；返回里带 `permission.code = POLICY_DENIED`；文件未生成 | | |
| S-04 | 只读模式执行任何写命令 | 失败 + `POLICY_DENIED`，且无文件落盘 | | |
| S-05 | 长脚本（>1KB 或含引号/中文）走 `script_path` | 正常执行；内容不出现在 argv 里 | | |
| S-06 | 命令超时（`timeoutMs: 2000` + `sleep 30` 等价命令） | 约 2 秒返回，`timedOut: true`，`signal` 有值 | | |
| S-07 | 管道（`echo a | findstr a`） | 正常，退出码 0 | | |
| S-08 | 退出码传递（`cmd /c exit 7`） | 返回 `exitCode: 7` | | |
| S-09 | **Linux 专属**：工作目录不存在时执行命令 | 报错**点名工作目录**（原文形如 workdir is not a directory: <路径>）。Windows 未做此改动，保持原有行为 | | |
| S-10 | **回归**：受限模式下 bash 报权限错误 | 返回 `permission.code = POLICY_DENIED`（不是普通失败） | | |
| S-11 | 大输出（生成 >64KB） | `truncated: true`，并给出 spill 文件路径 | | |
| S-12 | 关闭 shell 组件 | `ops_bash` 不再出现；提示词里的 bash 路由消失 | | |

---

## 3. 文件组件（原生 Rust worker）

| 编号 | 步骤 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| F-01 | `ops_glob` 找 `**/*.js` | 返回真实路径；不遍历符号链接/junction、隐藏文件、`.git` | | |
| F-02 | `ops_grep` 搜索（content / count / summary 三种模式） | 结果正确；`complete: true` | | |
| F-03 | `ops_inspect_local_file` 读文本（分页） | 行号与内容正确 | | |
| F-04 | `ops_replace` `dryRun: true` | `changed: 0`；**文件哈希不变** | | |
| F-05 | `ops_replace` 实际执行 | `changed` 正确；文件内容确实改了 | | |
| F-06 | **回归**：对**含二进制文件**（如 `icon.png`）的目录执行 replace | 调用**成功**；二进制被跳过，`skipped > 0` 且 `skippedPaths` 点名；文本文件照常被改 | | |
| F-07 | replace 的并发冲突（先改文件再执行） | 返回 `REVISION_CONFLICT`，不静默覆盖 | | |
| F-08 | 对 symlink / junction 路径操作 | 拒绝（`POLICY_DENIED`），不跟随 | | |
| F-09 | 相对路径与绝对路径 | 都按"相对 session cwd"解析；越界绝对路径按权限模式判定 | | |
| F-10 | 大文件（>32MB）读取 | 明确报 `OUTPUT_LIMIT`，不崩 | | |

---

## 4. PTC 组件（`ops_batch` / `ops_result`，需显式启用）

| 编号 | 步骤 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| P-01 | `ops_batch` `action=plan` 生成计划 | 返回计划与 id；**业务文件未被改动**。允许在 root 下创建 `.dsh-ops/` 审计目录（设计行为：读类工具不建审计，改类工具建） | | |
| P-02 | `action=run` 执行 copy/move/remove | 全部成功；`status: completed` | | |
| P-03 | `action=resume` 恢复已完成的作业 | 已完成的条目不重复执行 | | |
| P-04 | 保护目录（`protect`）内删除 | `POLICY_DENIED` | | |
| P-05 | 作业审计记录 | `.dsh-ops/` 下有记录；**回归**：写操作不再报 `Bad file descriptor`（os error 9） | | |
| P-06 | `ops_result` `put` + `page`（大行集分页） | 分页正确、字节上限生效、`complete` 正确 | | |
| P-07 | 跨会话访问他人结果引用 | `POLICY_DENIED` | | |
| P-08 | 只读模式下 `ops_result page` | 允许（只读已有引用）；其他写操作拒绝 | | |
| P-09 | PTC 组件关闭时 | `ops_batch` / `ops_result` 不出现 | | |

---

## 5. 权限与安全（重点，逐项必须填）

| 编号 | 步骤 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| X-01 | 三档权限（只读 / 工作区写 / 完全权限）下分别读写工作区内文件 | 只读拒写、工作区写允许、完全权限允许 | | |
| X-02 | 工作区写档位下写工作区外路径 | 拒绝 + `POLICY_DENIED` | | |
| X-03 | 读工作区外但 OS 可读的文件 | **允许**（这是设计意图，见 README） | | |
| X-04 | **凭据围栏**：让文件工具读 `%USERPROFILE%\.dsh\.credentials.yaml` | `POLICY_DENIED`，**且返回里没有任何文件内容**（只记录错误码，不要打印文件内容） | | |
| X-05 | 凭据围栏在**完全权限**档位下 | 仍然拒绝 | | |
| X-06 | 凭据目录遍历（glob/grep `%USERPROFILE%`） | 结果里**不出现** `.ssh` 等凭据目录下的路径 | | |
| X-07 | `%TEMP%` 下**别的会话**的临时目录 | 文件工具的 replace 拒绝（`POLICY_DENIED`） | | |
| X-08 | 关闭围栏：配置 `denyCredentialReads: false` | 该行允许读取（用于确认开关有效） | | |
| X-09 | 受限模式下 bash 写 `%TEMP%` | **记录实际结果即可**。已知：`%TEMP%` 的强制完整性标签（通常 Medium）与工作区（可能被标 Low）不一致时，受限写入可能被拒（ACCESS_DENIED）。这属于宿主 ACL 运行器与完整性标签的交互，不是插件围栏 | | |

---

## 6. 发布包内容核对

| 编号 | 步骤 | 期望 | 实际 | 判定 |
|---|---|---|---|---|
| R-01 | `npm pack --dry-run --json` | 文件清单里含 `runtime/win32-x64/dsh-ops-worker.exe`、`runtime/win32-x64/provenance.json`、`runtime/win32-x64/bash-ipc/*` | | |
| R-02 | 同上 | 含 `lib/components/linux/*`（5 个文件）、`lib/credential-policy.js`、`lib/session-temp.js` | | |
| R-03 | 清单里的组件数 | `cordis.patch.yml` 有 **5** 行（shell/file/background/ptc/linux） | | |
| R-04 | `dsh-plugin.json` 平台声明 | 主包 `os: ["win32","linux"]`；PTC 仍 `["win32"]`；linux 组件 `["linux"]` | | |

---

## 7. 已知行为（不是缺陷，记录即可）

| 编号 | 现象 | 说明 |
|---|---|---|
| K-01 | 只读会话下 bash 仍能读凭据文件 | 命令执行器是通用 shell，用户显式授权；文件工具才拦凭据 |
| K-02 | 受限模式下 bash 能写临时目录 | Linux 上是宿主 Landlock 授权整个 `/tmp`；Windows 上由 ACL 运行器决定，且受**强制完整性标签**影响（工作区 Low + `%TEMP%` Medium 时可能拒绝）。插件自己的文件工具更严 |
| K-03 | 受保护的 Windows 目录（如 `C:\Windows`）需要管理员权限 | 与环境有关，记录即可 |
| K-05 | 工作区带 **Low 完整性标签**时，PowerShell 拒绝从工作区内**加载脚本文件**（报 AuthorizationManager check failed） | **本版未修改**：ACL 前置仍用 -File 方式（属 Windows 侧，不在本次 Linux 适配范围）。遇到该报错请记录，不要当成 Linux 适配的回归 |
| K-04 | `npm ci` 在 Windows 上无需 `--force` | `os` 已声明 win32 + linux |

---

## 8. 失败记录（任何一项失败都写这里）

| 编号 | 现象（原样贴报错） | 复现步骤 | 退出码 | 备注 |
|---|---|---|---|---|
| | | | | |

**汇总**：通过 ＿＿ 项 / 失败 ＿＿ 项 / 跳过 ＿＿ 项
