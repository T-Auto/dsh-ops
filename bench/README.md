# dsh-ops A/B Token Benchmark

同一套任务、同一个模型，分别在没有插件的非常干净的 **基线 profile**（`bench-base`）和装了 本地 dsh-ops 编译插件 的
**候选 profile**（`bench-ops`）下各跑一遍，比较 token 消耗、步数、工具调用和通过率。

根据 Benchmark 结果来进行代码调优！这就是 Benchmark 存在的意义！

任务语料在 `bench/tasks/`，结果落在 `bench/runs/`。

## 1. 前置条件

- Windows + `cmd.exe`（入口是 `bench\platform\win-ab.bat`）。
- `node` 满足 `engines`；`@deepseek-ai/dsh` 已全局安装；`pnpm` 在 PATH 上（`dsh plugin` 透传它）。
- 服务器和模型填在 `bench/llm.patch.yml`（不存在时 `bench:setup` 会从 example 复制一份），
  API key 需要在 `.dsh/.credentials.yaml` 设置好对应的环境变量（如 `BENCH_SERVER_API_KEY`），然后把名称写在 `apiKeyEnv` 后面几即可。
- 别在 PowerShell 7 里跑：它把 pwsh 7 的模块根排在 Windows PowerShell 前面，候选侧的调用会死在
  `Get-Acl` 上；`cmd.exe` 没有这个问题。

## 2. 两条命令

```console
npm run bench:setup       :: 一次性准备，幂等，可以反复跑
npm run bench:baseline    :: 全量 A/B：base 跑一遍、ops 跑一遍、再出对比报告
```

### `npm run bench:setup`

建两个 profile、钉基线的 PowerShell 5.1、两侧钉 `danger-full-access`、把**本仓库 checkout** 装进候选、
检查本地 build、缺 `llm.patch.yml` 时从模板复制。`--dry-run` 只看计划，不改任何文件。

为什么是这些口径：

- **基线钉 5.1**：不钉的话 PATH 上的 Store `pwsh` 会让基线也跑 PowerShell 7，"原装 Windows"就没量到。
- **两侧钉 `danger-full-access`**：`workspace-write` 下候选侧 `ops_replace` 会 `ACCESS_DENIED`，量到的是退路。
- **候选装本地 checkout**：量的是这棵树；候选里是别的版本时脚本会报错让你 `--reinstall`。
- **查本地 build**：`runtime/<target>` 的 worker / Bash IPC 代理缺了只有候选侧会死，看起来像插件回归。

### `npm run bench:baseline`

依次执行 base、ops、compare，退出码就是 compare 门禁的结果（0 = 过，非 0 = 回归或通过率下降）；
任一侧跑失败会立刻停下并指明是哪一侧。不传 `--folder` 时自动分配 `bench/runs/benchmark-test-NN`，
三条命令共用同一个组。

参数写在 `--` 后面，例如：

```console
npm run bench:baseline -- --show                      :: 只打印工作组和三条命令，不跑
npm run bench:baseline -- --task csv-sum --repeat 1   :: 先冒烟一个任务
npm run bench:baseline -- --folder ops-0.3.1 --verbose
```

`--task` 可重复；`--repeat N` 覆盖任务自带预算；`--base` / `--cand` 换 profile 名；
其余参数（`--timeout`、`--no-probe-endpoint` …）原样转给 `bench/run.mjs`。

## 3. 测试用例：六个任务各测什么

模型进门只看到一句英文 prompt 和一个由 fixture 现场生成的临时 workspace；下表是
`bench/tasks/*.task.json` 的现状，期望值全部由生成字节推导，模型看不到。

