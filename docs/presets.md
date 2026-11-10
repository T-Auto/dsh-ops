# Presets and the default mode

English | [中文](预设与默认模式.md)

`ops-ptc` is OPS's fifth enhanced built-in mode. The host composes sessions only from registered preset
declarations, so OPS no longer inserts a preset row from a bundle patch: the `dsh-ops` plugin registers
`ops-ptc` at apply time through the host preset registry. This page covers the registration, the fragment and
the sync script, how to make it the default, and the ordering required before disabling the plugin.

## Runtime registration

- **Entry point**: `src/index.ts` calls `registerOpsPtcPreset(root)` at the start of `apply`; the
  module is `src/presets/ops-ptc/register.ts`.
- **Registration**: once the host `agentPresets` service is available (`ctx.inject(['agentPresets'])`), the
  plugin calls `agentPresets.register(definition)`, and the fiber that owns the injection calls the returned
  release on disposal. One root registers once; a second apply does not register again.
- **Definition source**: the shipped `presets/ops-ptc.patch.yml` fragment (`package.json` `files` includes
  `presets`). The plugin does not parse YAML itself: it resolves the host `@deepseek-ai/dsh-app-boot` through
  `resolveAppBoot` (this package, the running host entry, then the profile layer) and calls its
  `loadOverlayPatches('dsh-ops', FRAGMENT_FILE)`, so `!!js` platform expressions stay data and are evaluated
  by the host loader. It then finds the declaration with `name: '@deepseek-ai/dsh-agent-preset'` and
  `config.id: 'ops-ptc'`, verifies that `plugins` is non-empty, and hands it to the registry. An unresolvable
  app-boot or fragment only warns and leaves the preset unavailable.
- **Consequences**: there is no `ops-ptc` preset row in the plugin manager; the preset and the `ops_*` tool
  surface belong to the same `dsh-ops` row. Enabling the row brings both; disabling or unloading it releases
  the registration and removes both. A missing or malformed fragment, a host without the preset registry, or a
  rejected registration only warns once and leaves the preset unavailable; it never takes down the plugin row
  or its tools.

## The fragment and the sync script

`presets/ops-ptc.patch.yml` is generated; do not hand-edit it:

- Source: `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`; the generator
  `scripts/sync-preset-ops-ptc.mjs` edits the upstream text at anchored lines, preserving `!!js` expressions,
  comments and their expression form, then parses the result to self-check.
- Identity inside the fragment: the declaration id is `preset-ops-ptc` (an internal fragment identifier, not a
  bundle row and not a plugin-manager row), and the preset's `id` / `name` / `description` / `order` are
  `ops-ptc` / `OPS (PTC)` / a one-sentence description / `6`. `config.plugins` stays byte for byte
  upstream, so the compaction group is still the official `compaction-basic`; `dsh-compress-codex` is not
  introduced.
- The file header records the source and its `sha256`; the generator writes the new digest.

Common commands:

```console
node scripts/sync-preset-ops-ptc.mjs              # regenerate the fragment
node scripts/sync-preset-ops-ptc.mjs --check      # verify drift; exit code 1 on drift
node scripts/sync-preset-ops-ptc.mjs --stdout     # print it, write nothing
node scripts/sync-preset-ops-ptc.mjs --source <ptc.patch.yml or its directory> [--out <file>]
```

Source resolution tries `--source`, `DSH_WEB_APP_PRESETS`, package resolution of
`@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`, an upward `node_modules` walk, and finally the copy shipped
with an installed `@deepseek-ai/dsh`. An unresolvable source is a failure, never a quiet pass. Re-run the script
after upgrading the host and review the diff; `--check` fits a local verification step.

## Forcing the default preset (`global.forceDefaultOpsPtc`)

`dsh-ops` forces new sessions to default to `ops-ptc`. The bundle switch `global.forceDefaultOpsPtc` (label
"Force the default agent preset to OPS (PTC)", default true; toggle it on the plugin page's global card or set
it in YAML) controls this at runtime rather than baking it into the profile:

- **On (default)**: after the `ops-ptc` preset registers successfully, the plugin writes
  `selectedDefault: ops-ptc` on `agent-preset-registry` through the host settings service — the same
  mechanism and the same volatile field as choosing a default on the Agent presets settings page. A manual
  choice is therefore overridden on the next apply while the switch stays on.
- **Off**: restores the `selectedDefault` captured before forcing. When no value was saved, or the captured
  value is itself `ops-ptc` (a leftover from an earlier forced run), it falls back to the host
  `config.default`, i.e. that deployment's official default preset.
- **Disabling or unloading the `dsh-ops` row**: cleanup restores the default before releasing the preset
  registration, and only writes when the current default really is `ops-ptc`. A missing host settings service
  or a failed write only logs a warning prefixed with `dsh-ops: ` and never blocks unloading.
