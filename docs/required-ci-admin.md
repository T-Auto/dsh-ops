# Enforce required CI (#303)

The workflow now accepts every pull-request target, including stacked feature branches. A workflow run and a local check cannot enable repository enforcement. An administrator must apply the separately reviewed [ruleset payload](../.github/required-ci-ruleset.json).

The payload targets `main`, `0.3.2` and `release/0.4.0`, requires a PR and the current-base `CI required` check from GitHub Actions, and forbids force pushes. It grants no bypass and adds no review-count or merge-method restriction. The GitHub Actions app ID `15368` was verified from this repository's successful `CI required` check metadata. The account used for the 2026-10-25 audit had push/triage rights but no admin rights; the ruleset listing was empty. These observations are dated evidence, not a claim about future settings.

An administrator should first inspect existing rules so applying this file does not create an overlapping duplicate:

```console
gh api repos/T-Auto/dsh-ops/rulesets
```

If no equivalent rule exists, create it from the repository root:

```console
gh api --method POST repos/T-Auto/dsh-ops/rulesets --input .github/required-ci-ruleset.json
```

If an equivalent rule exists, review its complete configuration and update that rule instead of blindly replacing it. Repository administration write permission is required by the [GitHub ruleset API](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset).

After applying, inspect Settings → Rules and the active branch rules. With a disposable PR, verify the merge UI refuses an absent/pending/failing `CI required` check and accepts the passing current head once other requirements are satisfied. Do not merge the probe just to test it. Record the ruleset URL, probe PR URL/head and observed result in #303. A JSON file or green workflow alone is not this acceptance evidence. Dependabot failures are blocked too; fix or close the PR rather than bypassing the check. Fork runs may still need a maintainer to approve `action_required`.

## 管理员操作

工作流现已覆盖所有 PR 目标分支，包括堆叠的功能分支；代码合入和本地校验都不会自动启用仓库规则。管理员需检查现有 ruleset，再审阅并应用上面的 JSON。它仅对三个维护分支要求 PR、来自 GitHub Actions 的最新基线 `CI required`，并禁止强推；无绕过名单，不额外规定审阅人数或合并方式。

如已有同等规则，保留并审阅其完整设置后更新，不要直接覆盖。应用后用可丢弃 PR 验证缺失、等待和失败检查确实阻止合并，记录规则 URL、PR 和 head；无需真正合并测试 PR。绿灯或 JSON 文件不等于保护已生效。Dependabot 红灯同样应修复或关闭；fork 的 `action_required` 仍可能需要维护者批准。#303 的管理员验收在这些证据到位前保持未完成。
