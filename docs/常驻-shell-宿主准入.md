# 常驻 shell 宿主准入

English: [Resident shell host admission](resident-shell-admission.md).

此内部适配器将当前公开宿主权限连接到 [原生 shell 队列](常驻-shell-队列协议.md)，
用于 [#872](https://github.com/T-Auto/dsh-ops/issues/872)。它不发布工具，也不为已发布的
shell runtime 启用会话执行。完整功能仍需要合格 runtime 发行、共享可恢复输出、Native/PTC
发布、内核所有的 fresh/后台任务以及完整验收证据。

## 单一所有者与当前权限

适配器连接已经 ready、由本次激活所有的内核 `shell-v1` 通道，不另起内核，也不在宿主调度
命令。原生队首准入触发策略、批准、环境、目录、runtime 与沙箱约束准备。

所有权绑定精确的存活 Agent 和 Session 对象。每个所有者使用随机私有原生 key，复用公开
session ID 不能取得旧所有者的 shell。Agent 释放会等待原生 close。注入的权限提供者被移除
或替换时，准入服务释放并等待所有 shell 回收。内核丢失会撤销通道、报告已确认的回收结果，
结束待处理调用，不重放、不重启。

每次异步准备返回后都重查原有常驻权限与调用方生命周期。迟到批准不能授权已取消、超时、
退役或释放的请求。allowed-once 只属于同一个尚未开始的队首，包括为替换较窄 shell 而退役
后重新准入。较宽权限范围使用 `closeAfter`，在发布结果前结束其状态；后续请求单独准入。

session 事件观察到策略变化时，退役活动 shell 并保留排队请求。没有变化事件时，队首重查
仍具有最终决定权。宿主环境变化也会退役活动 shell。配置中的 Bash 身份在适配器内固定；
配置替换必须释放原适配器，不能给存活 shell 换标签。

## 启动事实与工作目录

环境来自当前宿主公开 subprocess 清理接口与 shell-env 服务。Windows 合并忽略大小写并
处理删除项，移除外层私有控制标记。非空 `NIU_ENV`、`BASH_ENV`、`ENV` 按变量名拒绝，
不打印值；runtime 准备前与最终环境合并后都检查。

初始目录由宿主解析、验证。后续省略 `workdir` 保留 shell 当前目录；显式相对路径按当前
宿主会话目录解析，作为该命令之前的持久目录变更发送。受限启动使用公开 sandbox 返回的
原样 argv，原生代码不替换 wrapper。约束缺失或无效时，在命令字节发送前失败。

## 有界关联与真实输出

通道最多保留 32 请求、32 所有者和 64 控制操作，每个请求每个流最多一个未完成读取。
重复取消合并。普通容量不足在本地提交前拒绝。共享发送窗口容纳文件与 shell 控制，
每帧仍有字节上限，实际写入同时仅有一次。

包括排队时间的截止由原生内核负责；适配器默认 120 秒，上限 10 分钟。适配器收集两个
终态输出流后才释放原生记录。输出错误保留另一个流的证据；矛盾的偏移或完成收据使连接
失败。活动流为空不代表 EOF。当前每流保留 128 KiB 前缀，报告观测总量和丢失，不声称
具有可恢复 spill。

终态状态变化在异步收集输出之前同步应用，因此旧请求缓慢收集尾部不能清除下一队首的新
启动事实。开始通知之后、命令字节之前取消，最终 `effectState: none` 仍是真实结果。

## 复现

定向测试覆盖准入、协议关联、内核通道和宿主包作用域：

```console
node scripts/build.mjs
node test/run.mjs resident-shell-admission resident-shell-channel resident-kernel host-scope-source
```

`bench/probes/probe-872-shell-host.mjs` 另使用真实 Cordis、Agent、Session、策略、目录、
subprocess 与 sandbox。批准与 shell-env 输入使用公开服务形状的受控实现。探针要求显式
worker、候选 shell、支持目录、可执行文件 hash 和报告路径，不改变发行 pin，也不构成
模型可见发布或完整应用验收。精确 hash 与结果见 PR 验证记录。
