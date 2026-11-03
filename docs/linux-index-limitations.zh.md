# Linux 索引限制

状态：`ops-linux-index`（#588）L3（#608），2026-11-04。本 crate 目前只是库、尚未接入 worker；本页记录未来调用方
可以依赖的答案，避免回退契约到生产环境才被发现。

## 永不支撑索引的文件系统

数据源会用内核挂载表判定根目录。以下类别一律拒绝：

| 类别 | 挂载表中的类型名 | 状态 |
| --- | --- | --- |
| NFS | `nfs`、`nfs4`、`nfsd`（全部 `nfs*`） | `Offline` |
| FUSE | `fuse`、`fuse.sshfs`、`fuse.rclone`、`fusectl`（全部 `fuse*`） | `Offline` |
| CIFS/SMB | `cifs`、`smb`、`smb3` | `Offline` |
| 9p | `9p` | `Offline` |
| Ceph | `ceph` | `Offline` |
| AFS | `afs` | `Offline` |
| procfs | `proc` | `Offline` |
| sysfs | `sysfs` | `Offline` |
| debugfs | `debugfs` | `Offline` |
| tracefs | `tracefs` | `Offline` |
| securityfs | `securityfs` | `Offline` |
| cgroup | `cgroup`、`cgroup2` | `Offline` |

`Offline` 即 `SourceState::Unavailable`：数据源不参与查询，调用方改跑现有的有界遍历，输出与没有索引时逐字节一致。

根目录按「拥有它的挂载点（最长前缀匹配）」判定，因此覆盖在 NFS 树上的 bind mount 按本地文件系统处理，而
`/proc`、`/sys` 之下的路径即使卷根在别处也会被拒绝。

### 已知缺口

该判定是保守的「名字白名单」，不是「本地性证明」。上表未列出的网络/伪文件系统（例如 `virtiofs`、`gpfs`、
`lustre`、厂商内核换了拼写的 `fuse.*`、或树外网络文件系统）会按可索引放行。把本地文件系统误判为远端只会多跑一次
调用方本来就要跑的遍历，代价很低；漏判才是正确性风险。发现一个就同时扩展 `UnsupportedFs::from_fs_type` 与本表。

### 为什么读挂载表而不是 statfs(2)

本 crate 是 `#![forbid(unsafe_code)]`，也没有 `libc`/`rustix` 依赖，无法直接发起 `statfs`
系统调用。它改为读取 `/proc/self/mounts`：其中的类型名就是 `statfs` 会以 `f_type` 返回的那个
文件系统类型，同时提供判定「哪个挂载点拥有根目录」所需的挂载点路径。读取只是普通文件 I/O；判定逻辑是纯函数，
用合成挂载表做单测。将来若有经评审的系统调用封装，只需替换这一处读取。

挂载表按**字节**读取，挂载点保留原始字节（内核只把空格、制表符、换行、反斜杠转义为
`\040`、`\011`、`\012`、`\134`）。因此非 UTF-8 挂载点既不会让解析失败，也不会拖垮其它根目录的判定。
匹配前会 canonicalize 根路径，所以指向 `/proc` 的符号链接会按 procfs 处理。

### 失败即 Offline

若挂载表读不到、或根路径无法 canonicalize，数据源报告 `Unavailable`（Offline），而不是回落到 phase 状态：
「无法证明是本地」不等于「本地」。代价仍是调用方本来就要跑的遍历。

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
