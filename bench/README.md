# bench

轻量、零依赖、自包含的测量工装:一套入口、两种测量模式、一份数据契约。它**只在仓库里跑** —— 不随
npm 包发布、不参与构建、不进 `verify:release` / `release.yml`。

## 三种命令入口

| 入口 | 形态 | 用途 |
| --- | --- | --- |
| 唯一跨平台入口 | `node bench/cli.mjs <command>` | 全部子命令: `setup \| ab \| report \| panel \| tools` |
| npm scripts | `npm run bench:ab` 等 | 日常使用;装包后 `bench/` 不存在,脚本会给出明确报错而不是 ENOENT |
| 底层单脚本 | `node bench/run.mjs` / `bench/compare.mjs` / `bench/lib/next-folder.mjs` | 排障与单步重跑;`ab` 只是把这几步按顺序连起来 |

`node bench/cli.mjs --help` 列出全部子命令。退出码:`0` 正常 · `1` 失败 · `2` 用法错误 ·
`3` 已声明但本切片尚未实现。

## 两种测量模式

| 模式 | 入口 | 用模型 | 断言什么 |
| --- | --- | --- | --- |
| 成本 A/B | `bench:ab`(模型驱动) | 是 | **通过率先行**;只有两侧都通过的配对参与成本比较;方向必须超过 A/A 噪声底 |
| 工具级确定性对比 | `bench:tools`(无模型) | 否 | 只判 `MATCH / MISMATCH / EXPECTED_DIFFERENCE / EXPECTED_REJECTION / UNSTABLE`;**永不断言时间** |

时序(s)只打印、只作人类证据;任何模式都不在门禁里裁决时间或 token 差异。

## 如何读报告

1. 先看**通过率**:任何任务从 ✅ 变 ❌ 都是回归,成本结论在此之后才看;
2. 再看**配对成本**:`paired` 数量说明有多少对可比 —— 只有两侧都通过的配对才算数;
3. 然后看**噪声底**:与自身对照(A/A)得到的区间;本次 Δ 落在区间内就**只报区间、不报方向**;
4. 最后看 `usageReported`:任一步没报 usage,该行 token 只是下界,不能支撑结论;`panel.html`
   只是**读 `run.json` 的查看器**,不内联任何数据。

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

## 为什么 bench 不随包发布

硬边界(设计议题 #205):**数据只存 JSON**、**HTML 只是读 JSON 的查看器**、**测试期可用但构建期不
构建**。因此 `files` 不含 `bench/`,也不新增构建步骤;装包之后 `npm run bench:*` 会先检查 `bench/`,
不存在就打印 "bench 只存在于仓库,不随包发布" 并以退出码 `2` 结束。

`setup`(P9/P10)、`report`(P11)、`panel`(P12)、`tools`(P13)尚未落地,CLI 会打印所属切片并以退出码
`3` 结束 —— 不会静默成功。`ab` 已能解析参数、分配唯一的 `benchmark-test-NN` 组目录并打印三条命令。
