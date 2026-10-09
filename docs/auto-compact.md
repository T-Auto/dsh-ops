# 上下文自动压缩 / Automatic context compaction

## 界面位置

本地开发版在 **插件列表 → dsh-ops → 包含的组件** 中新增第四项「上下文自动压缩」
（`dsh-ops-auto-compact` / `@dsh-ops/auto-compact`）。使用它旁边的配置入口进入设置，
不是全局设置中的独立页面。新组件默认启用；原有 background 仍默认停用。
`0.2.5-beta.1` 是待发布测试版候选；正式版 npm 0.2.4 不含此功能。是否发布以 registry 为准。

| 配置 | 默认 | 范围 |
| --- | --- | --- |
| `thresholdPercent` | 50 | 1–99，整数 |
| `cooldownSeconds` | 120 | 30–3600，整数 |
| `timeoutSeconds` | 120 | 10–600，整数 |

设置调用现有宿主表单的 revision-fenced mutate，保存到当前 profile 的
`cordis.patch.yml`，可恢复默认，不使用 localStorage。启用组件且当前客户端具有
宿主设置权限时才可保存；停用组件不伪装成可配置。修改即时影响下一次判定，
不重挂载或中断正在运行的压缩；压缩已经开始时沿用当次捕获的截止时间。

## 触发与安全

- 使用与 Web 一致的 `contextPressure` 投影：`projectedTokens ?? pressureTokens`，
  除以 `contextWindow`，四舍五入并上限 100。显示值 **严格高于** 阈值才满足条件；
  等于 50% 不触发。无样本或容量、异常值时跳过，不猜模型容量。
- 不按计时器轮询。正常 turn 进入 idle 时判定，热启用时检查已加载的 idle agent。
  用户取消的 turn 不自动启动维护。长时间持续运行的 turn 不会在中途压缩；
  原有宿主 pressure/overflow 自动策略保持不动。
- 调用宿主 `/compact` 同一个 `compaction.compactNow(agent, signal)` 服务，不向
  模型发送 `/compact` 文本，不增加模型可调用工具或额外提示词。
- idle 状态本身不构成互斥：由宿主 runMaintenance admission 和 durable compaction
  marker 执行真实串行化；busy 是正常竞态，跳过而非循环重试。
- 一个组件实例同时只运行一个压缩，跨会话共享冷却期；不干扰宿主自己的压缩器。
  同一 surface 在没有新内容/阈值改变时不重复尝试，自己的摘要替换也不会形成循环。
  无可压缩历史、失败都受冷却和 surface 门禁控制；无定时后台重试。
- commit/persistence 故障会暂停该会话的本组件自动压缩，直到重新加载组件。
  应先检查会话状态，不直接重试。其它故障只记录固定脱敏消息。
- deadline 是 AbortSignal 取消，不是强制销毁：依赖宿主/模型适配器响应 abort。
  即使适配器延迟退出，本组件也不开放第二个任务；关闭组件会 abort 自己的压缩并
  await allSettled，不调用 agent.cancel，不丢用户 inbox，不杀后台任务。
- 摘要使用宿主配置的模型，可能产生调用费用；摘要会改变 model-visible surface，
  原始历史/标记与持久化由宿主负责。压缩不是无损保证，不宣称百分比是未来 provider
  请求的精确计费。文档与截图不能替代真实 Desktop 验收。

## English

The fourth component is in **Plugins → dsh-ops → Included components**. Its row
configuration page uses the existing host forms, revision-fenced profile writes,
and restore-default operations. The new component defaults to ON; background stays OFF.
Only integer settings in the table above are accepted. This feature belongs to the
0.2.5-beta.1 prerelease candidate, not npm 0.2.4. Check the registry for publication status.

The policy matches the rounded Web context meter and requires a value strictly
above the threshold. It calls the same public idle-maintenance service as `/compact`
after a non-cancelled turn, never during active tools. Missing samples skip work.
No model-callable tool, polling, invented model capacity, host policy mutation, or
shared registry rewrite is involved. One owned operation, global cooldown,
unchanged-surface suppression, abort/drain teardown, and commit/save-failure session
suspension bound work. New user messages are queued by the host's maintenance seam.
A timeout requests cooperative cancellation, not forced quiescence. Summarization
may incur model cost and is not guaranteed lossless.

## 内部分发

宿主 Web module discovery 只接受 package-root row，不接受 `dsh-ops/*` 子入口。
因此此组件是 `packages/auto-compact/` 内的伴随包，声明 file dependency 并通过
`bundleDependencies` 随主包携带，无单独 npm 发布或安装要求。旧三入口不变，列表
仍为四组件。宿主从所选 bundle 的 dependency closure 解析这个嵌套依赖。
`npm pack` 后在隔离目录离线安装，已从主包锚点确认宿主入口/浏览器入口可解析；
从 consumer 根直接 import 嵌套伴随包失败是预期的 npm 非提升布局，不假称根可解析。

## 验证记录

Target: DSH 0.2.0-rc.2. Runtime packages and vendored Rust are unchanged.

```console
node test/run.mjs auto-compact
node --check packages/auto-compact/lib/client.js
node --check packages/auto-compact/lib/index.js
git diff --check
```

Targeted regressions cover schema rehydration with the real host library, real
Cordis mounting/live update/unloading, strict bounds and occupancy, cancellation,
serialization, no-op/self-replacement suppression, deadline/drain, errors and row
registration. The compaction backend and browser rendering are test seams, not a
real provider-backed Desktop E2E. Manual acceptance still required:

1. Install a local development artifact in an isolated profile, reload the app,
   confirm four components and this row's configuration control.
2. Save 60%, reload page/app, confirm profile persistence; restore 50%.
3. Grow a conversation past the threshold, confirm one compaction after idle;
   inspect its durable marker and summary; queue input during compaction.
4. Cancel a turn: no fresh automatic compaction. Disable during a summary: owned
   abort/drain, no user/tool cancellation. Existing tools and background remain live.
5. Missing model capacity, busy/manual compaction, provider failure and persistence
   failure: no spin/no duplicate summary; inspect warnings and original session log.

Full historical `npm run verify` is currently blocked by a pre-existing SVG-only
icon expectation while the package intentionally ships PNG. Running the old suites
also reveals earlier ladder/tool/metadata expectations incompatible with 0.2.4;
no unrelated legacy migration is included in this change.
