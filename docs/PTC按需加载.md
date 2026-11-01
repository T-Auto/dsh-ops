# PTC SDK 按需加载

PTC 组件独立于 Native 文件组件提供文件 API。PTC-only 代理通常初始只包含 ops_inspect_local_file、ops_result 和 ops_load_sdk。宿主根据已注册的参数与 Outcome 输出 schema 生成类型化 SDK；Native 与 both 模式不显示 SDK 加载器。

在 run_code 内调用 tools.ops_load_sdk({ tools: ['grep', 'read_files'] })。成功 Outcome 的 data.tools 列出请求名称，data.nextTurn 为 true。当前工具轮次结束、所属会话提交 step/end 后，请求的 API 会在紧接着的供应商请求中发布；当前冻结的 SDK 快照无法调用新 API。该边界前的系统提示组装、诊断组装以及工具注册通知不会提前激活排队请求。组装会等待本插件发布并按需通过公开服务获取新快照；内部呈现探测跳过此屏障，防止递归等待。

PTC 与 discovery 对独立根会话分别探测。祖先与后代的工具叠加层相互依赖，仍作为同一继承族发布。如果宿主提示词 hook 永不返回，该族无法获得新验证的工具，但其他根会话仍可创建、组装、变更权限及销毁。被取代的探测收到取消信号；即使 hook 忽略信号，销毁与卸载也会结束 OPS 自身的等待，迟到结果不得发布。本改动隔离共享队列故障类型，不据此断定 [#359](https://github.com/T-Auto/dsh-ops/issues/359) 所述多插件 Desktop 冻结的原因或恢复结果。

PTC 行配置由统一配置入口验证：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| allowedTools | 所有已实现的高级文件 API 和 batch | 加载器可请求的原始名称；空数组禁止高级选择，关闭常驻时仅保留 result 例外。 |
| alwaysLoaded | [] | 立即在本行覆盖的 PTC 代理中发布的高级 API，独立于允许池。 |
| binaryPath | 打包的 worker | 可选的绝对 worker 可执行文件路径。 |
| required | false | worker 不可用时令组件启动失败。 |

高级名称为 grep、glob、replace、write_file、edit_file、diff、stat、copy、move、remove、read_files、read_table、read_docx、read_pdf、batch。每次原子验证 1–5 个名称；未知键、带公开前缀的名称、常驻 API 与未实现功能均拒绝。内置 PTC 行表单可编辑这些经过验证的数组及 required、binaryPath，并通过宿主持久化。可选自定义浏览器页面目前覆盖发现、替换和 shell，不含 PTC。新 profile 默认派生全部已实现高级 API；已保存的显式 allowedTools 数组继续优先。包括三个常驻入口在内，完整 SDK 有 18 个 API。详见[配置参考](配置参考.md)与[文档边界](原生内核.md)。

选择绑定准确的活动代理；同级与子代理不继承其他代理加载的 SDK。同一代理内，已加载选择可保留至组件或代理卸载。沙箱模式变化会清空排队请求并取消活动调用；每次 worker 调用仍重新检查当前权限。卸载会撤回自身注册并拒绝保留的回调。切换至 Native/both 会移除 PTC API，并仅恢复文件组件此前可见的 Native 定义；重叠 PTC 配置行由最近作用域的行负责，同一作用域内后挂载行优先，卸载后恢复此前的行；不修改共享注册表。

先检查 Outcome.status 再使用 data。部分结果保留覆盖信息及 continuation；失败保留错误代码、影响状态和重试策略。加载器不执行文件操作，也不授予文件系统权限。本页不声称 token 基准或 IO 提速。

## 在同一段程序里组合读取与编辑

常驻或已加载的读取回执足以驱动同一段 run_code 内的编辑：某一行的 text 就是唯一的 oldText，data.revision 正是编辑本来就需要的 expectedRevision。无需第二个模型步骤，也不必手工重新推导行号。

```js
const read = await tools.ops_inspect_local_file({ path: 'plan.md' })
const anchor = read.data.items.find(item => item.text === 'omega step').text
const edited = await tools.ops_edit_file({
  path: 'plan.md',
  expectedRevision: read.data.revision,
  edits: [{ oldText: anchor, newText: anchor + ' (done)' }],
})
return { read: read.status, edited }
```

先看 status 再用 data：completed 的编辑回执带有新 revision，被拒绝时保留 error.code 与 error.effectState。REVISION_CONFLICT 表示该次读取之后字节已变化，应重新读取而不是重发旧 revision；partial 读取从不代表整份文件。编辑仍执行唯一匹配、CAS 与原子发布；SDK 不替调用方决定改哪一行、不做 rebase，也不会把分页行拼回文件内容。

## 实时 PTC 目录

关闭常驻发布时，目录与加载器只使用配置的 `allowedTools` 加 `result` 例外，不再隐式恢复 `inspect_local_file`，也不恢复允许池中缺失的 `read_files`。配置解析仍拒绝仅常驻名称；开启常驻时的普通基础发布行为不变。

只有本行实际的 `ops_load_sdk` 可用时，现有 OPS 作用域提示段才会显示紧凑任务目录。原始名称和任务提示来自 PTC 能力元数据，允许池与加载器实际选择共用。优先使用常驻或已经可调用的 SDK；足以完成任务时不加载更多。否则查阅提示，选择 1–5 个列出的准确原始名称，等待下一个模型步骤。不存在关键字搜索 SDK API；没有匹配项只表示当前可用池中没有对应提示，不说明还有其他工具可用。

已可调用的 API 由宿主类型化 SDK 描述，不重复列入目录。空允许池、关闭动态加载或提示、worker/服务不可用、非所有者配置行以及 Native/both 展示均不广告目录。只读权限下省略修改类 API 与 batch；关闭常驻 API 时 result 仍可选，用于只读 page 操作。此保守预检由加载器共用，并在提交排队选择前再次检查；不会推断具体路径/动作权限，不探测 worker，也不调用 Native provider。真实调用仍执行权限检查。沙箱事件清空排队选择；已加载 schema 可以保留可见，但执行不能绕过当前权限。配置重载、作用域所有权变化、展示撤回、卸载和代理销毁均通过现有 PTC 生命周期刷新或移除目录。

English: [Progressive PTC SDK loading](./ptc-sdk-loading.md).
