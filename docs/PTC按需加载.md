# PTC SDK 按需加载

PTC 组件独立于 Native 文件组件提供文件 API。PTC-only 代理通常初始只包含 ops_inspect_local_file 和 ops_load_sdk。对返回引用分页或释放前，先通过 `tools.ops_load_sdk({ tools: ['result'] })` 按需加载 result；即使 `allowedTools: []`，它仍可选择。宿主根据已注册的参数与 Outcome 输出 schema 生成类型化 SDK；Native 模式不显示 SDK 加载器。

在 run_code 内调用 tools.ops_load_sdk({ tools: ['grep', 'read_files'] })。成功 Outcome 的 data.tools 列出请求名称，data.nextTurn 为 true。当前工具轮次结束、所属会话提交 step/end 后，请求的 API 会在紧接着的供应商请求中发布；当前冻结的 SDK 快照无法调用新 API。该边界前的系统提示组装、诊断组装以及工具注册通知不会提前激活排队请求。组装会等待本插件发布并按需通过公开服务获取新快照；内部呈现探测跳过此屏障，防止递归等待。

PTC 与 discovery 对独立根会话分别探测。祖先与后代的工具叠加层相互依赖，仍作为同一继承族发布。如果宿主提示词 hook 永不返回，该族无法获得新验证的工具，但其他根会话仍可创建、组装、变更权限及销毁。被取代的探测收到取消信号；即使 hook 忽略信号，销毁与卸载也会结束 OPS 自身的等待，迟到结果不得发布。本改动隔离共享队列故障类型，不据此断定 [#359](https://github.com/T-Auto/dsh-ops/issues/359) 所述多插件 Desktop 冻结的原因或恢复结果。

PTC 行配置由统一配置入口验证：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| allowedTools | 所有已实现的高级文件 API 和 batch | 加载器可请求的原始名称；空数组禁止配置的高级选择；无论是否开启常驻，均保留 result 隐式选择例外。 |
| alwaysLoaded | [] | 立即在本行覆盖的 PTC 代理中发布的高级 API，独立于允许池。 |
| binaryPath | 打包的 worker | 可选的绝对 worker 可执行文件路径。 |
| required | false | worker 不可用时令组件启动失败。 |

高级名称为 grep、glob、replace、write_file、edit_file、diff、stat、copy、move、remove、read_files、read_table、read_docx、read_pdf、batch、result。每次原子验证 1–5 个名称；未知键、带公开前缀的名称、常驻 API 与未实现功能均拒绝。内置 PTC 行表单可编辑这些经过验证的数组及 required、binaryPath，并通过宿主持久化。可选自定义浏览器页面目前覆盖发现、替换和 shell，不含 PTC。新 profile 默认派生全部已实现高级 API；已保存的显式 allowedTools 数组继续优先。包括两个初始入口与按需加载的 result 在内，完整 SDK 有 18 个 API。详见[配置参考](配置参考.md)与[文档边界](原生内核.md)。

选择绑定准确的活动代理；同级与子代理不继承其他代理加载的 SDK。同一代理内，已加载选择可保留至组件或代理卸载。沙箱模式变化会清空排队请求并取消活动调用；每次 worker 调用仍重新检查当前权限。卸载会撤回自身注册并拒绝保留的回调。切换至 Native 会移除 PTC API，并仅恢复文件组件此前可见的 Native 定义；重叠 PTC 配置行由最近作用域的行负责，同一作用域内后挂载行优先，卸载后恢复此前的行；不修改共享注册表。

先检查 Outcome.status 再使用 data。部分结果保留覆盖信息及 continuation；失败保留错误代码、影响状态和重试策略。加载器不执行文件操作，也不授予文件系统权限。本页不声称 token 基准或 IO 提速。

## 返回形状与宿主边界

Glob 的 `paths` 返回字符串；`details` 返回 `{path, bytes, modified, kind?}`。Grep 的
`files_with_matches` 返回 `{path}`，`count` 返回 `{path, count}`，`content` 返回
`{path, line, text}`，`definitions` 再增加 `kind`；`summary` 没有行，汇总数位于
`files` 和 `matches`。文本行还可能带有行内截断事实。`read_files` 返回各文件独立的
receipt，包含各自的 `items`、`complete`、`nextOffset` 或 `error`。PTC 输出 schema
描述这些不同的行形状，并移除搜索顶层不适用的元数据；不修改 canonical 值或 Native 呈现。

当前固定版本的 DSH `renderToolsSdk` 对每个注册 JSON schema 分别生成 `ToolArgsMap`
和 `ToolOutputMap`。支持的 schema 子集没有 `$ref`/`$defs`，`ToolDefinition` 也没有
自定义 SDK 声明 hook。因此，在**模型可见** SDK 中跨工具共享 `Outcome<T>`、分页与引用
声明，或让返回类型随 `outputMode` 参数变化，需要宿主扩展。仅修改包内 `.d.ts` 无法
修复该提示文本。这仍是 #865 的宿主依赖；OPS 不替换宿主渲染器，也不另加一套声明块。

ops-ptc 批量教程与提醒和共享 SDK 分开。示例使用真实行形状、检查返回的失败，不假定
普通局部变量跨程序保留。绕过提醒区分字面 shell 文件操作与命令输出过滤（如
`git diff | head`）；不能确定的 shell 语法不触发确定性的指控。以当前 SDK 为准，
只加载缺失的 API。关闭 `batchingGuidance` 不注入教程或提醒；原版 PTC 和 Native
不会因此默认带上 ops-ptc 教程。

## 精简加载器指导

OPS 作用域提示段只保留一行指向当前真实可见的 `ops_load_sdk`，不再常驻完整任务目录。加载器描述列出配置的原始名称及隐式 `result` 例外。这是配置池，不证明当前执行权限：选择与提交时重新检查当前权限，真实调用还会再次执行权限检查。优先使用已可调用的 SDK；否则选择 1–5 个准确原始名称，等待下一个模型步骤。不存在关键字搜索 SDK API。

关闭常驻发布时，加载器仍只使用配置的 `allowedTools` 加 `result`，不隐式恢复 `inspect_local_file`，也不恢复允许池中缺失的 `read_files`。加载器已启用且可用时，即使 `allowedTools: []`，仍可加载 `result`，包括只读 page/release。关闭动态加载会移除加载器；资格例外不会创建不可用的加载器。

worker/服务不可用、非所有者配置行以及 Native/both 展示均不广告 PTC 加载器指导。只读权限下，选择拒绝修改类 API 与 batch；不会推断具体路径/动作权限，不探测 worker，也不调用 Native provider。沙箱事件清空排队选择；已加载 schema 可以保留可见，但执行不能绕过当前权限。配置重载、作用域所有权变化、展示撤回、卸载和代理销毁均通过现有 PTC 生命周期刷新或移除指引与加载器。

English: [Progressive PTC SDK loading](./ptc-sdk-loading.md).
