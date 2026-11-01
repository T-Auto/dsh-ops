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
// Optional early withdrawal; plugin/Agent teardown also releases both.
removeTail()
removeSection()
```

两个函数均返回可重复调用的 `() => void`。同一目标 agent、同一贡献种类的 id 必须唯一（包括不同 owner 插件之间）；重复会抛错。替换 revision 前先释放旧注册。priority 默认为零，必须是有限值，按升序排列，同值按 id 的 code-unit 顺序排列。id 与 revision 必须非空。revision 是不可变的注册元数据，不会自动触发缓存失效。释放时正在计算的尾部会被撤回，替代注册从下一个被接纳 batch 起生效。

系统段落 text 也可为同步 `(context: AssembleContext) => string`；只能使用当前组装的 signal，不能用其控制后续 turn。尾部 `provide` 返回 `string | undefined` 或对应 Promise；`''` 和 `undefined` 不产生消息。输入 messages 是深度冻结的独立快照，不是可写 inbox 视图。signal 在 admission 取消或 provider 移除时结束，provider 应配合取消。异常包装为带 id、revision、cause 的 `PromptProviderError`，可在正常 `agent/error` 中观察；不会隐藏重试。

系统段落注册要求 `systemPrompt` 服务已经可用。这些函数不会挂载组件、注册工具、更改权限或安装进程全局 provider。complete 系统提示词只抑制额外系统段落，不抑制独立注册且写日志的 batch 尾部。其它插件的协作 pre-step hook 也可能转换 batch；此接口保证本 hook 处已接纳 batch 的尾部，而不是 provider wire 归一化或所有下游 hook 之后的位置。

已使用安装的 `0.2.0-rc.2` 宿主真实 AgentLoop 与假 LLM capture 验证。`0.2.1-rc.2` 参考源码具有相同公开 pre-step admission 契约；本 slice 只读了该版本，未安装或执行它。

## 已接纳步骤尾部

`registerStepTailProvider(owner, agent, options)` 仅在宿主 `agent/pre-step` waterfall 返回 `enter` 且决定包含非空用户消息 batch 时运行 provider。provider 收到冻结的只读快照、agent、turn、step 与本次 admission signal。结果按 priority 和 id 排序，并作为带插件归属的 `UserMessage` 追加到已接纳 batch 尾部。

这是会写入 session 日志的历史，不是临时 request overlay、system-role 尾部、伪造的用户授权，也不是保证每次模型请求都运行的 hook。空 batch（包括纯工具续步与 turn-closing 探针）不会调用 provider，也不能借此唤醒 loop。空结果不创建消息。provider 拒绝会沿宿主正常错误路径中止 admission；取消不会提交。模型重试复用同一批已接纳消息，不会重复追加。

source kind 为 `dsh-ops:step-tail`，并携带 contributor、revision、turn、step 元数据以支持归属与回放。
