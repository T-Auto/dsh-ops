# Fixed PowerShell companion bridge fixture

Repository: https://github.com/xinspark/dsh-win-pwsh7

Commit: `91414fadf8a9006bab3fd07c89e705c9e5c8fdae`

Copied on 2026-11-01. `lib/dsh-ops-bridge.js` is copied byte-for-byte as
`dsh-ops-bridge.mjs` (SHA-256
`4b59c2f88d36da93c250cdcdf89de6f976744674defc79b75efe709427d13e6d`).
The upstream MIT `LICENSE` is included verbatim (SHA-256
`4fa585e7f812b6d74cd2dbd9381b2532735fc61914eb4cf70641e85f0d01185b`).
The upstream tree at this commit has no NOTICE file.

This fixture is test-only, not a runtime dependency. Tests call only
`mountDshOpsBridge` against an in-memory host with a temporary test home;
profile-patch helpers are not called. Module evaluation only defines functions
and constants. Passing tests establish coexistence with this pinned bridge,
not every future companion version. No third-party repository or real profile
is modified.
