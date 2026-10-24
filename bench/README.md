# Benchmark Manual

## 测试前的准备

Linux / macOS：使用当前平台构建的 worker；`setup --dry-run` 会说明跳过 Windows PowerShell pin、PSModulePath、Windows Bash IPC 和随包 Windows shell 检查的原因。当前 shell 行已支持各平台，不要再从早期 Windows-only 默认值推断配置。模型 sweep 仍需自己的 OpenAI 兼容服务与凭据；`tools` 自检不调用模型。

Linux / macOS: build the worker for the current host. `setup --dry-run` explains skipped Windows-only checks. `ab`, `compare`/`report`, `panel` and `tools` use the same entry point on every platform. A model sweep needs your own OpenAI-compatible endpoint; the tools self-check needs no model. Every sweep now fingerprints the composed profiles even without `--seal`, recording platform and component configuration in the arm summaries. `enabled` is a configuration fact, not proof of tool readiness; unresolved expressions remain `unknown`.

`compare` 默认拒绝不同平台（或已知/未知平台）混配，退出码为 2；诊断时可加 `--allow-cross-platform`，报告会明确标记差异不是插件效应。旧数据两侧都缺平台时仍可读取，显示 `unknown`，不能据此声称同平台。CI 的可选 tools-only smoke 覆盖 Linux / Windows / macOS，各自上传 artifact；不运行模型 sweep，不产出跨平台结论。

`compare` rejects mismatched platforms with exit 2. `--allow-cross-platform` is an explicit diagnostic override and adds a “not a plugin effect” warning. Both-unknown legacy archives remain readable. The optional, non-blocking tools smoke runs on Linux, Windows and macOS with separate artifacts.

```console
npm ci --ignore-scripts
npm run build && npm run build:ptc     # lib/ + 原生 worker
```

### 再准备 dsh + 两个 profile

```console
npm i -g @deepseek-ai/dsh
node bench/cli.mjs setup              # 会自动添加 2 个 headless profile（base、dsh），然后在 dsh 上面安装本地代码 build 出来的插件
```

### 配 LLM 链接

跑 `node bench/cli.mjs setup` 会在自动创建；也可以手动创建（会覆盖已有的）：

```console
cp bench/llm.patch.example.yml bench/llm.patch.yml           # bash
```

填 `bench/llm.patch.yml`：

- `baseURL`：服务器地址，如 `https://host/v1`
- `<model-id>` ：模型 id，两处必须一致
- `apiKeyEnv`：放密钥的环境变量名，如 `BENCH_SERVER_API_KEY`
- `contextWindow` / `maxTokens`：模型真实窗口 / 单次输出上限（默认最大 256K 上下文，单次最大 32K 输出）

密钥只放在 `~/.dsh/.credentials.yaml` 的 `ref` 节点下面的环境变量里面，这样避免出现在项目源文件、对话的上下文

## 怎么跑全量

```console
node bench/cli.mjs ab
```

## 怎么跑单个 task

```console
node bench/cli.mjs ab --task csv-sum
```

## 结果在哪看

- 在 bench/runs 文件夹里面可以看到
- 文件夹名称格式为 `benchmark-YYYY-MM-DD-NN`（按当天日期编号，从 `-00` 起）
- 跑完自动在组目录写 `DSH-OPS Benchmark Report <UTC>.md`

## 成本 A/B 的条件 / A/B measurement conditions

```console
node bench/cli.mjs ab --model DeepSeek-V4.1-Flash --reasoning-effort high --seal
node bench/cli.mjs ab --model model-a --model model-b --reasoning-effort low --reasoning-effort high --seal
node bench/cli.mjs report --matrix bench/runs/benchmark-YYYY-MM-DD-NN
```

`--model` 会真实改变两臂路由；`--reasoning-effort` 只接受 `off|low|high|max`。Provider 默认取 LLM overlay 中的字面值，也可用 `--provider` 指定；请先在 overlay/provider 配置中声明要测试的模型。条件补丁作为最后一个 `--patch` 同时传入两臂，不修改原来的 `llm.patch.yml`。每臂保留实际 `dump-config.txt`，`--seal` 将同源 `{provider, model, reasoningEffort}` 写入 `run.json` 的 `meta.condition`。未指定思考等级且 overlay 也没有该值时，记录 `null`（宿主默认值未固定）。

重复的模型与档位形成笛卡尔积，每个条件位于独立的 `condition-NNN` 目录；根目录的 `matrix.json` 指向各组证据。多组报告逐条件展示，**跨条件不可比，不合并 Δ**。不同条件（含已知与未知）交给 compare 会退 `2` 并列出两侧条件。不传这些旗标时仍使用原有 overlay，条件标为 `unknown`；旧 run 缺少该字段仍可读，旧 `meta.model` 标签不作为路由证据。

Model flags set the actual shared route, with the condition patch applied after the provider overlay. Both arms archive their composed configuration. Repeated models and reasoning levels form independent Cartesian groups; `report --matrix` renders one section per condition and never combines deltas. Cross-condition comparisons exit 2, naming both conditions. Without new flags, routing is unchanged and the condition is `unknown`; historical labels do not prove routing. An omitted reasoning level remains `null` unless the overlay pins it. All examples are optional model-driven runs, outside CI.

### 组件开关 / Component switches

```console
node bench/cli.mjs setup --switch hide-official=all --switch ptc --switch panel=false --dry-run
node bench/cli.mjs setup --switch hide-official=read,grep --switch discovery --switch shell
```

