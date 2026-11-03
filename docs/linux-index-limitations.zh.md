# Linux 索引限制

状态：`ops-linux-index`（#588）L3（#608），2026-11-04。本 crate 目前只是库、尚未接入 worker；本页记录未来调用方
可以依赖的答案，避免回退契约到生产环境才被发现。

## 永不支撑索引的文件系统

数据源会用内核挂载表判定根目录，拒绝以下四类：

| 类别 | 挂载表中的类型名（前缀匹配） | 状态 |
| --- | --- | --- |
| NFS | `nfs`、`nfs4`、`nfsd` | `Offline` |
| FUSE | `fuse`、`fuse.sshfs`、`fuse.rclone`、`fusectl` | `Offline` |
| procfs | `proc` | `Offline` |
| sysfs | `sysfs` | `Offline` |

`Offline` 即 `SourceState::Unavailable`：数据源不参与查询，调用方改跑现有的有界遍历，输出与没有索引时逐字节一致。

根目录按「拥有它的挂载点（最长前缀匹配）」判定，因此覆盖在 NFS 树上的 bind mount 按本地文件系统处理，而
`/proc`、`/sys` 之下的路径即使卷根在别处也会被拒绝。

### 为什么读挂载表而不是 statfs(2)

本 crate 是 `#![forbid(unsafe_code)]`，也没有 `libc`/`rustix` 依赖，无法直接发起 `statfs`
系统调用。它改为读取 `/proc/self/mounts`：其中的类型名就是 `statfs` 会以 `f_type` 返回的那个
文件系统类型，同时提供判定「哪个挂载点拥有根目录」所需的挂载点路径。读取只是普通文件 I/O；判定逻辑是纯函数，
用合成挂载表做单测。判定刻意保守：误判 `Offline` 只多跑一次调用方本来就要跑的遍历，而错误的索引答案会是正确性
缺陷。其它本地文件系统仍可索引。

## inotify 无法跨进程回放事件

- inotify watch 是进程内的内核状态。事件队列属于某个进程的 inotify 描述符，其它进程无法访问，也无法存进快照。
- 每次 `dsh_ops` 工具调用都是一个新 worker 进程。上一次调用构建的快照无法靠下一次调用的 watcher 追上：没有可回放
  事件的游标。下一次调用只能冷重建或从无 watcher 状态开始。
- worker 重启（崩溃、超时、宿主重启）必然是冷重建，没有快速路径。
- 内核队列溢出会让会话作废快照并报告需要重扫；会话绝不会把截断的队列回放到过期快照上。
- 没有 watcher 期间发生的变更会永久丢失；状态会报告 `Unsupported` 或 `Unavailable`，而不是声称
  `Ready`。
- 持久化快照（#586）可以缓存一次冷构建，但不提供回放：进程不在时发生的事件无法获得。因此 Linux 上的跨调用新鲜度
  需要数据源自带持久 journal（Windows 的 USN 路径有）；Linux 没有非特权等价物，Linux 快照只有在调用方接受
  「重新校验/重扫」这一步时才可用。
