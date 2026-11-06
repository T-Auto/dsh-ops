# 索引集成（G3）

本文记录 P0–P7、M1、L1、W1、G1、G2 之后，索引数据源如何接入搜索路径。面向维护者与审查者：
说明接了什么、代价是什么、还有哪些情况会回退。

## 接了什么

- **私有缓存目录**：操作者在插件行里把 `indexCache` 设为 `true` 后，宿主解析
  `<DSH_HOME>/dsh-ops/index-cache`，缺失时创建，并在 POSIX 上强制 `0700`。Windows 上 Node 无法
  设置 ACL，目录继承 `%USERPROFILE%` 的 ACL，只控制只读属性；其隐私来自 profile ACL 而非模式位。
  若 `dsh-ops` 或 `index-cache` 是符号链接，或解析后不在 home 之下，一律拒绝且不发送
  `cache_dir`。`DSH_HOME` 即插件原本使用的 home（默认 `~/.dsh`）；每次 worker 调用最多准备一次，
  且从不把该路径暴露给模型。
- **envelope 提示字段**：准备好的路径以 `cache_dir` 进入请求 envelope。它是宿主元数据，不是工具
  参数：任何 `ops_glob`/`ops_grep` 参数都不能设置或覆盖它，worker 只把它当作提示。
- **按请求选择数据源**：存在 `cache_dir` 时，`ops-search` 按构建目标构造平台 source，并交给复验
  遍历（`Scan::walk_indexed`）回答。只有 `glob` 请求走这条路径（G3 边界）；`grep` 读取文件内容，
  在它自己的集成切片之前继续使用 live walk。平台 crate 是 target 门控依赖：Linux 构建链接
  `ops-linux-index`，macOS 构建链接 `ops-mac-index`；同一时刻只编译一个，纯 `ops-index` crate
  不引入任何平台依赖。Windows 通过 `win-index` feature **显式可选**（#718）：MFT/USN crate 会把
  COM 调用带进 worker 导入表，所以默认 Windows 构建选择 `NullSource`、从不链接 `ops-win-index`。
- **cursor 绑定 source 种类**：续页 token 记录产生该快照的遍历种类（walk 为 `s1:`，索引路径为
  `s2:`）。第二页被绑定到该种类；若实际服务它的遍历不同，返回 `SEARCH_STALE`，绝不混用两个
  快照域。

## 代价与不会付出的代价

索引缓存默认关闭。关闭时宿主不准备目录、不发送 `cache_dir`，每次搜索走的都是本切片之前的
遍历。开启时宿主每次调用最多做一次有界准备；任何失败——home 不存在、`EACCES`、磁盘满、路径不是
目录、模式无法强制、缓存路径是符号链接——都被吞掉：不发送 `cache_dir`，worker 继续 walk。索引
失败永远不会变成搜索失败。

## 目前仍然回退（原因）

M1/L1/W1 交付的平台 source 只能做冷枚举，还不能证明快照已追上：FSEvents、inotify、USN 回放都还
没有。它们的 `state` 因此始终是 `Unsupported`/`Unavailable`，绝不会 `Ready`，
`Scan::walk_indexed` 每个请求都回退到 live walk。输出、计数与 `scanComplete` 因此与上一版完全
一致——接线的意义是让后续 watcher 切片能够打开它，而不是今天就改变结果。

把一页真正变成索引结果的是 watcher 切片（M2/M3、L2/L3、W2/W3/W4）与快照持久化（PS1–PS3）。
在那之前，仅保存 `cache_dir` 不会改变任何答案，worker 用不了的 `cache_dir` 也不会弄坏任何答案。

## 验证

- Rust：`ops-search` 用 fake-`Ready` source（仅 `cfg(test)`，`native/src` 没有测试旁路）覆盖按请求
  选择、`glob` 门控与回退：索引 glob 输出与 walk 逐字节一致、带 cache 提示时 `grep` 也绝不查询
  source、有 cache 目录但 source 未 Ready 时回退、索引查询第二页可续、索引续页 token 经 walk 重放
  得到 `SEARCH_STALE`。
- 宿主：`test/index-cache.test.mjs` 覆盖默认关闭、POSIX 上以 `0700` 创建目录、把既有的更宽目录
  收窄、拒绝符号链接缓存路径，以及 `EACCES`/`ENOSPC`/模式无法强制时的回退（不发 `cache_dir`、
  不抛错）。
- 三平台 CI：各 leg 编译对应平台 crate 并跑回退测试。
