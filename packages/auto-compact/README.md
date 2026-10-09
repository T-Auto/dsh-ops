# @dsh-ops/auto-compact

Internal, bundled companion of dsh-ops. It adds one independently toggled row to
**Plugins → dsh-ops → Included components**, not a second marketplace bundle.
The package-root entry is required by DSH rc.2's browser module discovery; plugin
subpaths are not browser entry points. No separate installation is required.

Defaults: threshold 50% (integer 1–99), cooldown 120s (30–3600), timeout 120s
(10–600). Configuration belongs to this row and uses host profile settings with
revision fencing and restore defaults. The policy calls the same public idle
maintenance API as `/compact` only above the rounded Web context percentage and
after a non-cancelled turn. Running tools are not interrupted. No new model-facing
tool, polling, or host auto-policy modification is introduced.

One owned operation at a time, cooldown, unchanged-surface suppression and
abort/drain teardown bound work. Commit/save failures suspend this session until
component reload and require inspection. Timeouts rely on cooperative cancellation.
Summarization may call the host's configured model and incur cost; it is not
lossless. Missing samples/capacity and busy admission skip work.

This is unpublished development source. See the main dsh-ops repository's
`docs/auto-compact.md` for safety limits and manual acceptance requirements.