`--switch` 可重复，支持 `hide-official`、`ptc`、`panel`、`discovery`、`shell`；省略值等同 `true`，普通开关也接受 `false`。`hide-official=all` 只选择已有替代实现的 `read,glob,grep`，也可指定不重复的子集或 `false`。只修改 candidate 的 `cordis.patch.yml`；baseline 不写入组件行。每次 setup 只改明确指定的开关，不自动搜索组合。

写入幂等；本地已有相反值需 `--force`，继承的字面配置键会保留。动态表达式、非映射配置、重复行和无法安全编辑的目标形态需手工处理，`--force` 也不会猜测。`--dry-run` 打印请求的行和值，不启动宿主、不修改 profile。

实跑先读合成配置，写入后再核验配置并执行一次有超时的最小 headless turn；这可能调用已配置模型。没有已完成 turn、宿主错误或 `READINESS_BLOCKED` 都会让 setup 失败并指向 [#207](https://github.com/T-Auto/dsh-ops/issues/207)，不会启动 benchmark sweep。这个探测不代替 Desktop 重启后的人工验证。

实际配置写入摘要及封存 `run.json` 的 `arms.cand.switches`，报告头和 panel 显示 candidate 开关。baseline 的空集合与 candidate 的非空集合属于正常 A/B；两份运行的 candidate 集合不同则 compare 退出 `2`，列出差异，不合并 Δ。未求值配置记录 `null`，旧数据缺失开关元数据仍可读取为未知；这些字段是配置事实，不证明组件已经发布到会话。

Repeat `--switch` to set candidate components. Values default to `true`; booleans also accept `false`. `hide-official=all` expands only the implemented `read,glob,grep` replacements, or select a unique subset. Setup edits only the candidate patch, preserves inherited literal configuration, and changes only named switches. Conflicting local values require `--force`; dynamic or unsafe shapes require manual edits even with force. Dry-run prints the requested values without launching the host or writing profiles.

Real setup verifies composed configuration and runs one bounded headless readiness turn, which may call the configured model. Missing successful completion, host errors and `READINESS_BLOCKED` fail setup with the #207 diagnostic before a sweep starts. This does not substitute for Desktop validation. Summaries and sealed `arms.cand.switches` retain effective configuration; report headers and the panel show it. Comparisons reject different candidate switch sets with exit 2, while the baseline's empty set is expected. Unevaluated configuration and historical missing metadata remain unknown, without implying publication readiness. Switch combinations are selected explicitly and are outside the CI gate.

## 任务一览

六个任务各自压一种能力，`ops_*` 工具名来自 `publicToolName()`。每个任务的期望值都由夹具生成器现算（`derive*`），判卷在 `bench/lib/verify.mjs`。

| 任务 | 工作量 | 主要测什么 | 相关工具 |
| --- | --- | --- | --- |
| `api-rename` | 12 个模块 + `core.js`（另生成 `check.mjs`），把 `parsePayload` 改名为 `decodePayload` | 符号级改名而非文本替换：定义、import、调用点一个不能漏；诱饵 `parsePayloadLegacy` / `parsePayloadAsync` 和完全不碰该符号的文件必须原样保留；判卷是 `src/` 全部文件的字节级 SHA-256 全等 + `node check.mjs` 退 0 | `ops_grep`（+`ops_glob`）搜调用点；`ops_read_files` 读文件；`ops_edit_file` / `ops_replace` 改名 |
| `big-file-paging` | 4200 行单文件 `src/pipeline.js` | 分页读取：定位 `auditLimit('staging')` 所在行段，只读需要的两段而不是整读文件；文件里埋了过期注释和被取代的 `LEGACY_LIMIT_TABLE`，grep 一次仍要判断；`answer.txt` 等于该常量的整数 | `ops_grep` 定位；`ops_inspect_local_file`（或 `ops_read_files`）带 `offset`/`limit` 只读两段；`ops_write_file` 写答案 |
| `config-hunt` | 3 层配置目录 + 12 个 `packages/*/config.json` 诱饵 | 层级查找与优先级判断：先 glob 出配置层，再 grep key，最后按 README 的优先级取 `MAX_UPLOAD_MB` 的有效值；只 grep key 就停下有 1/4 概率拿错答案 | `ops_glob` 找层；`ops_grep` 找 key；`ops_read_files` 读优先级文档与三层配置；`ops_write_file` 写答案 |
| `csv-sum` | 8000 行 CSV，汇总 EU 区 `amount` 列 | 上下文控制：把聚合交给 shell 而不是把 8000 行读进上下文，`answer.txt` 只写整数和 | `ops_bash` 聚合；`ops_read_files` 只看表头确认列；`ops_write_file` 写答案 |
| `gate-repair-loop` | 12 个 stage 模块（每个约 70 行）+ `check.js` | 迭代修复循环：门禁停在第一个坏 stage，每个 stage 只错一处绑定常量、契约写在模块自己的注释里，跑→修→再跑直到退 0；`check.js` 字节不变是 invariant | `ops_bash` 跑门禁；`ops_read_files` 读 stage；`ops_edit_file` 按契约修常量；`ops_write_file` 写 `answer.txt` |
| `noisy-test-triage` | 2400 个测试、恰好一行 `not ok` | 精确提取：跑测试重定向到文件，在日志里只捞那一行失败测试名写入 `failure.txt`（必须精确匹配），且 runner 仍退 1 是 invariant | `ops_bash` 跑并重定向；`ops_grep` 只捞那一行（如 `^not ok`，可配 `outputMode: summary/content`）；必要时 `ops_read_files`；`ops_write_file` 写结果 |
