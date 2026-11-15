# Session shell performance

The implementation and performance follow-up for #872 are tracked in [issue #932](https://github.com/T-Auto/dsh-ops/issues/932).
The issue records each optimization, paired measurements, validation, remaining targets and the scoped handoff.

The full performance target remains unmet. Native-search measurements do not replace the shell workload,
and functional CI does not establish full-host, cold-start or Linux performance acceptance.

Optimizations preserve receipt isolation, unregistered-output detection, cancellation isolation,
per-command output caps/spill ownership, checked paths and honest scan completeness.

Task-specific benchmark harnesses, raw samples and logs are kept outside the repository.
No runtime release or merge is implied by the reviewable PR stack.
