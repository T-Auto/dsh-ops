# 常驻 fresh Bash 桥接

[English](./resident-fresh-bridge.md)

本 #872 切片把现有 `ops_bash` wrapper 接到内部原生任务适配器。生产选择必须同时具备
**`task-v1` 和 `task-spill-v1`**。Windows worker 现已提供[可恢复任务 spill 与终态文件保留](常驻任务输出与保留.md)，
正常主入口会为 fresh 调用选择共享原生任务适配器。缺少任一能力的 worker 保留原有执行器。
不提供用户或配置绕过；持久会话模式仍待交付。

主入口在 `residentKernel()` 之后挂载一个 `residentFreshTasks()` provider。独立集成可在共同
所有者的激活作用域中各挂载一次：

```ts
import { integration, residentKernel, residentFreshTasks } from 'dsh-ops/integration'

export async function apply(ctx) {
  await ctx.plugin(residentKernel())
  await ctx.plugin(residentFreshTasks())
  await ctx.plugin(integration({ preset: 'my-preset', profile: 'native' }))
}
```

权限服务属于依赖 fiber，不属于首个工具调用者或全局单例。完整能力的工具发布会等待该服务。
消费者一旦选择常驻后端，provider 丢失就撤销其 Bash 层，旧回调拒绝新工作，不切回逐次 runner。
兄弟 Agent 共享 provider，但各自持有不同原生 owner；旧 definition 只能由其精确发布 Agent 调用。

参数校验、cwd 解析、批准、Native 渲染、PTC schema 和 JSON digest 仍由原 wrapper 负责。
初次批准在公开 Jobs 登记前完成。每次原生队首准入都会读取当前精确 Agent/Session、权限和受管
环境，准备选定 runtime，并把**公开 sandbox 返回的原样 argv** 和完整 scrub 后环境交给原生执行。
异步 runtime/confinement 操作后重查权限。普通排队调用使用当前权限；单次扩大授权的基础权限若
变化则拒绝。权限变化取消已准入任务，排队任务保留并重新准入。

`command` 仍使用 `-c`；`script_path` 保持单个原样 argv 参数，由 Bash 在受约束 cwd 中打开，
宿主不预读或内联脚本。原 timeout 上限、正数小数计时、关闭管道 stdin 和环境优先级保持一致。
Jobs producer 不设置原生硬截止时间：前台等待可提升同一个原生任务及公开 job，显式后台登记
后独立于发起方 signal。仅当公开 Jobs preflight 拒绝且 producer 从未调用时，才允许一次原生
前台尝试。已接受任务不会改走其他 runner 重放。

诊断分类保留原生错误代码和效果事实，显示实际 denial signature 与 partial enforcement。
stderr 被截断时明确标注观测不完整，不把缺失证据当作没有拒绝。输出保留有界展示尾部，完整原始
spill 上限为 64 MiB。实时路径覆盖已报告字节；只有封存且等待回收完成的流才按实际 kernel PID 与
Session 写入既有 ledger。spill 失败撤回路径并如实标明截断，既有文件工具按原权限和分页规则恢复输出。

## 验证

两个新 suite 的 19 项检查使用实际 Context/Agent/Session/Jobs 生命周期和脚本化原生边界，覆盖
队首准入、失效授权、异步权限变化、登记/取消竞争、脚本参数、环境 tombstone/locale 归一化、
原生错误优先级、等待发布、共享所有权和撤销后不回退。原 wrapper/environment/Electron 测试再
覆盖 33 项。构建生成的 PTC declarations 仍为 120,684 字节。初测发现并修正 locale、服务 fiber
所有权、错误优先级与旧 definition 调用方 gate 问题；没有通过重试隐藏失败。
另六个受影响 suite 的 29 项检查通过，包括真实主入口/独立文件组合、legacy Bash stdin/会话
行为及未变的提示词预算。首次调用误把 Niubash 传给明确要求 pinned legacy MSYS 的 harness
输入，pin guard 在测试启动前拒绝。修正调用使用已验证的 legacy fixture 和仓库构建的 IPC
proxy，没有修改 pin 或跳过检查。

早期仓库专用 fresh 桥接探针在 Windows **6/6 通过**，
使用实际公开 policy、sandbox、subprocess、directory、受管 shell 环境、Native/PTC 执行和官方
Jobs 控制。探针显式注入内部权限服务，不修改能力声明或配置生产绕过。受限执行报告
`workspace-write`、**partial** enforcement；观测到一个公开 kernel spawn、一个 PTC process
spawn、四个原生 task 请求、零公开逐次 Bash spawn，并在等待回收后确认 kernel PID 38792
消失。这是功能/生命周期证据，不是性能或完整 #872 验收。

- Worker SHA-256：`2fcf7f1d608b71fe53d121c892465bd58bf0bb04765d7ee260c441c1c58c3b2e`。
- Stock fresh Niubash SHA-256：`7ec3ec04ce91bae64c23d7150e6b16574e9d91df8fcf0df997006e2b37bf2f1e`。
- 保留原始报告 `fresh-bridge-first.json` 的 SHA-256：
  `f6cfbfa75850e0c7715f67e086480fb95f5ebe927fb76ea25918f18e39605fbb`。

更新后的[探针](../bench/probes/probe-872-fresh-bridge.mjs) 经具备两项能力的实际 package root **7/7 通过**，
没有内部权限 factory 或替换 transport。新增 Native/PTC 完整 spill 恢复、精确封存 ledger 所有权及明确
文件分页 continuation。观测到六个原生任务请求、一个公开 kernel spawn、五个公开 PTC runner，零公开
逐次 Bash spawn；回收后 kernel PID 24844 已消失。首次新调用使用了错误的 fixture capability 名称，
内核启动前即被拒绝；第二次六项通过，但错误要求单行文件页返回 `completed`。最终断言要求 `partial`
及 continuation。两份失败报告均保留，没有为通过探针而修改生产行为。

- Worker SHA-256：`51ec139dc8e7dbb9fe7881ee71aa25c691e070bfeb122f50e7520a6bfe7383e6`。
- 保留报告 `fresh-bridge-production-third.json` SHA-256：
  `5a529dbc9032fd422c65c69ff8c9d74ec057e7e49355b9b6f1d1b3edd4634993`。

主入口发布 fixture 现在显式提供 Agent/Session/environment 权限服务并等待就绪，shell 契约不变。
默认请求字节数为 minimal 7,943、standard/cordis 12,367、PTC 18,924，均处于原有预算内。
这些功能检查不声称其余所有 PTC 或 WSL 操作都已免除独立 runner。

叠加 task-spill 后，**25 个 suite 的 263 项不同检查通过**，没有跳过的 suite；Windows 上 ledger/retention
仍明确报告两项仅适用于 POSIX 的 fixture 不可用。初次受影响 suite 运行保留了缺少 worker 路径、完整
Niubash payload 及发布 fixture 权限/就绪条件的失败。仅用于文件的假内核现在明确声明没有 task 能力。
npm shim 拒绝转发参数后，使用仓库脚本直接校验并部署原固定归档；最终检查未修改 runtime pin。

构建 TypeScript 后，提供完整 runtime 与官方控制器/环境模块路径运行：
`node bench/probes/probe-872-fresh-bridge.mjs --worker <worker> --controller <jobs-module>
--shell-env <shell-env-module> --bash <niu.exe> --report <report.json>`。不调用模型 API。
