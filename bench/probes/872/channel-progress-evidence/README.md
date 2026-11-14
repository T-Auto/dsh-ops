# Channel progress evidence

See [the bilingual performance report](../../../../docs/session-shell-performance.md#channel-progress-notifications--2026-11-15)
for interpretation, scope, validation and remaining targets.

- `before.json` and `after.json`: unchanged channel-wakeup comparison harness,
  300 empty commands after 30 warmups, 100 printf samples, 256 MiB bulk arm;
  `ONLY_NIU=1`, stock Niubash, Windows Ryzen 7 6800HS. Both arms completed before
  the full gate began, without concurrent test/build work.
- `provenance.json`: source and measured executable hashes. Rebuilding the same
  Windows sources changes executable hashes; reports name the binaries they used.
- `scenario.json`: same production-driver adaptation in both arms, run after the
  full gate finished. The report records the fixture, commands, weights, all raw
  samples and explicit differences from the supplied prototype scenario.
- `validation.json`: local gate receipt and red/green test counts.

Reproduce the scenario after building both drivers and this checkout:

```console
node bench/probes/872/scenario-driver.mjs BEFORE_DRIVER AFTER_DRIVER NIU REPORT
```

The raw microbenchmark includes inherited historical descriptions from its original
harness. The current production implementation uses private named channels, not
the historical receipt-file wording; `driverSource` and artifact hashes identify
the compared implementations. No host-overhead equality is established by these
driver-only measurements.
