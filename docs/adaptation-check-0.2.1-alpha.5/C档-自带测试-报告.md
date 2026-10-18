# C 档报告：dsh-ops 自带测试套件（repo\npm test）

**日期**：2026-10-17
**对象**：`repo\`（dsh-ops@0.3.1，HEAD e6f2deb）自带测试，Node v24.19.0，Windows x64

## 最终结果：0 失败 / 34 套件全部过或环境性跳过

| 状态 | 数量 | 明细 |
|---|---|---|
| ✅ 通过 | 16 套件 | bash-ipc(5)、bin(19)、config-updates(20)、config(6)、file-args(8)、file-contract(3)、hardening(3)、manifest(13)、policy(10)、release-scope(7)、shells(55)、tui-activity(12)、tui-attention(4)、tui-navigation(5)、tui-panel(6)、tui-result(7) 等，共 244+ 项断言 |
| ⏭️ 环境性跳过 | 18 套件 | ① native worker 相关 13 个（`native\target\release\dsh-ops-worker.exe` 未构建，需 `npm run build:ptc` 的 Rust 构建）：credential-fence、file-metadata、grep-multiline、inspect-hex、linux-args/attributes/paths/protocol/sandbox/scope、mount、output-budget、permissions、ptc、replace-concurrency；② linux-shell：POSIX 专用套件（Windows 上正当跳过）；③ tui-host/tui-native：需外部 `DSH_OPS_TUI_ROOT` 源码 |
| ❌ 失败 | 0 | — |

## 修复过程（踩坑记录，写回 踩坑记录.md）

**故障**：`npm test` 在 bash-ipc 套件失败：断言 `/is not the pinned build/` 不匹配，实际报 `carries no Bash IPC compatibility receipt (runtime/win32-x64/bash-ipc/provenance.json)`。
**原因（两层）**：
1. 直接跑 `npm test` 缺 CI 前置：本仓库 CI（.github/workflows/ci.yml）先 `npm run build:bash-ipc` + `npm run check:ptc-runtime` 再跑测试——本地没 stage Bash IPC 代理 receipt。
2. `npm run build:bash-ipc` 在本机失败 `C1083: 无法打开源文件 D:\DSH-Files-v2\03-应用项目\dsh-ops\repo\native\bash-ipc\opsipc.cpp`：构建脚本把含中文的工作区路径写进 UTF-8 build.cmd，cmd.exe 按 GBK(CP936) 解读 → cl.exe 收到的路径字节错误 → 打不开。CI 跑在英文路径故无此问题。junction 方案无效（Node ESM 加载器对 junction 做 realpath，`import.meta.url` 仍解析回中文真实路径）。
**解决**：把最小构建树（package.json、bin/、lib/、native/bash-ipc/、node_modules/@dsh-ops/bash-win32-x64/usr/bin/msys-2.0.dll）拷贝到 `C:\dsh-ops-ipc-build`（无中文路径），`DSH_OPS_VCVARS64="D:/VS2022BT/VC/Auxiliary/Build/vcvars64.bat" npm run build:bash-ipc`（MSVC 来自 VS2022 自定义安装 D:\VS2022BT）构建成功，receipt（provenance.json + opsipc.dll + opsnt.dll）回拷到 `repo\runtime\win32-x64\bash-ipc\`，bash-ipc 套件 5/5 通过。

## C 档结论

- **dsh-ops 自带测试在 Windows x64 本机：全绿（0 失败）**，剩余 skip 均为可归因的环境性跳过（Rust native worker 未构建 / POSIX 套件 / 外部 TUI 源）。
- 该档测的是 dsh-ops **自身**（跑在 dsh-ops 自己的依赖上），**不直接测与 dsh 0.2.1-alpha.5 的适配**——与 0.2.1 的兼容性由 B 档（iso 动态实测）闭环。
