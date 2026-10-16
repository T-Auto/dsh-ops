<!-- 标题：<type>(<scope>): <subject>（英文，conventional 形式）。
     正文：删掉不适用的段落，但 Validation 段请保留并给出实际读数。
     English: keep the four sections; Validation carries real command output, not ticks. -->

Closes #

## What was wrong

<!-- 现象、最小复现、以及在什么环境下测到的。写清"改之前是什么行为"。 -->

## The change

<!-- 改了哪些文件、为什么这样改。刻意没做什么也写在这里。 -->

## Validation

<!-- 下面的清单是提醒，不是「勾完就算」：Validation 段必须给出实际命令与输出（含 passed/skipped/failed 计数）。 -->

- [ ] `npm run verify` 的实际输出（或 `DSH_OPS_REQUIRE_RUNTIME=1 npm run verify`）
- [ ] 撤掉本次实现后，相关检查会变红（行为级红绿，而非只看代码结构）
- [ ] `docs/CHANGELOG.md` 的 `## [Unreleased]` 已加条目（行为或发行物文档有变化时；若判定不需要，在 Validation 段写明理由）
- [ ] 行为变化已同步相关 docs
- [ ] 未新增依赖，未改 `package.json` 的版本与 `optionalDependencies`
- [ ] 改了面向模型的描述或参数时：说明它对 schema / 提示词字节的影响，并同步受影响的文档

```
$ <命令>
<输出>
```

## Environment

<!-- OS 与架构、Node 版本、所基于的上游 main commit、安装通道（registry / 本地 tarball）。 -->
