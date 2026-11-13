# 常驻 shell 队列协议

English: [Resident shell queue protocol](resident-shell-queues.md).

本文记录 [#872](https://github.com/T-Auto/dsh-ops/issues/872) 的 Windows 内部队列实现，
不代表模型可见接口或完整功能验收。现有 fresh-shell 工具保持已发布行为；后台任务、公开投影、
输出 spill 集成以及完整应用与性能验收仍是必须完成的后续工作。

## 所有权与准入

激活作用域拥有的内核在 Windows 上声明 `shell-v1`。原有私有连接接受 `shell.execute`，
按 `sessionKey` 将请求排入 FIFO。每个会话工作线程拥有一个 shell 范围，不同会话独立运行；
队列与 shell 均不引入第二个监督进程。文件请求继续使用可独立终止的执行子进程。

仅队首请求收到 `shell.admit`；宿主此时提供当前可信权限、审批与 confinement 结果。
已有 shell 可以 `reuse` 或 `retire`，新的 bootstrap 可以 `launch`。拒绝的队首不会执行命令。
原生层校验 IPC 形状、大小和操作系统结果，不从命令文本推导权限。

两种 retire 操作不能混淆：

| 操作 | 当前队首 | 剩余队列 |
| --- | --- | --- |
| 准入回复 `decision: retire` | 保留同一个尚未开始的请求，回收后重新发送新的 bootstrap 端点 | 保留 |
| 所有者控制 `shell.retire` | 取消，回收完成后才报告终态 | 保留，并按宿主当前权限重新准入 |
| 所有者控制 `shell.close` | 取消并等待回收 | 不执行，直接取消 |

每个控制操作使用独立 requestId 和 `shell.closed` 回执。临时扩大权限的单次批准使用
`closeAfter`，必须在报告命令结果前关闭其范围；宿主不能把该批准用于后续排队请求。
启动环境脚本不属于此 bootstrap 协议；宿主准入层必须明确拒绝已配置的启动脚本变量，
不能把脚本启动的后代纳入 bootstrap 基线。

## 请求生命周期

原生超时涵盖排队、准入、启动和执行，每个请求独立计时。排队请求被取消或过期时立即报告终态，
不等待活动命令或审批回调。活动请求取消会唤醒准入等待或中断所属 shell；协作中断无法收敛时，
结束该范围。其他会话和文件操作保持各自生命周期。

命令字节进入 shell 前，必须已将 `shell.started` 写入实际控制连接；等待此写入时仍响应截止与取消。
开始通知排队或写入后，命令字节发送前仍可能被取消，此时终态正确报告 `effectState: none`，
不能撤回已在执行的管道写入。成功完成要求驱动的私有回执、
两个输出流和回执 writer 的真实 EOF、reader join，以及被保留句柄证明的完整 bootstrap 进程身份。
shell 退出、输出静默、普通 echo 标记或进程数量相同，均不能单独证明完成。

开始后的失败报告 `effectState: unknown`，开始前的失败报告 `effectState: none`。
`shellState: reset` 表示已无可复用 shell，包括取消导致的状态丢失；不表示本次请求曾新建 shell。
空闲 shell 的身份或协议丢失时，下一个尚未开始的请求明确失败，不静默重建状态，不重放，
也不自动重启内核。

所有失败路径都先终止所属范围并 join 本请求全部 reader，再报告终态。无法确认回收时，
该所有者身份被封闭，排队请求不能在其名下启动另一范围；后续 `shell.close` 仍返回已知回收结果。
已完成记录保留到输出收集完毕并显式 `shell.release`。

## 有界连接与输出

原生与宿主边界最多接收 32 条保留的执行记录、32 个会话所有者及 64 条未完成所有者控制。
命令不超过 1 MiB。每个输出流最多保留 128 KiB 前缀，仍继续排空并统计被丢弃的字节。
此内部协议尚不替代已发布 shell 的 spill 与分页契约。

`shell.read` 返回最多 65,536 个解码字节的即时快照，包含原 offset、nextOffset、规范 base64、
lossy 和 EOF 信息。仅 `lossy: true` 时允许跳过丢弃字节。活动空流立即返回 `eof: false`；
终态读取必须前进、确认 EOF 或明确报告输出错误。私有帧前缀不占用户输出预算。

一个最多 256 帧的回复队列和一个 writer 将实际输出背压与控制 reader 分离。
会话线程等待 `started` 的实际写入；输出阻塞时，控制 reader 仍能处理 shutdown 或断连。
超出协议窗口会立即关闭连接，包括最后一帧输入之后异步完成的请求，不无限分配线程或回复。
关闭时先取消控制 I/O，再 join 输出、
请求和会话线程。

Windows 命名管道在保留 peer 时，仅调用 Node `stream.end()` 不会产生独立写半边 EOF。
因此慢消费者回归在暂停读取时发送受支持的 `shutdown` 控制消息；实际销毁连接另行验证。
POSIX 不声明 `shell-v1`，公开宿主接口能够维持所需所有权保证前，持久范围明确不受支持。

## 复现与限制

不需要 shell 可执行文件即可运行队列生命周期断言：

```console
cargo test --locked --manifest-path native/Cargo.toml --bin dsh-ops-worker shell::
```

驱动和输出背压探针使用普通 Windows 宿主、公开 subprocess 服务、显式指定的 shell 和已验证的
支持载荷。探针要求的嵌套宿主沙箱仍然有效。无法创建所需管道 ACL 的工具沙箱属于不同启动环境，
其失败必须保留在证据中。

```console
node bench/probes/probe-872-shell-driver.mjs <worker.exe> <niu.exe> <bootstrap.js> <stock-support-niu.exe>
node bench/probes/probe-872-shell-backpressure.mjs <worker.exe> <niu.exe> <bootstrap.js> <stock-support-niu.exe>
node bench/probes/probe-872-shell-started.mjs <shell_started_blocked.exe> <niu.exe> <stock-support-niu.exe>
```

异步描述符断言目前使用明确记录哈希的本地 Niubash IO backport 候选，不改变发行 pin，
不代表已发布 runtime。这些检查还必须结合宿主准入、三个真实实例、运行中的静默长任务、
DSH jobs 以及交错性能和资源测量，才能完成 #872 验收。
