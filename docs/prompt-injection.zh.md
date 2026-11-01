# 提示词注入集成

此包导出两个按作用域管理、可释放的集成接口。

## 系统段落

`registerSystemSection(owner, agent, options)` 通过宿主 `systemPrompt` 服务，在目标 agent 作用域注册一个段落。`id` 与 `revision` 是生产者元数据，`priority` 控制确定性的顺序。段落名在内部使用 OPS 命名空间，因此不会遮蔽无关宿主段落。文本按字面处理（`{{...}}` 不会插值）。释放函数可重复调用，并在 owner 或 agent 释放时移除段落。

宿主的 `complete` 段落仍然优先。本接口不会绕过 complete-prompt optout。

## 示例

```ts
import { registerSystemSection, registerStepTailProvider } from 'dsh-ops/prompt-injection'

// Call inside a plugin with the target Agent already available.
const removeSection = registerSystemSection(ctx, agent, {
  id: 'example:guidance', revision: '1', priority: 3200,
  text: 'Use {{literal braces}} exactly as written.',
})
const removeTail = registerStepTailProvider(ctx, agent, {
  id: 'example:state', revision: '1', priority: 10,
  provide: ({ signal, step }) => signal.aborted ? undefined : `Current step: ${step}`,
})
// 撤销后续贡献；已经交给宿主的尾部快照仍可能被日志接纳。
removeTail()
removeSection()
```

两个函数均返回可重复调用的 `() => void`。同一目标 agent、同一贡献种类的 id 必须唯一（包括不同 owner 插件之间）；重复会抛错。替换 revision 前先释放旧注册。priority 默认为零，必须是有限值，按升序排列，同值按 id 的 code-unit 顺序排列。id 与 revision 必须非空。revision 是不可变的注册元数据，不会自动触发缓存失效。释放只会在 batch 交还给宿主 pre-step 之前撤回尾部。越过该边界后，即使 provider 在提交前被释放，已完成的快照仍可能被接纳并写入日志。替代注册只从后续的非空接纳 batch 起生效。

系统段落 text 也可为同步 `(context: AssembleContext) => string`；只能使用当前组装的 signal，不能用其控制后续 turn。尾部 `provide` 返回 `string | undefined` 或对应 Promise；`''` 和 `undefined` 不产生消息。输入 messages 是深度冻结的独立快照，不是可写 inbox 视图。signal 在 admission 取消或 provider 移除时结束，provider 应配合取消。异常包装为带 id、revision、cause 的 `PromptProviderError`，可在正常 `agent/error` 中观察；不会隐藏重试。

系统段落注册要求 `systemPrompt` 服务已经可用。这些函数不会挂载组件、注册工具、更改权限或安装进程全局 provider。complete 系统提示词只抑制额外系统段落，不抑制独立注册且写日志的 batch 尾部。其它插件的协作 pre-step hook 也可能转换 batch；此接口保证本 hook 处已接纳 batch 的尾部，而不是 provider wire 归一化或所有下游 hook 之后的位置。

已使用安装的 `0.2.0-rc.2` 宿主真实 AgentLoop 与假 LLM capture 验证。`0.2.1-rc.2` 参考源码具有相同公开 pre-step admission 契约；本 slice 只读了该版本，未安装或执行它。

## 已接纳步骤尾部

`registerStepTailProvider(owner, agent, options)` 包装宿主 `agent/pre-step` waterfall：下游 `next()` 返回 `enter` 后，只有该决定包含非空的已接纳用户消息 batch 时才运行 provider。provider 收到冻结的只读快照、agent、turn、step 与本次 admission signal。结果按 priority 和 id 排序，并作为带插件归属的 `UserMessage` 追加到已接纳 batch 尾部。

这是会写入 session 日志的历史，不是临时 request overlay、system-role 尾部、伪造的用户授权，也不是保证每次模型请求都运行的 hook。空 batch（包括纯工具续步与 turn-closing 探针）不会调用 provider，也不能借此唤醒 loop。空结果不创建消息。provider 拒绝会沿宿主正常错误路径中止 admission；admission signal 在提交前取消会阻止提交。provider 释放的范围更窄：它会取消等待中的计算，不等待不协作的 promise；已完成的贡献会在本 hook 把 batch 交还给宿主 pre-step 之前进行最后一次 active 检查，并且该检查与返回之间没有异步间隙。这就是快照交接（线性化）边界，不是直到 commit 都可撤回的保证。已安装宿主随后还会运行 `agent/request` 和 `prepareCall()`，才把接纳 batch 追加到 session 日志；这些阶段中的释放不会撤回已经交接的快照，也不会擦除已有历史。模型重试复用同一批已接纳消息，不会重复追加尾部。

source kind 为 `dsh-ops:step-tail`，并携带 contributor、revision、turn、step 元数据以支持归属与回放。

## 条件式任务等待指导

启用 Shell 且 `promptPolicy: true` 的消费者观察成功完成、至少 20 秒的独立
`sleep` / `Start-Sleep` 调用。如果当前 agent 可用 `job_output`，则通过
`registerSystemSection` 注册一段系统指导：**等待已有宿主 job 时**使用
`job_output({ wait: true })`，等待外部服务仍可合理使用延时。工具存在不代表 job 正在运行。

指导在下一次提示词装配时可见，不能影响同一 PTC 程序中已经运行的后续工具调用。
Native 与 PTC 共享执行后的观察点。不会拒绝、重复或改写 sleep，不改变工具结果或历史消息。
循环、复合命令、动态时长、短延时、失败/取消及后台/已提升结果均不触发。

首次符合条件的调用前，新增提示词字节为零。每个 agent/消费者生命周期只注册一段，
后续 sleep 不追加副本；消费者失去归属或缺少 `job_output` 时文本为空，消费者或 agent
释放时移除。`promptPolicy: false` 不安装观察器或提示段。不使用 batch tail、不伪造用户消息，
也不承诺模型一定停止 sleep。重载消费者会开始新的观察生命周期。
