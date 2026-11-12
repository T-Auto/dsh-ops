# Windows 索引提权与失败矩阵

状态：`ops-win-index` 的 W1 MFT 冷枚举与 W4 硬链接调和（#584、#602、#605），评审日期 2026-11-04。

`ops-win-index` 是可选加速层。它无法安全作答时会返回 `Unsupported`/`Unavailable`，调用方
按自己的遍历产出与今天逐字节一致的结果。这里不允许把权限问题变成部分结果或空结果。

## 为什么索引路径需要 Administrator

在 Windows 上打开卷做 USN/MFT ioctl 属于管理操作：

- `FSCTL_ENUM_USN_DATA`（W1 冷枚举）与 `FSCTL_READ_USN_JOURNAL`（W2 回放）需要以
  `\\.\X:` 打开卷句柄；
- 在这个卷句柄上 `OpenFileById` 才能安全解析可能已经没有当前路径的文件 id。

W1 通过 `usn-journal-rs::privilege::is_elevated` 判断令牌（fail closed：读不到令牌即视为
未提权）。未提权的 worker 返回 `SourceState::Unsupported`，所有请求回退现有 walk，输出保持
逐字节一致。

## 硬链接（W4）与权限

`FindFirstFileNameW`/`FindNextFileNameW` 接收普通文件路径而不是卷句柄。它只需要调用方对
该路径的常规 traverse/read-attributes 权限，**不**需要 Administrator，本 crate 也从不尝试
提升自身权限。需要注意：

- 调用方必须传入该文件当前的一个绝对路径作为锚点；索引通常取自已验证的候选；
- NTFS 硬链接不能跨卷，因此枚举出的名字与锚点同卷；
- NTFS 每文件最多 1024 个硬链接；[`MAX_LINKS`] 取 4096 作为病态守卫；
- 名字按 Win32 原样以 UTF-16 返回，未配对代理项会保留到索引的 WTF-8 层，而不是被有损压平。

## 失败矩阵

| 条件 | 出现位置 | 观测错误 | 数据源回答 / 调用方动作 |
| --- | --- | --- | --- |
| worker 未提权 | 打开卷 / journal ioctl | `ERROR_ACCESS_DENIED` (5) | `Unsupported`；调用方走 walk |
| 卷不是 NTFS / 无 journal | `FSCTL_*` | `ERROR_INVALID_FUNCTION` (1)、`ERROR_JOURNAL_NOT_ACTIVE` (1179) | `Unsupported`/`Unavailable`；回退 walk |
| journal 正在删除 | journal ioctl | `ERROR_JOURNAL_DELETE_IN_PROGRESS` (1178) | `Unavailable`；重试后再 rescan |
| BitLocker 锁定的卷 | 打开卷 | `ERROR_ACCESS_DENIED`、`ERROR_NOT_READY` | `Unavailable`；回退 walk |
| 文件在 journal 与调和之间被删除 | `FindFirstFileNameW` | `ERROR_FILE_NOT_FOUND` (2) / `ERROR_PATH_NOT_FOUND` (3) | `Incomplete(FileGone)`；跳过、计数、保留旧链路 |
| 对文件无 read-attributes 权限 | `FindFirstFileNameW` | `ERROR_ACCESS_DENIED` (5) | `Incomplete(AccessDenied)`；跳过、计数、保留旧链路 |
| 枚举中途失败（锁竞争、短读） | `FindNextFileNameW` | 其它错误 | `Incomplete(WalkAborted)`；丢弃部分结果、跳过、计数 |
| 名字数超过守卫 | 我们的 `MAX_LINKS` 检查 | — | `Incomplete(TooManyLinks)`；跳过、计数 |
| ReFS 128 位文件 id | W1/W2 id 转换 | — | 整个数据源 `Unsupported`；走 walk |
| 锚点是相对路径或空 | 我们的校验 | — | `Incomplete(InvalidAnchor)`；调用方 bug，不发系统调用 |

不完整的硬链接枚举**绝不**当作空集应用：那会删掉仍有链接的文件。调和循环把它计入
`LinkWalkStats::skipped` 并保留上次已知集合；下一次 `HARD_LINK_CHANGE` 再重试。

## 本 crate 不做什么

- 不提权、不弹 UAC、不使用 `SeBackupPrivilege`。
- 不做路径授权：集成层收到的每个候选仍必须经现有 cap-std 句柄复验后才能进入结果。
- 不读取文件内容。
- 不单独持久化 journal cursor 而没有匹配的索引快照（见 ops-index 持久化切片）。

## 运维建议

- 需要索引时以提权方式运行 worker；否则预期 `Unsupported` 与正确但更慢的 walk。
- 在查询旁记录 `LinkWalkStats`（attempted/completed/skipped）。跳过的调和是已知缺口，不是空
  文件，不能报告成"没有链接"。
- 持续返回 `AccessDenied` 或 journal 错误的卷应按整个请求的索引不可用处理，不要逐文件重试。
