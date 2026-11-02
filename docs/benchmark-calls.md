# Real-corpus tool-call timing

中文：[工具调用基准](工具调用基准.md)。Command reference: [bench](../bench/README.md).

`node bench/cli.mjs calls` measures host-dispatched `grep` and `glob` calls without a
model. It supports official tools versus OPS and two OPS builds in the same harness.
Measurement runs are opt-in; tests of the harness can run in CI, but timings never decide
a CI gate.

## Prepare the inputs

Run from a checkout with its locked development dependencies installed. Build each OPS
checkout with `npm run build` and
`cargo build --release --locked --manifest-path native/Cargo.toml`. Each measured build
must expose the current `lib/components/file`, `lib/components/discovery` and
`lib/policy.js` interfaces. This runner does not adapt older 0.3.x plugin APIs.

Use separate build directories (existing checkouts or worktrees); no separate copy of
the benchmark is needed. Both arms use the host packages installed in the **runner**
checkout, so this measures OPS changes under one host version, not a host upgrade.

## The shipped corpora

Four manifests ship in `bench/corpora`. Each names at least one root and declares a shape
range (files, MiB, depth, binary-byte ratio) that the runner checks before it measures
anything. The tree itself is prepared by the operator with the recipe below; the recorded
identity sample, not a directory name, is what proves which version was measured.

| Corpus | Class | Workload | Cases | Prepare |
| --- | --- | --- | ---: | --- |
| `harness-client` | source | one commit's `packages/client`, 3,155 files / 21.9 MiB | 8 | `git archive 22ddee3 packages/client` from a clone, extract it, pass `--root` |
| `python-stdlib` | runtime | an installed CPython stdlib, 4,121 files / 112.8 MiB | 8 | the DSH runtime install (the identity hashes `python3.dll` / `python.exe`) |
| `rust-runtime` | runtime | a rustup toolchain, 66,077 files / 1,330 MiB | 4 | `rustup toolchain install 1.99.1 --profile default`, then `--root` its directory |
| `npm-runtime` | runtime | this checkout's installed `@deepseek-ai` packages, 6,077 files / 239.7 MiB | 8 | the checkout's own `npm ci` |

- In-budget corpora (`harness-client`, `python-stdlib`, `npm-runtime`) carry eight cases:
  grep at limits 5/50 with `exactTotal` true/false, the unfiltered no-hit scan, an
  exact-basename glob, a no-match glob and the extension glob.
- `rust-runtime` (66,077 files / 1,330 MiB) is past the 10,000-file / 256 MiB scan budget, so
  it carries only the coverage cases: an unfiltered no-hit scan plus three globs. A full count
  never completes there, so a hit pair would compare two truncated scans; that is why it
  declares none.
- `npm-runtime` has no recipe of its own: it describes whatever the runner has installed, which
  is exactly the "packages I actually run" question. Its identity changes when you update them.
- A declared shape describes the tree the recipe produces, not an arbitrary checkout: if the
  numbers do not match, the runner refuses rather than filing a different workload under the
  same name.

## Run a comparison

Create a dedicated output directory first. These PowerShell examples use a unique
temporary directory; replace the two build paths with your existing builds:

```powershell
$benchOutput = Join-Path ([IO.Path]::GetTempPath()) ('dsh-ops-call-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $benchOutput | Out-Null

# Default: official tools versus this checkout's OPS build.
node bench/cli.mjs calls --corpus harness-client --warmup 2 --repeat 5 --out "$benchOutput/official-vs-ops.json"

# Current OPS versus candidate OPS, in one process.
node bench/cli.mjs calls --corpus harness-client --baseline-plugin-root 'D:/builds/ops-current' --plugin-root 'D:/builds/ops-candidate' --warmup 2 --repeat 5 --out "$benchOutput/current-vs-candidate.json"
```

- Without `--baseline-plugin-root`, the selected arms default to `official,candidate`.
- With it, they default to `baseline,candidate`. Add
  `--projection official,baseline,candidate` to include all three in the same run.
- Each OPS arm uses its own `lib/`, public tool names and release worker.
  `--baseline-worker` and `--worker` override the corresponding executable.
- `--dry-run` prints the corpus, arm paths and call plan without booting hosts or writing.
  It does not validate the builds; execution preflight does that before host boot.
- `--baseline <previous.json>` only checks corpus identity against a prior report. It does
  **not** select the baseline OPS build or compare historical timing samples.
- `--root` overrides one corpus's location for a tree prepared elsewhere. Every report path
  must be new; existing evidence is never overwritten.

## Read the evidence

Every shipped manifest keeps its unfiltered `grep-miss` scan and pairs content queries at
limits 5 and 50 with `exactTotal` true/false (#384). `args.include` maps to the OPS `glob`
filter. Compare each exact/bounded OPS pair for prefix-query savings; `summary` still needs a
full scan. The in-budget corpora also answer the exact-basename and no-match glob questions.

These measure current traversal, not UFFS or an index's build/refresh/memory costs. Official
tools are a separate reference: their grep has no per-call `limit` or `exactTotal`, and their
glob uses modified-time order and includes hidden/dependency paths that OPS excludes.
Different coverage, ordering and caps mean different work.

Arms execute sequentially within each case and reverse order on alternate rounds.
Warmup calls use the same schedule but are excluded from measured rows. The report's
`arms` map identifies each OPS package version, compiled `libSha256` and worker path/hash;
the official arm records its tool-package versions. Existing top-level `pluginRoot`
and `worker` fields continue to identify the candidate, or are null if absent.

Each case/arm archives its effective `arguments`, including OPS overrides. Coverage
adds `matchedObserved`, `matchedTotal` and `displayedItems` when present; absent facts
are null, not zero. Early stops report a lower bound, not an exact total.

`corpora[].rows` preserves arm and round order, dispatch-to-result `durationMs`, child
`spawnMs`, output bytes, coverage and errors. Each case summarizes the arms separately.
Child time is included in total time; it is not an additional cost to add to the total.

Read elapsed time alongside scan completeness, truncation, skipped files and output
semantics. The two versions share the same logical query and OPS argument overrides;
the harness does not prove result equivalence. A version that stops early may appear
faster because it did less work. Official tools do not expose the same coverage facts.

`firstMs` means the first **measured** call after warmup. Even `--warmup 0` does not
guarantee a cold OS cache. `steadyMs` / `convergedAt` describe a tail within 10% of the
last sample; a one-sample tail alone cannot prove steady state. Increase warmup when
the runner reports that timings are still falling. Same-process alternation reduces
ordering drift; it does not make timings portable or eliminate machine noise.

Exit `0` means the measured calls and corpus checks succeeded, `1` means unusable
evidence (call error, input mutation, shape or identity mismatch), and `2` means invalid
arguments or missing inputs/builds. None means “the candidate is slower”. To validate
the setup, first point both version arms at the same build; this is an A/A check, not
evidence of a speedup.

## CI coverage

The default test inventory includes `bench-calls`, `bench-call-versions` and
`bench-gates-errors`: deterministic fixtures, argument/identity checks, separate plugin
loading, execution order and honest error reporting. They assert no timing or model cost.
Installed real corpora and cross-version performance measurements remain manual evidence.
