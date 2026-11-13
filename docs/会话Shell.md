# 显式会话 Bash 执行

这是尚未发布的 #872 集成切片。发布前仍须验收原生 shell transport 与运行时、可恢复的原生输出
spill/分页、由内核拥有的显式 job，以及剩余生命周期和性能要求。当前只保留前缀是已知缺口，
不能替代原有完整 spill 契约。

`ops_bash` 默认仍为 `execution: "fresh"`，保留既有工作目录解析、审批、脚本文件、输出 spill 和
宿主 Jobs 行为。当前生产运行时 pin 仍仅支持 fresh：尚无完整软件包通过持久协议所有权验收，也没有
配置覆盖开关。未来完整软件包获准、所属内核声明 `shell-v1` 且权限服务就绪后，同一工具才能接受 `execution: "session"`。
Native 调用与 PTC 的 `tools.ops_bash()` 共用根激活作用域拥有的准入服务；没有另一套 PTC shell，
也不会隐式回退到 fresh。

已复现现有 stock 运行时的完成判定缺口：仓库外复制的 driver 在原始 stdout reader 已读取 23 字节、
但尚未更新捕获计数时暂停该 reader。driver 已返回 exit 0、私有流 EOF 与 `reset: false`，那些原始
输出仍未计入结果；释放暂停后，下一次存活状态检查才拒绝。因此，私有回执与诊断计数不能证明
stock 运行时的原始流已经静止；内存顺序、一致快照或静默等待都不能修复这项所有权缺口。本地报告
`diagnostic-reader-gate-b96dc2350db54d7aaeb0c0d31b7173db/report.json` 的 SHA-256 为
`5861867d320b6c33280b28cff19c74a499d001b9709425faafb75c766b4e6ea3`。
这是当前完整生产软件包仍不具备 session 模式资格的一项具体证据。

```js
await tools.ops_bash({
  execution: "session", description: "Remember the package directory and build flag",
  command: "cd packages/core; export BUILD_FLAVOR=debug; build_label() { printf '%s' \"$BUILD_FLAVOR\"; }"
});
const result = await tools.ops_bash({
  execution: "session", description: "Print the remembered directory and build flag",
  command: "pwd; build_label"
});
```

状态归属精确的宿主 Agent/Session。原生内核串行处理同一会话的请求，不同会话可以并行。首次建立
目录后，省略或空白 `workdir` 保留 shell 当前目录；显式 `workdir` 按当前宿主目录规则解析，并在
命令前改变持久 cwd。导出的环境变量、函数与 shell 选项保留。每次命令的 stdin 从 EOF 开始；
干扰保留协议的文件描述符和 trap 不属于支持的持久状态契约。

请求到达队首时检查当前权限、宿主环境与选中的 Bash，并在异步准备/审批后再次检查。权限、环境
基线或运行时变化会销毁旧 shell，后续排队请求重新准入。一次性提权仅用于该命令，执行后关闭其
shell。释放 Agent 会关闭所属 shell 和排队请求；释放共同 provider 会等待所有所有者清理。
重置、崩溃或断连后不会重放已开始的命令。

| 会话结果 | 含义 |
| --- | --- |
| `shellState: "preserved"` | 命令后仍有可复用 shell；仍须单独检查 `stateLost`。 |
| `shellState: "reset"` | shell 已消失，下次准入从新状态开始。 |
| `shellState: "unchanged"` | 入队前的本地校验/准入拒绝，本次尝试没有改变 shell 状态。 |
| `shellState: "unknown"` | 非预期适配器故障未能确认 shell 状态或清理。 |
| `stateLost` | 旧状态因权限、环境、运行时变化或之前的重置而丢失；即使已有替代 shell 也会报告。 |
| `cleanupConfirmed` | 原生回执确认所需清理；false 不能视为干净结束。 |
| `failure.effectState` | `none` 证明此命令未应用；`unknown` 要求再次尝试前检查既有影响。 |
| `denialObservation` | 拒绝被 `detected`、`not-observed`，或 stderr 截断导致检测 `incomplete`；未见特征不证明没有拒绝。 |

会话 `timeoutMs` 默认 120000，上限 600000，必须是正整数；期限包含排队和准入时间。已开始命令
超时/取消会停止其所属 shell 并报告状态丢失。排队请求过期不证明另一个正在执行的命令被停止。
会话调用不会自动转为后台 job。

当前会话模式仅接受 `command`。`script_path`、自定义 `graceMs` 和开启 `includeDiagnostics`
会在执行前明确拒绝，并提示使用 fresh。`run_in_background: true` 同样拒绝；独立宿主 job 应使用
fresh，且不继承持久 shell 的函数或 cwd 变化。留下隐式后台进程或私有描述符的命令不能被视为完成，
内核会重置所属执行范围；显式等待结束的命令仍是普通前台工作。

输出分 stdout/stderr，`retention: "prefix"` 表示每流最多保留前 128 KiB；`bytesTotal` 计数观测
到的字节，`truncated` 标明丢失。不伪造 `spillPath`，不能分页取回丢弃字节，也不会用 JSON 摘要
声称前缀就是完整输出。Native 文本展示此限制和状态变化，PTC 返回类型化字段。fresh 的 spill
保持不变；会话模式的既有预算/分页/spill 要求仍待完成，不能据此宣称发布验收通过。

独立集成先在共同所有者作用域挂载一次 provider，再挂载消费者：

```js
import { residentKernel, residentSessionShells, integration } from 'dsh-ops/integration';
await ctx.plugin(residentKernel());
await ctx.plugin(residentSessionShells());
await ctx.plugin(integration({ preset: 'my-preset', shell: true }));
```

包主入口已完成此组合，但当前软件包门控使其仍仅暴露 fresh。没有 `shell-v1` 的内核同样仅暴露原来的 fresh 定义；内核/provider 丢失不会让
会话请求回退到 fresh。针对性测试使用真实 Cordis/Agent 所有权和脚本化 transport，只证明发布、
schema 与准入行为；物理运行时与完整 Native/PTC 调用仍需独立真实内核探针。仓库专用候选运行时
探针在真实根激活下挂载已有的内部准入 seam，记录精确二进制哈希与准备后的支持文件；这不证明
生产运行时选择已经通过。这些检查均不证明性能提升。

2026-11-14 本地验证通过 23 个新检查与 92 个既有针对性检查，共 115 个。最初 Bash-session 套件
因缺少 fixture 跳过；提供既有、已验证的旧版 Bash fixture 后，该套件六个检查全部通过。这不是
完整发布 gate。[真实公开调用探针](../bench/probes/probe-872-session-public.mjs) 的六个检查覆盖
12 次调用，worker SHA-256 为
`21d3e339830e9fdee9eadd91e51d7bf99e14ecb030213aac3711ca0fabd9530d`，候选运行时 SHA-256 为
`7c4332044ac5fd1b789f30b29c155a62f12f07f8dd3495244bda3ce4e0e84664`。
清理完成后观测到内核 PID 31592 已消失。本地报告 `c2-session-public-final.json` 的 SHA-256 为
`1463e2ba3900e07fcf3bf7533abe66f97f8e206ff5b779316de51d6386f5aca3`。
首份报告保留了后台参数指导文本的一次失败断言；修复该具体校验顺序后，修正版与最终 worker
版本均通过六个检查。