- Forcing happens only after a successful registration; a missing fragment, unresolvable app-boot or rejected
  registration never forces, but best-effort restores a leftover `ops-ptc` default (failures only warn).
- The forced value persists through the host settings layer into the profile's `cordis.patch.yml` (an
  `agent-preset-registry` override that also writes the `default` field) and survives a restart. Saving another
  switch on the row remounts it: the preset re-registers and the default is re-confirmed, and the remount's
  teardown restore settles before the replacement writes, so the two writes cannot race.
- The switch only changes the default preset choice; it changes no tool surface, permission or preset content.

In the host picker the preset is named `OPS (PTC)` and described as
"代码驱动的 PTC 工具面，由 dsh-ops 的 ops_* 工具扩展。".

## Setting another default preset manually

`ops-ptc` is only made the default by the switch above: while the switch is off, a default still pointing at
`ops-ptc` is restored on apply to the captured pre-force value or the official default (so disabling the row
never leaves a dangling default), so do not set `ops-ptc` as the default by hand. Other default presets are
still decided by the host/operator:

- **Host Agent presets settings page**: picking an already registered preset such as `standard` or `ptc`
  persists `selectedDefault`.
- **Explicit profile patch** (paste into `$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
    selectedDefault: standard
```

`default` is the deployment default used when no user selection exists; `selectedDefault` is the user-level
default new sessions resolve first, and it is what the settings page writes. **An id-targeted patch does not
deep-merge**: it replaces the matched row's whole `config`, so restate both keys. A profile without the
`dsh-web-app` bundle never loads the `agent-preset-registry` row: the patch prints one non-fatal
`patch: entry "agent-preset-registry" not found` and is skipped, the settings page does not exist, and the
default comes from that profile's own composition.

### Risks and rollback

- **With the switch on (the default)**: disabling or unloading restores the default before releasing the
  registration, so the normal path does not leave a dangling default; after re-enabling, or with the switch
  off, pick the default you want on the settings page. A failed restore only warns and does not block
  unloading; treat that case as the next bullet.
- **With the switch off**: apply also restores an `ops-ptc` default (the captured value or the official
  default), so a manual switch is usually unnecessary; if a missing host settings service makes that restore
  fail, switch the default to another preset before disabling or unloading, otherwise new sessions may fail to
  resolve the vanished preset against the current definition.
- A missing fragment or a host upgrade that breaks parsing leaves the preset unavailable while the tools keep
  working and no default is forced; regenerate the fragment and restart the host to recover.
- Not finding an `ops-ptc` preset row in the plugin manager is by design; do not add a declaration by hand.
- Existing sessions keep the composition they already bound; changing the default only affects sessions created
  afterwards.

## Differences from the official PTC preset

| Item | Official PTC (`ptc`) | OPS PTC (`ops-ptc`) |
| --- | --- | --- |
| Preset declaration | `dsh-web-app` bundle's `presets/ptc.patch.yml` | registered at runtime by `dsh-ops` at apply time; definition from the shipped `presets/ops-ptc.patch.yml` fragment |
| Plugin-manager row | a dedicated preset row | no preset row; lives and dies with the `dsh-ops` row |
| Publication surface | official PTC tools | same as the `ptc` section: `run_code` under real PTC presentation plus the same-stack typed SDK file tools |
| Compaction | official `compaction-basic` | official `compaction-basic` as well; no `dsh-compress-codex` |
| Batch-call guidance | none | `batchingGuidance`: code default false, packaged `ops-ptc` section true; once at session start plus once after three consecutive writes to one path in a turn, with the text in the editable `prompts/batching-guidance.md` |
| Single-row section | `ptc` | `ops-ptc` (same keys plus `batchingGuidance`) |
| Default preset | decided by the host/operator | forced to `ops-ptc` at runtime by `global.forceDefaultOpsPtc` (on by default); restored when turned off or the row is disabled |
| Ordering | order 2 | order 6, sorted after the official rows |

Having both modes over one tool surface is the point of the contrast arm: `ptc` keeps the official preset
unchanged, while `ops-ptc` uses the same APIs and compaction policy and only adds a switchable batch-call
guidance. See the OPS PTC mode section of the [configuration reference](configuration-reference.md) for trigger
conditions, delivery and how to edit the text file.

## See also

- [Configuration reference](configuration-reference.md) — every key and default of the `ops-ptc` section
- [Component reference](component-reference.md) — the `dsh-ops/mode-ops-ptc` legacy row versus the merged section
- [Dynamic tool directory](dynamic-tool-directory.md) — `dynamicTools` and next-turn visibility of `ops_load_sdk`
