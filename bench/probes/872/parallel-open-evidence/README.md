# Bounded checked-open evidence

Supplemental native-file measurement for #872, stacked on #955.

Exact content scans open at most 32 eligible files ahead with at most eight workers.
Every open uses the existing lexical, ancestor, no-follow and file-type checks.
Content reads, byte/file accounting, hashing and output stay ordered. Early-result
scans stay serial. Pending handles close before recursion and on completion/error.

The unchanged search harness alternates arm order over 20 measured pairs after
three retained first-touch/warmup pairs. All canonical results match; the 2,000-file,
62,890-byte corpus is unchanged. Times include one-shot worker startup (milliseconds).

| Query | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| exact | 1950.11 / 2188.93 | 763.88 / 949.50 |
| bounded | 30.03 / 32.52 | 30.20 / 35.10 |
| miss | 1953.29 / 2343.30 | 738.66 / 842.77 |
| glob | 234.80 / 264.18 | 234.85 / 259.42 |

This is about a 61% exact-scan median reduction, not a passing 60 ms grep result.
The bounded query is deliberately partial and cannot stand in for complete scans.

Reproduce with Rust 1.97.1 release workers:

```powershell
node bench/probes/872/checked-parent-evidence/make-corpus.mjs NEW_CORPUS
$env:DSH_OPS_PROFILE_SAMPLES = '20'
node bench/search-profile.mjs BEFORE_WORKER AFTER_WORKER CORPUS_ROOT
```

The barrier regression fails with serial opens (one reaches the held gate instead
of eight), and passes with the bounded implementation. The 84-test search suite
passes with one existing UNC helper ignored. Regressions compare ordered contents,
byte/file budgets and snapshot hashes, refuse excluded/denied paths, preserve
checked-open failures as gaps, and release pending handles after callback errors.

Shell controls deliberately use the **same frozen #955 driver binary in both arms**.
These are control measurements, not benefits attributed to this native-file change.
Empty p50/p95: 3.79/4.90 and 3.46/4.36 ms.
Plain-ls 106-op model: 15.895 and 17.053 s;
ls-la: 53.053 and 52.409 s.
Plus two modeled 30 s builds: 75.895 and 77.053 s.
The fixture adaptation and three-sample limitations remain in the raw report.
All performance acceptance, full-host/cold-start qualification and Linux comparison
remain open. No runtime pin, release, permission or tool contract changes.

Raw samples, exact binary identities and normalized evidence/source hashes are in
`provenance.json`. Full gate/CI receipts are recorded in the PR and issue #932.
