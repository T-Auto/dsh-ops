# Native 输出与工具名称审计

English: [Native output](native-output.md).

本审计针对直接 Native 调用，不以 `run_code` SDK 调用作证。Native 渲染不改 canonical
值、PTC 数据、revision、引用、权限或搜索排序，也不增加工具、别名、schema 或提示词节。

## 重复事实

搜索的 `complete` 表示整个查询已经读完，`pageComplete` 表示请求页已完整捕获，
`scanComplete` 表示遍历完整结束。显示截断又是独立事实。即使布尔值相同也分别保留。

- glob/grep 的旧字段 `matched` 是 `matchedObserved` 的别名，保留后者。
  `matchedObserved` 与 `matchedTotal` 的已观察数量／完整扫描总量含义仍明确区分。
- 仅 glob 完整扫描后的 `total` 与 `matchedTotal` 重复。grep 的 `total` 统计输出行，
  即使恰好等于匹配数也保留。
- `skippedFiles` 仅在扫描诊断中出现一次；skipReasons、continuation、nextOffset、
  omitted 和恢复建议均保留。
- 只省略成功 glob/grep 的精确 `changed=0`。失败、unknown effect、修改回执和非零值
  仍保留相应事实。
- 文本检查的 `Lines first-last of total` 标题已经表达总行数，因此省略重复的
  `lineCount` 和与其相等的 `total` 摘要。Hex 标题没有总行数，保留相关摘要。
- 失败搜索仍在错误／副作用指引旁展示已观察路径和扫描诊断，不将它们当作修改回执。

`test/native-summary.test.mjs` 使用相同 canonical fixtures，与 `77cd34f9` 的 UTF-8
文本字节数对照；以下仅是输出大小，不代表 token 或任务收益：

| Fixture | 之前 | 之后 |
| --- | ---: | ---: |
| 空 glob | 264 | 218 |
| 两条 glob 路径 | 280 | 234 |
| glob 分页 | 298 | 252 |
| glob 扫描缺口 | 317 | 290 |
| 短文本检查 | 194 | 172 |
| 空文本检查 | 196 | 174 |
| 文本检查分页 | 203 | 181 |

测试还覆盖独立 grep 总数、hex、不一致计数、扫描早停、显示截断、stale 失败和
unknown effect，并断言渲染不修改 canonical 输入。

## 工具名称与剩余宿主依赖

OPS 路由已经使用 `publicToolName()`，并按当前步骤实际准入的定义过滤名称。
`test/native-guidance.test.mjs` 在组装的 Native 请求上核验明确的调用目标，覆盖
替代就绪、隐藏开关、动态选择、切模式和卸载。

精确指令 “Use the read tool” 来自固定宿主包 `@deepseek-ai/dsh-tool-fs` 0.2.2-rc.1：
`lib/index.js` 中的 `applyReadTool()` 注册 `tool:read` 提示词节。回调使用
`ctx.tools.get("read", scope)`，没有传当前步骤的 `toolSet`。因此条件回退定义仍可在
注册表中存在，而实际 Native 请求只准入 `ops_inspect_local_file`。测试通过真实宿主
插件复现该不一致，并记录提示词节归属。让宿主回调遵守当前步骤准入仍是 #866 的宿主
依赖。OPS 不重写第三方提示词、不修改共享注册表，也不增加常驻名称对照提示词。
