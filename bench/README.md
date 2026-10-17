# bench

轻量、零依赖、自包含的测量工装:一套入口、两种测量模式、一份数据契约。它**只在仓库里跑** —— 不随
npm 包发布、不参与构建、不进 `verify:release` / `release.yml`,也从不成为默认门禁(设计议题 #205)。

本套收编了两份来源:**#103(@OldLigant)** 的无模型工具级确定性对比,和 **#183(@Richeir)** 的模型
驱动 token A/B 骨架;口径对齐 **#173** 的意图 —— 本地性能测量只作人类证据,不进 CI。归属记录见
`docs/CHANGELOG.md`。

## 三种入口形态

| 形态 | 命令 | 用途 |
| --- | --- | --- |
| 唯一跨平台入口 | `node bench/cli.mjs <command>` | 全部子命令: `setup \| ab \| report \| panel \| tools` |
| npm scripts | `npm run bench:ab` 等 | 日常使用;装包后 `bench/` 不存在,脚本给出明确报错而不是 ENOENT |
| 底层单脚本 | `node bench/setup.mjs` / `bench/compare.mjs` / `bench/report/panel.mjs` / `bench/tools/index.mjs` | 排障与单步重跑;`ab` 只是按顺序把 runner 与 compare 连起来 |

`node bench/cli.mjs --help` 列出全部子命令,`<command> --help` 给出该命令自己的旗标。任何路径都从
模块位置解析(在哪个工作目录下调用都一样),且**不经过 shell** —— `.cmd`/`.ps1` shim 无法被 Node 管道,
而 shell 会重新解释每个参数。

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 正常;或一个**弃权**的成本门(噪声底未知 ⇒ 不读方向) |
| `1` | 失败:`report` 的判决门失败 · `tools` 出现被接受状态之外的项 · `setup` 的某个检查或步骤失败 |
| `2` | 用法/输入错误:未知命令、未知旗标、缺值、越界参数;装包后缺 `bench/` 也走这里 |
| `3` | **已声明但尚未接线**:目标文件不存在,或存在但没导出 `main(argv, io)` —— 打印所属切片与目标路径,绝不静默成功 |

`report`(以及 `ab` 的最后一步)的退出码**就是裁决**:`1` 表示门禁失败;一个没能跑起来的成本门
(噪声底未知等)弃权并退 `0`。

## 两种测量模式(以及各自不该断言什么)

| 模式 | 入口 | 用模型 | 断言什么 | 不该断言什么 |
| --- | --- | --- | --- | --- |
| 成本 A/B | `bench ab` → `bench report` | 是 | **通过率先行**(任一任务 ✅→❌ 就是回归);只有**两侧都通过**的配对参与成本统计;方向必须超过 A/A 噪声底 | 时间;落在噪声带内的 Δ;没有噪声底时的任何方向 |
| 工具级确定性对比 | `bench tools` | 否 | 只有 `MATCH / EXPECTED_DIFFERENCE / EXPECTED_REJECTION` 算通过,其余状态(含 `MISMATCH` / `UNSTABLE`)都退 `1` | 时间;同二进制两侧的"提速";任何性能结论 |
| 本地性能(#173 的意图) | 各命令打印的 median | 否 | **什么都不裁决** —— median 只作人类证据 | 进 CI、进门禁、进任何性能回归判定 |

三者共同的一条:**永不裁决时间**。

### 成本 A/B 的口径

1. **通过率先行**:`--fail-on both`(默认)先判通过率,任一任务从 ✅ 变 ❌ 即失败;`--fail-on pass-drop`
   只判通过率,`regression` 只判 token,`none` 只出报告;
2. **配对**:按 `task × repeat` 配对;`--regression-scope task|total|both` 决定 token 回归判每个任务、
   判总量还是两者都判;`--tolerance-pct N`(默认 `2`)是回归容忍带;
3. **只有两侧都通过的配对参与成本统计** —— 一侧失败的配对连 token 一起被排除,并在报告里单列;
4. **A/A 噪声底**:没有噪声底时,所有成本方向弃权(`noise-floor-unknown`),报告只给测到的 Δ。

### 工具级确定性对比的口径

- `tools/measure.mjs` 的 `compare()` **判断顺序本身就是语义**:`TIMEOUT → ERROR → UNSTABLE →
  (!sameAsBaseline ? (expectedDifference ? EXPECTED_DIFFERENCE : MISMATCH)) → expectedError 命中 ?
  EXPECTED_REJECTION → (!eligible ? WORKER_ERROR) → MATCH`。其中"两侧返回同一个 error 信封"若不在
  任务里显式声明为 `expectedError`,必须落 `WORKER_ERROR`,**不能**当成 `MATCH`(否则一次崩溃会被报告成提速);
- `speedup` 只在 `MATCH` 且 candidate median > 0 时才有意义;任一轮超时或不稳定,整项不给方向;
- 夹具在**计时之外**用 `mkdtemp` 生成,跑完删除;删除**之前**先整树盘点,遇到不是自己创建的内容就报错并保留现场;
- 报告**独占创建**(`flag: 'wx'`):重跑不覆盖上一次的证据,而是退 `1` 并提示 `Refusing to overwrite`;
- 每次调用都显式带 `outputMode`(native 默认是 content):省略参数两侧就不可比。

## 子命令

| 子命令 | 目标 | 做什么 |
| --- | --- | --- |
| `setup` | `bench/setup.mjs` | 自检 + 幂等准备两侧 profile(`bench-base` / `bench-ops`),打印跑 sweep 的那一条命令 |
| `ab` | `bench/run.mjs` → `bench/compare.mjs` | 先基线、再候选、再比较,三步共用**一个** `bench/runs/benchmark-test-NN` 组目录 |
| `report` | `bench/compare.mjs` | 从已封存的 `run.json` 渲染 `report.md` |
| `panel` | `bench/report/panel.mjs` | 生成/打开一个只读 `run.json` 的 `panel.html` |
| `tools` | `bench/tools/index.mjs` | 无模型的工具级确定性对比 |

### `setup`

`--base-profile` / `--cand-profile` / `--template`(默认 `headless`),`--pin-shell <path>` / `--no-pin`,
`--permission-mode <mode>` / `--no-permission-mode`(`danger-full-access`(默认)/ `workspace-write` /
`read-only` / `none`),`--plugin <spec>`(`local` 默认装本 checkout 的本地构建 / npm spec / `none`),
`--reinstall`,`--dsh-home <dir>`,`--dsh <path>`,`--force`,`--dry-run`,`--no-build-check`。

顺序是故意的:先跑 preflight(权限组合、`PSModulePath`、本地构建),**检查失败就在碰 profile 之前拒绝**;
一套配置一旦会被写成"量的是权限模式"或"跑的是旧构建",改 profile 也修不好,只会在下一次运行里让报错更难读。
`--dry-run` 打印每一步写入与命令,什么也不改。

`setup` 会把 `bench/llm.patch.example.yml` 复制成 `bench/llm.patch.yml`(仅当后者不存在),之后的每次 dsh
调用都以 `--patch` 带上它;把服务器、模型 id 与 `apiKeyEnv` 填进副本即可,**密钥只放环境变量或
`~/.dsh/.credentials.yaml`,绝不写进这个文件**。副本是操作员的,存在就一字不改。

### `ab`

`--task <id>`(可重复)、`--repeat <N>`、`--folder <name>`、`--base <label>` / `--cand <label>`
(默认 `bench-base` / `bench-ops`)、`--show`,其余旗标原样交给 runner。

`--show` 打印将执行的三条命令并立刻退出(纯函数,不写任何东西、不跑任何会话)。组号在这里**只分配一次**:
如果每侧各自按时间戳分配目录,两侧会落进不同的组,最后什么都配对不上。

### `report`

两侧各自可以是 label(`bench/runs/*-<label>`,含一层组目录,最新时间戳优先)、一个 run 目录、或一个
`run.json` / 旧版 `summary.json` 路径。`--folder` 限定组,`--runs` 换根,`--aggregate median|min`,
`--json` 输出比较文档而不是报告,`--out <file>`(`-` 只到 stdout;默认 `<cand 目录>/report.md`)。

### `panel`

`panel --out <dir> <run.json>` 写 `panel.html`;`panel --serve <dir> [--port <n>]` 起一个零依赖
`node:http` 静态服务(只绑 `127.0.0.1`,默认端口 `0` 由系统分配)。只读:不发请求、不写 `~/.dsh`、
不常驻、不注册 DSH 插件。`file://` 双击时浏览器的 `fetch` 会被 CORS 拦下,页面用文件选择/拖拽回退。

### `tools`

`--baseline` / `--candidate`(两个 worker 可执行文件)、`--out`(报告路径,**必须不存在**)、
`--temp-dir`、`--scale`、`--timeout-ms`(这套旗标沿用 #103 的参数面,随接线片一并落地)。预热 1 次 +
5 轮交替配对,同二进制两侧时它只证明"harness 没坏、输出可重复",**不是**性能基准。

## 如何读 `report.md`

按这个顺序读,不要跳:

1. **结论**:结论条一行给通过率、配对 token Δ、噪声底、方向与门禁,顺序就是判决顺序;
2. **每任务配对**:`task | base | cand | Δ% | 配对/考虑 | 排除 | pass(base→cand) | 方向`;`TOTAL` 行后还有
   一行**几何均值 Δ**(每任务等权);
3. **被排除的配对(成本不统计)**:多少对因至少一侧未通过被排除,以及 base / cand / 两侧各占多少 ——
   通过率一变,这里就是成本口径的地基;
4. **A/A 噪声带**:半宽、区间、方法(`measured` 来自 `--noise`,或 `provided` 来自 `--noise-floor-pct`)、
   配对数与任务样本;未知时这一段直接说明"方向一律弃权";
5. **token 归因(诊断,不改判决)** 与 **每任务 bucket 明细** / **usage 拆分** / **工具调用**:都是诊断,
   把 Δ 拆成固定开销 / 额外步数 / 残差,或按 input / output / cacheRead 分桶;
6. **警告**与**证据**:前者列出无法支撑结论的行(如某侧丢了 `step_end.usage`),后者给出 `run.json` 与
   归档路径。

## 面板怎么读(五个标签)

| 标签 | 内容 |
| --- | --- |
| 概览 | 结论条 + 每任务配对表 + 噪声带 + token 归因 |
| 对话 | 左 base / 右 cand 同任务同 repeat 并排,标出首个分歧点 |
| 轨迹 | 时间线:`tool_call` / `tool_result` / 里程碑 / 心跳 / stall |
| 判卷 | verifier 明细:检查项 / 期望 / 实际 / 证据路径 |
| 原始 JSON | 只读视图 + 复制 + 下载 |

页面**从不内联数据**:它只带数据文件的*名字*,在查看时 `fetch` 同目录的 JSON;每个值都用 `textContent`
写入,所以 transcript 里的 `<script>` 会被显示而不是解析,勾选「纯文本模式」可把任何标签降级成纯文本。
面板只认 `schemaVersion 1`,遇到未知版本直接拒绝而不是猜。

## A/A 噪声底、配对口径与"永不裁决时间"

- A/A 噪声底是"基线与自身对照"得到的区间。**默认未知** ⇒ 成本门弃权,报告只给 Δ、不给方向;
- 要给噪声底,二选一:`--noise-floor-pct N`(固定一个已测量的半宽)或 `--noise <base> <cand>`
  (用两次基线运行现测);
- 成本**只统计两侧都通过的配对**:一侧通过、另一侧失败的配对既不能证明变快也不能证明变慢;
- 任何模式都**不裁决时间**:共享 runner 上的时间不可比,时序只打印、只作人类证据。

## 任务编写语义

任务文件是 `bench/tasks/*.task.json`,字段白名单是 `id` / `title` / `prompt` / `fixture` / `verify` /
`repeat` / `timeoutMs`(多一个字段就是拼写错误,直接报错并点名文件与字段)。`prompt` 是模型唯一看到的东西,
不能以 `-` 开头(headless launcher 会把它当选项)、不能以空白开头、不能含 NUL;`timeoutMs` 默认 900000
(15 min),合法区间 `1000 .. 86400000`;`repeat` 是每任务预算,`1 .. 100`,runner 的 `--repeat N` 仍可覆盖。

判卷(`lib/verify.mjs`)里几个容易写错的语义:

- `fileEquals` **两侧都 `trim()`**(行尾换行不算差异);`fileLines` 逐行 `trim()` 且丢掉空行、折叠 CRLF;
- `countFiles` **递归**计数,可按 `prefix` / `suffix` / `extension` 过滤;
- `contentHashes` **只看直接子项**(不递归),逐个比对名字与原字节的 sha256,并拒绝任何多出来的文件;
  它是"改名而不是重写"的判据 —— 删掉重建或截断再写能骗过 `countFiles`,骗不过它;
- `expect` 命名的是 fixture 导出的期望值;键写错会直接抛 `fixture exports have no key "..." (known: ...)`,
  不是静默失败;
- `fileContains` 对**空文件恒失败**(`actual !== ''` 是前置条件),即"读不到内容"不等于"包含"。

## 两套语料的分工

| 语料 | 位置 | 产出 | 谁用 |
| --- | --- | --- | --- |
| 模型任务语料 | `bench/lib/fixtures/**`(`csv` / `log` / `tree` / `symbol` / `corpus` / `deep` / `repair`) | 每个生成器建一个任务工作区,并以 `derive*` 重新算出期望值 | `bench ab`(模型驱动) |
| 工具级尺寸边界语料 | `bench/tools/index.mjs`(`createToolFixtures`,`SEED = 870016`) | 固定尺寸边界:`33 MiB` 拒绝、`8 MiB` hex 窗口、`1 MiB` 行边界 | `bench tools`(无模型) |

两套不要混:`tools/` 的语料靠着它喂养的那次运行,`lib/fixtures/**` 是另一个目录,产出的是任务工作区。
`--scale` 只缩放**文件数**(small / deep / dense),尺寸边界永远保留,所以 `--scale 0.01` 仍能冒烟到每一条边界。
真要搬家,必须保持 `SEED` 与五个夹具族逐字节不变,否则比较就丢了基线。

## run.json 契约

`runs/<stamp>-<label>/run.json` 是**唯一数据源**:写入期事件追加为 NDJSON(崩溃安全),封存时归并
进它,面板/报告/比较都读它,不额外落 CSV 或散文件。本表被 `test/bench-cli.test.mjs` 交叉校验。

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 契约版本号,`1`;读者遇到未知版本必须拒绝 |
| `meta` | 采集环境事实:harness 版本、模式、平台、node、dsh、模型、git sha/branch、命令行、起止时间,以及两侧 arm 的标签与 profile 指纹 |
| `arms` | 两侧 arm 的完整描述:label、profile、profileHash(单变量校验的指纹)、dsh 路径/版本、环境覆盖 |
| `results` | 每 `task`×`repeat`×`arm` 一行:该行 metrics(exit / steps / toolCalls / durationMs / usage 分桶)、verify 逐检查项、events 引用 |
| `verify` | 全量检查项汇总:checks / passed / failed / degraded(是否出现无法支撑成本结论的行)、notes |
| `events` | 事件归档方式:写入期 NDJSON、封存时归并;含文件清单、事件数、哈希与合并时间 |
| `archive` | 归档清单:每个文件的相对路径、字节数、sha256 与 role |

三条数据纪律(硬边界 #205 §1):

1. **数据只存 JSON**:原始数据只落 `run.json`,不内联、不额外落 CSV/散文件;
2. **轨迹落独立文件**:事件与 stderr 是 `results/<task>-r<n>.events.ndjson`、`.stderr.ndjson`,
   轨迹是独立的 `results/<task>-r<n>.trace.ndjson`,只在 `archive[]` 里登记 —— 它们不进 `run.json` 的正文;
3. **HTML 不内联数据**:`panel.html` 只是"读同目录 JSON 的查看器"。

## 有界兜底(P7)

单发会话的两道超时都是有界的,坏掉的子进程不会把 sweep 挂死:`spawnErrorGraceMs` 默认 `1000`(spawn 立刻
失败时,等 1 s 让 close 事件落地再结算,而不是把"没有 pid"当成没跑过);`killGraceMs` 默认 `5000`(kill 之后
最多等 5 s 收尸,超时就从已归档的文件里记录这一行)。两者都可被调用方覆盖。

## 状态名对照

本议题 #205 曾把工具级对比的不匹配写作 `UNEXPECTED_DIFFERENCE`,代码里的名字是 **`MISMATCH`**。完整集合:
`MATCH` / `MISMATCH` / `EXPECTED_DIFFERENCE` / `EXPECTED_REJECTION` / `UNSTABLE` / `TIMEOUT` / `ERROR` /
`WORKER_ERROR`;只有 `MATCH`、`EXPECTED_DIFFERENCE`、`EXPECTED_REJECTION` 是"预期结果",其余都退 `1`。

## CI 里怎么跑

- **默认不跑**:`push` / `pull_request` / `merge_group` 里没有 `workflow_dispatch` 的 `inputs`,bench 作业
  整段跳过,这些运行逐字节不变;
- **opt-in**:手动触发时给一个布尔输入 `bench`(默认 `false`)才跑 `bench-smoke`;
- **同二进制两侧**:CI 跑的是 `bench/cli.mjs tools --scale 0.01`(保留全部尺寸边界),两侧同一个二进制,
  所以绿只说明"harness 还能驱动真实 worker、worker 两次答得一样",**不构成任何性能结论**;
- **不阻塞**:该作业 `continue-on-error: true`,不进必需状态检查,聚合门禁不计它;
- **artifact**:证据以 `bench-smoke-report` 上传(沿用 `tools-trial-report` 的命名),含 `bench/runs/smoke/**`
  以及存在时的 `run.json` / `report.md` / `panel.html`;
- **模型驱动的 sweep 绝不在 CI 跑**:它要断言成本方向,那是本地的人类判断。

## 为什么 bench 不随包发布

硬边界(设计议题 #205):**数据只存 JSON**、**HTML 只是读 JSON 的查看器**、**测试期可用但构建期不
构建**。因此 `files` 不含 `bench/`,也不新增构建步骤;装包之后 `npm run bench:*` 会先检查 `bench/`,
不存在就打印 "bench 只存在于仓库,不随包发布" 并以退出码 `2` 结束。

## 接线现状

声明了但没接线的子命令**从不静默**:目标文件不存在,或存在但没导出 `main(argv, io)`,都以退出码 `3`
点名所属切片与目标路径。因此切片可以一个一个并入,而 CLI 的 tripwire 始终说真话:

- `setup` / `report` / `panel` / `tools` 已接线,`--help` 退 `0`;
- `ab` 已接线:整次 sweep 在**一个**子进程内完成,两臂按 `(task, repeat)` 的奇偶 **AB/BA 交错**
  (奇数轮 base→cand,偶数轮 cand→base);`--show` 只打印逐对计划,不 spawn 任何会话;
- 目前只剩"声明了但目标文件还没落地"这一种 pending 形态,它退 `3` 并点名切片与目标路径 ——
  切片一个一个并入时,这条 tripwire 始终说真话。
