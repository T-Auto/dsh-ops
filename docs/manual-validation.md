# dsh-ops 手动验收清单

本轮按风雪要求：不补/改回归测试，不加 CI，不运行旧套件。本清单是操作者步骤，不是自动化门禁。替换源码后先重启 DSH。

## 工具发布与提示词

- `workspace-write`、`read-only`：目录只有四个 ops 文件工具；没有任何 `ops_run` / `ops_job_*`，提示词也不出现这些名字。
- `danger-full-access` 且 `enableShellTools: true`：五个命令/job 工具一起出现。
- `enableShellTools: false`、无 sandboxPolicy 服务、无会话：命令组不出现。
- 同时开受限会话与完全权限会话：两者目录互不污染。受限子 agent 不继承祖先的命令组。
- 同一会话切换受限 → 完全权限 → 受限：每次下一请求目录/提示词跟随变化，不重连 FastCtx；旧命令句柄不能继续调用。
- `ops_bash` 不出现；提示词仅一段 `dsh-ops:repository-tooling`，没有旧 host-shell 段或 `mcp:fastctx`。
- `promptPolicy: false`：不发布路由提示词。
- `deny-host-shell`：有无 ops 命令组都应拒绝配置的宿主 shell；若工具来自继承层，目录也应遮蔽。无可用执行器时不推荐不可调用的 ops 命令。

## 文件工具

- 多文件多区间 `files[]`，各自 offset/limit/encoding；重复路径读取不同区间，结果有序。
- GBK 文本显式 encoding；单文件 grep encoding、目录 fallback_encoding。
- grep `pattern` 是字符串，不传数组；`glob[]` 可混正负规则。
- glob `pattern[]`、`!` 排除、paths/details；没有 count 模式。
- grep schema 只公开 context；content/count/summary 与分页结果仍符合上游行为。
- PDF text、pages 翻页、hex；text 模式外不要让 ops 渲染图像。
- 普通图片路径：错误明确说使用宿主 read_image；改后缀的图像也不能返回成功占位符。图像 `view: hex` 可以读取字节。
- 跨文件替换先 dry_run，再在临时副本上应用；精确编辑走宿主 edit。
- 只读工具可并发；替换/命令不应声明并发安全。

## 任务与输出隔离

- 当前会话没启动 job：ops 结果没有别的会话的 Background 行。
- 启动 job，保留返回 ID；输出、列表、kill 只操作自己的 ID。
- A/B 两会话各启动 job：各自 footer/list 只见自己，不能读取/kill 对方 ID。
- 完成/kill 后仍能读取自己已有 ID 的日志。
- job_list status/limit/offset 是自己的分页，不暴露全局总数/offset；空列表明确为空。
- 大全局 job 存储扫描不完整时必须报告 Partial，不冒充完整；原工具结果的 Complete/Partial 续页提示不能丢。
- 重连后不认领旧 ID；操作者可通过上游工具清理持久 job。权限降级不自动杀已运行任务，须操作者管理。

## 生命周期与边界

- 服务端断线立即撤下工具与对应提示词项，恢复后重新出现。
- 卸载后工具/提示词/限制全部消失；共享注册表方法未改写，外来同名工具仍可按自己的 scope 注册。
- 未知配置键报错点名；required=true 的缺失/不可用二进制拒绝激活。
- 取消/传输超时只表明停止等待，不把它误读为命令已停止。ops_run 的 timeout_ms 才是上游进程树超时。

## 数字复核

运行 `node scripts/measure-schemas.mjs docs/schema-current.json`，对比 `schema-baseline.json`。不执行真实文件/命令操作。统计的是紧凑 schema JSON 的 UTF-8 字节，tokens≈bytes/4，不是使用频率或准确账单。基线来自修改前 dee3c57 + FastCtx 0.2.6；工具调用频率仍未知，不据此删除 ops_replace。

## 不可误读为已解决的边界

四个 FastCtx 文件工具仍是非宿主沙箱后端，ops_replace 没有 workspace confinement；命令权限门不解决这件事。没有文件系统约束设计前，不作为不可信受限环境的安全方案。宿主审批策略与 sandbox mode 独立，本插件没有新增逐命令审批升级。
