# 手动测试快速上手（Windows）

这份 zip 是 **dsh-ops 源码树 + Linux 适配改动**（对应提交 `f33672d` 之上的未提交改动）。
里面**没有** `node_modules`、构建产物和 `.git`，需要按下面的步骤自己构建一次。

配套文档：

- 测试表：[docs/test-table.md](docs/test-table.md) —— 逐项执行并记录
- 验收表：[docs/acceptance-table.md](docs/acceptance-table.md) —— 把结果转成收不收的判定

---

## 一、前置条件

| 需要 | 版本 | 说明 |
|---|---|---|
| Node.js | ^22.19 或 >=24 | 仓库 `engines` 要求 |
| Rust | >=1.88（推荐 1.97.1） | `native/Cargo.toml` 是 edition 2024 |
| MSVC 工具链 | Visual Studio Build Tools（含 C++） | 只有 `npm run build:bash-ipc` 需要；它编译 `native/bash-ipc` 的两个代理 DLL |
| DSH | 0.2.0-rc.2 | 目标宿主 |
| 磁盘 | 约 1GB | `native/target` 和 `vendor/fastctx/target` 是主要占用 |

> 只测"文件工具 + PTC"的话，**不需要** MSVC，也不需要 FastCtx；测"受限模式的 bash"才需要 Bash IPC 代理。

---

## 二、构建（在解压目录里执行）

```powershell
# 1. 依赖（Windows 上 os 声明已包含 win32，不需要 --force）
npm ci --include=dev

# 2. 原生 worker
cargo build --release --locked --manifest-path native/Cargo.toml

# 3. 暂存到包内（生成 runtime/win32-x64/）
node bin/native-runtime.mjs stage --platform win32-x64 --input native/target/release

# 4. 受限模式 bash 需要的 IPC 代理（需要 MSVC）
npm run build:bash-ipc
```

---

## 三、跑门禁

```powershell
npm run validate:manifest   # 期望：all 64 checks passed
npm test                    # 期望：14 个套件通过、2 个跳过（跳过需写原因）
npm run verify:release      # 期望：失败，报"必须带 linux-x64"——这证明发布门禁有效
node bin/check-release.mjs --require win32-x64   # 期望：Release closure OK
```

**注意**：`npm run verify:release` 在只有 Windows worker 的树里**就应该失败**。失败是对的，不是缺陷。

---

## 四、装进 DSH 试用

```powershell
npx --yes dsh-ops@latest install --profile desktop   # 或 web / tui
# 或者用源码树直接装：
npm run provision
```

装好后按 [docs/test-table.md](docs/test-table.md) 逐项测，重点看第 5 节（权限与安全）。

---

## 五、测完请回填两份文档

1. [docs/test-table.md](docs/test-table.md)：每项的"实际结果"与"判定"。
2. [docs/acceptance-table.md](docs/acceptance-table.md)：硬门 G1~G10 与验收项 A1~A12。

**判定原则**：硬门任一项不过就不验收；跳过项必须写明原因；失败必须带报错原文与退出码。
