# dsh-ops 0.3.0 — Windows x64

## 发布范围

- 本次正式版仅支持 **Windows x64**，目标宿主 DSH `0.2.0-rc.2`。
- Linux、macOS、ARM64 不在本版支持范围；不能将历史编译检查当作实机支持。
- `dsh-ops` 主包更新为 `0.3.0`；三个 Windows 可选载荷依赖仍固定 `0.2.1`，无需重复发布。

## 主要变化

- 文件工具迁移至独立 Rust worker：有界文本/hex 读取、glob、Rust 正则搜索、dry-run 与原子替换；统一 session cwd 路径语义。
- 纯 PTC 可选组件提供 `ops_batch`（计划、copy/move/remove、保护、恢复与审计）及 `ops_result`（有界引用、分页、过滤、投影、释放）。默认不启用，不在普通/hybrid 模式发布 PTC 专用工具。
- 按会话最新 DSH 权限执行：只读拒绝修改；工作区内修改限制写入；完全权限不附加写入范围。固定可信文件操作采用 DSH fs-sandbox 同类权限检查；任意 Bash/PTC 代码继续通过 OS 沙箱。
- 修复 Windows 受限 Bash 的 IPC 初始化：对精确匹配的 MSYS DLL 构造可校验私有兼容副本，不改原包、全局 Git、令牌身份或磁盘 API，不裸执行回退。
- Windows 工作区启动前，仅为当前用户拥有的目录根补齐 `WRITE_OWNER` 前提；备份原 DACL，不递归、不改 owner 或显式 deny。
- 用户授权拒绝与执行器故障分开报告，明确当前/所需权限及用户操作指引。
- 缺 Bash 载荷诊断区分 registry 未收录、缺失、残缺树与显式路径；后台工具拒绝未知参数。

## 安装与注意

从官方 npm registry 或 DSH 插件市场安装 `dsh-ops@0.3.0`；替换旧版后正常退出并重启 Desktop。
无需 Rust/MSVC：发布包携带 Windows x64 worker、IPC 代理、receipt 和匹配源码。
PTC 组件需显式启用，使用纯 PTC-only 呈现；后台组件仍默认关闭、仅限完全权限。
首次受限 Bash 调用会在 DSH_HOME 内建立私有载荷副本，有一次磁盘复制成本；之后复用同一校验身份。
Windows 宿主仍报告 `partial` enforcement，本插件不将其冒充完整内核隔离。
不匹配的自定义/升级 MSYS DLL 会拒绝兼容执行，不绕过沙箱。

## 发布验证

- Manifest、源码测试、真实 Windows DSH provider、真实 Node PTC SDK command/script/pipeline 和权限切换测试。
- `npm run verify:release` 核验单平台声明、worker PE/hash、IPC 二进制与源码 hash 闭包。
- GitHub Release 为源码/tag/说明；随后生成 npm tarball，核验包内容、凭据排除、哈希与独立安装。
- npm 发布由维护者使用本机 `dist/publish.bat` 执行，不由 Actions 自动发布。GitHub Actions 保持既有关闭状态。

未宣称 Linux/macOS/ARM64 验收，也不把用户特定任务的 token 统计当作通用性能保证。
历史 PortableGit 载荷的完整 source-delivery 闭包限制见 [PROVENANCE](../PROVENANCE.md)；0.3.0 不分发修改后的 MSYS DLL，私有修改仅在用户本机生成。
