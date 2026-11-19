# Flash 小规模对照（V5）

[English](flash-comparison-v5.md) | 中文

议题 [#994](https://github.com/T-Auto/dsh-ops/issues/994)，父单 [#980](https://github.com/T-Auto/dsh-ops/issues/980)。这是一张测量卡：
仓库仅新增测量驱动、采集器、本对报告与 changelog 条目；不改产品代码语义、不改教学文案、不改发布逻辑。

## 预注册的问题

V5 卡要回答：按需披露档的**更短首轮提示**是否换来**更多调用或更多失败**。两臂只差一个预注册因素——
`dsh-ops` 行的 `disclosurePolicy`（`on-demand` vs `full`，由 #986/#987 实现）——其余全部冻结：

- 路由：`opencode-go` / `deepseek-v4.1-flash`，`reasoningEffort: high`
- 预设：`ops-ptc`（组合组自证；若实际落到 Standard，按 #980 判无效）
- 沙箱：`danger-full-access`；平台：`linux-x64`
- 任务：`ptc-catalog-recover`（目录搜索，需要可加载的 `ops_grep`）与 `ptc-wait-dispatch`
  （多层配置编辑，需要 `ops_read_files`/`ops_edit_file`）——四条 V4 轨道里工作集对档位最敏感的两条
- 计划：2 任务 × 3 重复 × 2 臂，按 (任务, 重复) AB/BA 交错，共 12 会话；另跑同条件 A/A
  （12 会话，按需配置跑两臂）估计噪声底；每会话使用全新播种工作区与全新组合组

## 为什么是驱动器而不是 `bench ab`

宿主的一次性 headless runner 只组合 host realm，并**按设计拒绝 preset 会话**（其收养检查原话：
*"session … runs under agent preset …, which the one-shot runner does not compose"*）。而插件对无注册表的
host realm 按 Standard 处理，所以 `ab` 实测的是 Standard，按 #980 判无效。`bench/v5-run.mjs` 复用 V1
隔离入口组合（真实 AgentLoop、真实 PTC executor、真实 staged worker、正式 `dsh-ops` 行），只把脚本化
provider 换成真实 `llm-pi-ai` 适配器。一个解析细节：运行时把 `@deepseek-ai/dsh-llm-pi-ai`（连同
`@deepseek-ai/dsh-credentials`，以及 `@earendil-works/pi-ai` 的符号链接）复制进 `node_modules`，
使全部 import 经本检出树解析、整个组合共享同一个 `cordis` 实例；`node_modules` 被 gitignore，
manifest 不变。每会话落盘：原始事件（`*.events.ndjson`）、可判定轨迹（`*.trajectory.json`）、
折叠指标（`*.metrics.json`）、经验证的答案，以及每臂 `arms/<arm>/dump-config.txt`。

## 环境事实（记录而非声称）

| 事实 | 值 |
| --- | --- |
| 插件 commit | `card/v5-flash-comparison` 上 `28c0cf7` = `main@58f6e28` + 已过审前置合并（V1 入口与 V4 轨道 `card/v4-bench-tasks`@`ec4d25c`；被测 D2/D3 披露实现 `card/v3-two-tier-matrix`@`c68fe3d`） |
| 宿主版本 | 0.2.2-rc.1 |
| 平台 | linux-x64，node v24.21.0 |
| worker | staged `runtime/linux-x64/dsh-ops-worker`，sha256 `2b5f988d9115…` |
| 预设 / 路由 | `ops-ptc`；`{provider: opencode-go, model: deepseek-v4.1-flash, reasoningEffort: high}` |
| 沙箱 | danger-full-access、approval never（组合组内钉住模式；未挂审批服务，工具失败为返回值） |

每臂证据：`bench/runs/v5-comparison/arms/{ondemand,full}/dump-config.txt` 与
`bench/runs/v5-aa/arms/{aa-one,aa-two}/dump-config.txt`——除一行 `disclosurePolicy` 外逐字相同。

## 完整分母

| sweep | 计划 | 完成 | 超时 | 缺 usage | 验证通过 |
| --- | --- | --- | --- | --- | --- |
| 对照（按需 vs 全量） | 12 | 12 | 0 | 0 | 11 |
| A/A（按需跑两臂） | 12 | 12 | 0 | 0 | 12 |
| **合计** | **24** | **24** | **0** | **0** | **23** |

一个对照会话未通过工作区验证：按需臂 `ptc-wait-dispatch` r2 写了 `config/development.json`（选错了
配置层）；会话本身正常完成，因此同时留在完成率与通过率分母里。没有会话超时；每会话每步都报了
usage，下表没有任何下界问题。正式跑前先做了 2 会话冒烟（`bench/runs/v5-smoke`）验证路由与 usage
采集，冒烟不在预注册分母内。

## 按任务结果

提示规模为每次模型请求的 token（input + cacheRead + cacheWrite）；总量为单会话全部步之和，取臂内三会话中位数。

### ptc-catalog-recover

| 指标 | 按需 | 全量 | A/A 带宽（同配置两臂） |
| --- | --- | --- | --- |
| 验证通过 | 3/3 | 3/3 | 3/3 – 3/3 |
| 正确下一步 | 26 | 17 | 23 – 24 |
| 纠偏机会 | 3 | 0 | 0 – 1 |
| 无进展重试 | 5 | 4 | 5 – 7 |
| 等待 | 0 | 0 | 0 |
| 首轮提示（中位） | 5,271 | 29,946 | 5,271 – 5,271 |
| 提示总量（中位） | 86,136 | 185,465 | 66,881 – 88,078 |
| input tokens（3 会话） | 65,035 | 68,051 | 55,814 – 57,644 |
| cacheRead tokens（3 会话） | 182,656 | 430,848 | 144,896 – 198,016 |

### ptc-wait-dispatch

| 指标 | 按需 | 全量 | A/A 带宽 |
| --- | --- | --- | --- |
| 验证通过 | 2/3 | 3/3 | 3/3 – 3/3 |
| 正确下一步 | 8 | 8 | 14 – 27 |
| 纠偏机会 | 1 | 2 | 4 – 6 |
| 无进展重试 | 7 | 6 | 7 – 9 |
| 等待 | 0 | 0 | 0 |
| 首轮提示（中位） | 5,306 | 29,981 | 5,306 – 5,306 |
| 提示总量（中位） | 137,419 | 236,416 | 85,813 – 103,238 |
| input tokens（3 会话） | 117,307 | 106,664 | 65,094 – 125,645 |
| cacheRead tokens（3 会话） | 278,784 | 597,248 | 203,776 – 244,736 |

### 首轮与加载后的差值

`#994` 第 3 步要求列首轮与加载后的差值。按需臂每会话在第一个程序里完成一次 `ops_load_sdk`，
下一个请求因新加载的 SDK 声明加历史而增长：

| 任务 | 首轮（中位） | 加载完成后的首个请求（中位） |
| --- | --- | --- |
| ptc-catalog-recover | 5,271 | 12,820 |
| ptc-wait-dispatch | 5,306 | 15,574 |

全量臂按设计没有加载步；首轮即携带整个获准池（29,946 / 29,981 tokens）。A/A 两臂复现按需臂数值
（12,733–12,786 / 15,437–15,568），这同时也是采集路径的一致性检查。

### Cache usage

每步都报了 usage 对象；每步都有 `cacheReadTokens`，`cacheWriteTokens` 全程为 0（provider 用缓存服务了
重复的前缀）。缺 usage 行：0。尽管 `reasoningEffort: high`，`reasoningTokens` 每步都为 0——按原样记录，
不做重新解读。

## 噪声判定

- **未能区分（落在 A/A 噪声内）：** `ptc-wait-dispatch` 的验证通过差（2/3 vs 3/3，A/A 带 3/3–3/3，
  即 n=3 下的单次失败；该失败是选错配置层的推理失误，与档位无交互）；两任务的无进展重试
  （5 vs 4、7 vs 6，带宽 5–7 与 7–9）；`ptc-wait-dispatch` 的纠偏机会（1 vs 2，带宽 4–6，两臂都低于
  A/A 离散本身）；两任务的裸 input tokens（仅 `ptc-wait-dispatch` 的 A/A 带就跨 65k–126k）。
- **超出 A/A 带，但属机械差异，不作模型质量归因：** 首轮提示（5.3k vs 30.0k，带 5.3k–5.3k）与提示
  总量（86k vs 185k、137k vs 236k，带宽 67k–88k 与 86k–103k）——这是披露档自身的声明成本，输入侧
  事实而非行为差异；cacheRead 随之（两任务皆 2.4×）。目录任务的纠偏机会（3 vs 0，带 0–1）是按需
  loader 每会话恰好邀请一次可恢复的输入错误（首次 `ops_load_sdk` 名字非法）——三次全部恢复并通过，
  恢复率 3/3，与从未获得机会的全量臂不可区分。目录任务的正确下一步计数（26 vs 17，带 23–24）包含
  仅存在于按需臂的加载步与恢复步，因此如实报告、不作归因。
- **不声称档位带来成功率提升。** 每臂每任务 n=3，任何行为侧差异都没有超出 A/A 带所能覆盖的范围。

## 复跑

```console
npm run build && npm run build:ptc
# 对照 sweep：2 任务 × 3 重复 × 2 臂，AB/BA 交错
node bench/v5-run.mjs --task ptc-catalog-recover --task ptc-wait-dispatch --repeat 3 \
  --out bench/runs/v5-comparison --dsh-home <.credentials.yaml 内含 OPENCODE_GO_API_KEY 的 home>
# A/A 噪声 sweep：同计划，两臂都用按需配置
node bench/v5-run.mjs --task ptc-catalog-recover --task ptc-wait-dispatch --repeat 3 --aa \
  --out bench/runs/v5-aa --dsh-home <同一 home>
# 判定与表格
node bench/v5-collect.mjs --run bench/runs/v5-comparison --run bench/runs/v5-aa
```

本报告运行的产物在 `bench/runs/v5-comparison` 与 `bench/runs/v5-aa`（`summary.json`、逐会话 `results/*`、
每臂 `dump-config.txt`），冒烟在 `bench/runs/v5-smoke`。判定器逐字复用 V4 共享规则
（`bench/lib/tracks.mjs` 的 `scanReissues`、`countOpportunities`）与两条可泛化的任务规则（分页游标、
等待/派发）。两条剧本专属规则——目录轨道的"必须先犯错"与加载轨道的"必须先撞未加载拒绝"——有意
不对真实运行生效：从不犯错的模型不应被判为演砸剧本。

## 局限

- 每臂每任务 n=3：#994 规定的试点规模。A/A 带展示了该 n 下噪声底有多宽；本报告不支持任何成功率结论。
- 组合组是 V1 隔离入口，比 web profile 的完整 `ops-ptc` 预设精简（无 persona、time-context、Bash 行）。
  两臂共享精简组合，档位对比内部有效；绝对 token 数描述的是隔离组合，不是 web profile。
- 单机、单日、单模型：AB/BA 交错缓解漂移，不消除漂移。
- 判定器的目录"正确下一步"定义把完成的 `ops_load_sdk` 计为按需臂的正确一步；该列跨臂比较含结构性
  成分（上文已注明）。
- 驱动器在运行时把 `dsh-llm-pi-ai` vendor 进 `node_modules`，因为仓库 manifest 有意不依赖任何 LLM
  适配器；该拷贝被 gitignore，并在此处记录。
