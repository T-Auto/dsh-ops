# Schema measurement

Manual measurement only; not CI, regression coverage, a tokenizer, or tool-use telemetry.

Baseline: plugin `dee3c57`, FastCtx 0.2.6, before presentation changes. Current: same runtime, plugin-only schema projections. Metric: sum of compact UTF-8 JSON `{name,description,parameters}` sizes, no whitespace formatting; tokens ≈ ceil(bytes/4).

| Surface | Baseline bytes | Current bytes | Reduction |
| --- | ---: | ---: | ---: |
| Nine FastCtx schemas (full-access session) | 18,889 | 9,739 | 48.4% |
| Four file schemas | 12,807 | 6,724 | 47.5% |
| Routing section (original full ladder vs compact three-layer table with strict-argument reminder) | 3,373 | 1,110 | 67.1% |

Full-access FastCtx schema estimate: 4,723 → 2,435 tokens. The corrected object-root ops_bash schema adds 961 bytes (~241 tokens); full FastCtx+bash surface is 10,700 bytes (~2,675 tokens). Restricted file-only surface: about 1,681 tokens; its routing table is 527 bytes (~132 tokens). No server instructions are published (the original raw server instructions were 246 bytes); the old host-shell section is also removed. Baseline excludes ops_bash, so compare nine FastCtx tools like-for-like rather than treating restoration as a regression of those numbers. Total request savings depend on host presentation; these are not API usage/billing measurements.

`ops_grep` went from 3,766 → 2,019 bytes; `ops_inspect_local_file` from 4,375 → 1,968. `ops_replace` is retained: schema cost cannot establish invocation frequency, and no usage-frequency measurement was collected.

Reproduce the current snapshot with `node scripts/measure-schemas.mjs docs/schema-current.json`. It only starts FastCtx, initializes, lists schemas, then closes it; it executes no tools. Keep the baseline unchanged; a different runtime schema requires an explicitly labeled comparison.
