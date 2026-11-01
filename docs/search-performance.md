# Search performance diagnostics

中文版：[搜索性能诊断.md](搜索性能诊断.md).

Search prepares the include/exclude glob segments once per request. Each candidate splits
its relative path once and uses the existing wildcard matcher. This removes repeated pattern
allocation without changing traversal order, metadata checks, no-follow opens, credential
exclusions, scan budgets, exact totals, early stopping or continuation fingerprints.

Set `DSH_OPS_PROFILE_SEARCH=1` in the **worker process environment** to emit one diagnostic
JSON line to stderr, prefixed `dsh-ops-search-profile `. This is a developer diagnostic, not a
tool argument or a result field. With the variable absent, no stage clocks or diagnostic line
are produced. Diagnostics contain only stage names, invocation counts and nanosecond totals;
they contain no paths, patterns or file content. A host may capture worker stderr without
displaying it, so the direct-worker runner below is the reproducible collection boundary.

| Stage | Measured work |
| --- | --- |
| `walkTotal` | Entire bounded traversal, including callbacks and the stages below. |
| `globCompile` | Request-level include/exclude classification and segment preparation. |
| `relativeMetadata` | Directory-handle-relative metadata lookup for an entry. |
| `absoluteMetadata` | Absolute metadata lookup used by the existing link/reparse checks. |
| `globFilter` | Candidate path segmentation and wildcard matching. |
| `pathValidationAndOpen` | Revalidation from the absolute root and the protected file open. |
| `readIo` | Individual reads, including the final zero-byte read. |
| `contentHash` | Hashing the complete bounded file buffer for continuation identity. |
| `matchAndResults` | UTF-8 conversion, matching, context extraction and page construction. |

Missing stages were not executed. `walkTotal` includes the other stages; do not add it to
them. Directory enumeration, directory opening, metadata fingerprinting and other bookkeeping
remain in that inclusive total. Worker initialization, final serialization, process startup and
host dispatch are outside its boundary. These counters identify where to investigate; they do
not establish that an authorization check can safely be removed or cached.

## Reproduce a comparison

Build two release workers, preserving the first binary before building the second. Both must
include the same profiler. To compare this change, the first profiling-only commit uses the old
matcher; the following commit changes request-level preparation. Run from the repository root:

```console
node bench/search-profile.mjs BEFORE_WORKER AFTER_WORKER CORPUS_ROOT > search-profile.json
```

The runner content-identifies the corpus, records worker SHA-256 hashes and environment,
alternates worker order, retains the first sample and two additional warmups, then records five
measured samples per query. `DSH_OPS_PROFILE_SAMPLES=1..20` changes the measured count. Progress
goes to stderr and the complete report to stdout. Queries cover exact TypeScript grep, bounded
grep, an unfiltered miss and glob. The timeout is 35 seconds around each worker, retaining the
existing 30-second cooperative scan budget. Errors, result hashes, coverage and stage counters
are kept for every call; a result mismatch or changed corpus makes the runner fail.

The corpus identity includes sorted relative names and content hashes for regular files after
excluding dot entries, dependency/build directories and links. It is an input identity, not a
claim that every file is searchable: oversized files, invalid encodings, credentials and runtime
gaps still affect the actual coverage report. No corpus contents or names are written to the
report. Run on a stable, trusted local corpus; the manifest walk is a repository-only diagnostic.

Compare equal queries, result hashes and coverage before comparing timing. `exactTotal: false`
saves later scanning work and supplies only a lower bound; it is not an equivalent-work speedup
over exact counting. A first sample is not a controlled cold-cache experiment. Machine load,
filesystem/cache state and antivirus activity can dominate a small allocation reduction.
CI asserts functional contracts and profiler isolation, not wall-clock thresholds.

See [search coverage](search-coverage.md) for the unchanged completeness and cursor rules.