| 任务 | workspace 里有什么 | 模型要干什么 | 考什么 | 怎么判卷 |
|---|---|---|---|---|
| **csv-sum** | 8000 行 `data.csv`（`id,region,amount`，约 112KB） | 算出 `region=EU` 的 `amount` 总和，把纯整数写进 `answer.txt` | 是整读进上下文再心算，还是一条聚合命令就地求和（标题里的 "without drowning the context"） | `fileEquals`：与生成器边写边累加出的精确值比对 |
| **config-hunt** | 三层配置 JSON + 12 个包（每个包带一个**不参与合并**的 `config.json` 诱饵）+ 写明合并顺序的 `README.md`，四个文件的同一个 key 值互不相同 | 按 README 的顺序求出 production 下 `MAX_UPLOAD_MB` 的生效值，只把这个整数写进 `answer.txt` | "grep 到第一个数就交差"vs 读约定再求值；多文件探索的步数 × 每请求固定开销 | `fileEquals`：与最高优先级那一层的值比对 |
| **big-file-paging** | 单个 `src/pipeline.js`，约 4200 行 / 170KB；`LIMIT_TABLE` 在 ~55% 处，`auditLimit()` 在最后 12 行读它；另有历史注释与 `LEGACY_LIMIT_TABLE` 两个错值 | 写出 `auditLimit('staging')` 的返回值，只把这一个整数写进 `answer.txt` | 整读 4 千行 vs 定位到两段远处区间各读一次：日常最高频的"在长文件里找答案" | `fileEquals`：与活表里的值比对（两个诱饵值都不同） |
| **noisy-test-triage** | `runner.js` 打印 2400 行 `ok N - …`（每 250 行一条 `# progress`），恰好一行 `not ok N - …` 带断言诊断，退出码 1 | 跑 `node runner.js`，把失败用例名（`not ok <number> - ` 之后的原文）写进 `failure.txt` | 大输出的裁剪与定位：`\| grep`/有界搜索 vs 把 6 万字符日志灌进上下文 | `fileEquals` + 把"套件确实在挂"钉成 `invariant` 的 `command` 检查（前提破了 dry-run 拒绝这题） |
| **api-rename** | `src/core.js` 有 `parsePayload` 与两个长相符号（`…Legacy`、`…Async`，后者**调用**目标函数）；60 个模块中 1/5 只用到长相符号；根目录 `check.mjs` import 改后的名字 | 把 `parsePayload` 改名为 `decodePayload`（定义/import/调用点），长相符号保持原名，**只用文件工具改**（禁止 shell 文本替换），不改行为、不增删 `src/` 文件，完成后 `node check.mjs` exit 0 | 跨文件批量替换 vs 逐文件 read+edit；字面量替换的边界（前缀相同的符号、长相符号体内的调用点） | `contentHashes` 逐文件字节比对（漏改一处或顺手改错都挂）+ `command node check.mjs` exit 0 |
| **gate-repair-loop** | `gates/gate_00.js`–`gate_23.js` 共 24 个阶段模块（各 70 行惰性填充，把契约和代码隔开），加一个 **fail-fast** 的 `check.js`；每个阶段只有一个绑定常量与自己的契约注释不符 | 跑 `node check.js`（它逐阶段比对 golden 值、在第一个不符处停下），修 `gates/` 里失败的阶段直到 exit 0，再把门禁打印的最终值写进 `answer.txt` | **长跑形状**：24 个阶段 ⇒ 至少 24 轮"跑→读→改"，且第 N 轮要把前 N 个阶段累积的通过行重新带进上下文（末轮约 22KB）——考的是**步数**与每步的固定开销，不是单次上下文体积 | `command node check.js` exit 0 + `fileEquals answer.txt`；`check.js` 另挂 `fileEquals` 的 `invariant` 守卫防篡改 |


## 4. 结果、日志与清理

- `bench/runs/<folder>/<时间戳>-bench-base|bench-ops/`：`summary.json`（token、步数、通过率）、
  `report.md`、`meta.json`、`dump-config.txt`、`runner.log`，以及
  `results/<task>-r<i>.{events.ndjson,metrics.json}`。
- 对比报告：`bench/runs/<folder>/comparison-bench-base-vs-bench-ops.md`，控制台同时打一份。
- 跑的时候会实时打印进度和卡顿警告；Ctrl-C 会终止 dsh 子进程，已跑的部分照样写进
  `summary.json` / `report.md`（标 stopped early）。
- 清理旧结果就是删 `bench/runs/<folder>/`；`--keep` 保留每个任务的临时工作区。

## 5. harness 自己的测试

`node test/run.mjs bench`（或 `npm test`）跑 `test/bench.test.mjs`：fixture 自检、verify 的各种检查、
聚合与对比门禁、`benchmark-test-NN` 分配器、`bench:baseline` wrapper，以及 setup 的 patch 编辑器、
占位符判断和本地 build 检查。不连服务器、不花 token。
