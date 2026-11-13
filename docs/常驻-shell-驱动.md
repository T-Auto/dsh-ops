# 常驻 shell 驱动基础层

[English](resident-shell-driver.md)

#872 的 C2 切片在 C1 进程基础层上增加单个 Windows 持久 shell 驱动。它可通过 `native/examples/shell_driver.rs` 独立运行；本切片不发布工具、不调度 session 队列、不改变默认 shell、不替换固定 Niubash runtime，也不代表 POSIX 所有权问题已经解决。

宿主提供公开 sandbox 返回的完整 argv、工作目录及完整环境。固定 `residentShellBootstrap()` 模板只接收内核创建的管道名；命令随后通过有界私有双向通道传入。验证后的前缀选择实际命令读取端；Niubash 的空 metadata 打开不代表读取端已就绪，也不代表输出 EOF。

每个通道的四个管道实例都必须先启动 `ConnectNamedPipe`，构造函数才返回名称。否则快速 metadata 打开和关闭可能先于连接登记，引发 `ERROR_NO_DATA`。确定性测试把读取线程阻塞在登记之前，断言构造函数不能提前发布端点；在仓库外源码副本中仅移除就绪等待，该测试就失败。此修复遵循 [Microsoft 的 ConnectNamedPipe 文档](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-connectnamedpipe)，不接纳未经验证的字节，也不虚构 EOF。

启动前按大小写不敏感规则拒绝非空 `NIU_ENV`、`BASH_ENV` 和 `ENV`，诊断只显示变量名。启动脚本不能把 daemon 无声纳入启动基线。命令通道与启动通道均确认后，驱动保存当时所有实际所属启动进程的句柄。启动根进程和已验证的 shell PID 必须存在且存活；后续检查要求相同的存活进程身份和完整 Job 成员集合，而不是固定进程数量。Windows console 自身可能贡献一个所属启动进程。后来的子进程不会加入基线。

每条命令有独立 stdout、stderr 和完成管道。驱动在计数前移除可信前缀，为每个流保留有界前缀，并继续排空超出保留上限的字节。成功完成必须同时满足：私有终态收据、无运行或停止的 shell job、三个实际写入端全部达到物理 EOF，以及保存的进程基线恢复。若收据后仍有保留描述符或存活子进程，只等待有界收尾时间，随后重置该 shell 范围；不会无限等待或把普通后台命令隐式升级为持久 job。

固定模板在顶层直接执行命令，不放入条件判断，因此 `set -e` 保持原有语义。cwd、export、函数和 shell 选项跨调用保留。每条命令默认 stdin 都是 EOF；显式输入重定向仅作用于该调用。显式命令 cwd 会保留到后续调用。用户 `set -x` 的跟踪进入该请求 stderr；可信包装自身的跟踪进入默认空流。任意描述符表持久化不属于契约。`exit`、替换进程的 `exec`、关闭控制描述符或保留其副本，在无法证明完成协议时均返回真实的重置结果。

`Driver::check_live()` 在复用前检查私有控制状态和保存的基线。空闲 shell 丢失必须先报告，不能无声替换。启动或命令失败后，调用者必须停止并确认所属范围为空，再 join 全部请求捕获线程后返回。输出观察失败保持显式；缺少验证的 EOF 不能改写成完整输出。

## 复现纵向验证

构建示例与 TypeScript 模板：

```powershell
cargo build --locked --manifest-path native/Cargo.toml --example shell_driver
npm run build
node bench/probes/probe-872-shell-driver-direct.mjs <example.exe> <reviewed-candidate-niu.exe> <stock-support-niu.exe>
```

探针通过固定版本的公开 subprocess provider 启动示例，对 read-only 和 workspace-write 使用公开 confinement 返回的完整 argv，并验证不受限模式。候选可执行文件与已验证的原版支持目录分离；不修改已发布 payload、manifest 或 pin。管道 ACL 测试需要正常宿主上下文，外层工具 sandbox 可能拒绝创建 owner/logon-SID ACL。

本地评审中的 Niubash 回移植候选 SHA-256 为 `7c4332044ac5fd1b789f30b29c155a62f12f07f8dd3495244bda3ce4e0e84664`，通过 18 项直接驱动检查：启动环境拒绝、三种模式的状态与 cwd 保留、xtrace/nounset、stdin 重置、普通输出伪造收据、等待完成的外部后台输出、两个各 1 MiB 且仅保留 1024 字节的流、exit/exec/控制通道丢失、真实 errexit、四种异步命令形式，以及超时只影响单个 shell 的验证。最终应急清理前，已观察进程均已退出。进程 crate 的 22 项单元测试通过，另有两个由测试显式调用的子进程 fixture；它们不是跳过的验收检查。

CI 使用相同探针运行 `<stock-niu.exe> <stock-niu.exe> --stock-contract`。该显式模式通过 19 项能力边界检查，其中明确断言原版异步输出缺陷会触发已观察诊断错误并重置所属 shell。它不会无声忽略该用例，也不代表完整功能已支持。

原版 Niubash 1.5 仍有已独立复现的后台 stdout/stderr 路由缺陷。候选完整验证不意味着原版 runtime 或标准 CI 已支持该行为。依赖溯源、发布打包、session 队列集成、公开工具发布、显式持久 job 和跨平台所有权仍是独立工作。
