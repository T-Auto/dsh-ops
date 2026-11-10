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

## Making it the default preset

The bundle no longer overrides `agent-preset-registry`: `dsh.bundle.patch` is only `./cordis.patch.yml`, and
that file only inserts the single `dsh-ops` row. The default preset is decided by the host/operator in one of
two ways:

- **Host Agent presets settings page**: selecting `ops-ptc` persists `selectedDefault` (the volatile user-level
  default, resolved before the deployment `default` for new sessions).
- **Explicit profile patch** (paste into `$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: ops-ptc
    selectedDefault: ops-ptc
```

`default` is the deployment default used when no user selection exists; `selectedDefault` is the user-level
default new sessions resolve first, and it is what the settings page writes. **An id-targeted patch does not
deep-merge**: it replaces the matched row's whole `config`, so restate both keys. A profile without the
`dsh-web-app` bundle never loads the `agent-preset-registry` row: the patch prints one non-fatal
`patch: entry "agent-preset-registry" not found` and is skipped, the settings page does not exist, and the
default comes from that profile's own composition.

### Risks and rollback

- **Switch the default first, then disable `dsh-ops`.** The preset is registered at plugin runtime: disabling or
  unloading the `dsh-ops` row releases the registration. Existing sessions keep their composition, but while the
  default still points at `ops-ptc` **new sessions cannot find that preset** (recovery resolves against the
  current definition and fails). The correct order is to switch the default back to `standard`, `ptc` or
  another registered preset first, then disable the plugin; re-enable it and switch back afterwards.
- A missing fragment or a host upgrade that breaks parsing leaves the preset unavailable while the tools keep
  working; regenerate the fragment and restart the host to recover.
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
| Ordering | order 2 | order 6, sorted after the official rows |

Having both modes over one tool surface is the point of the contrast arm: `ptc` keeps the official preset
unchanged, while `ops-ptc` uses the same APIs and compaction policy and only adds a switchable batch-call
guidance. See the OPS PTC mode section of the [configuration reference](configuration-reference.md) for trigger
conditions, delivery and how to edit the text file.

## See also

- [Configuration reference](configuration-reference.md) — every key and default of the `ops-ptc` section
- [Component reference](component-reference.md) — the `dsh-ops/mode-ops-ptc` legacy row versus the merged section
- [Dynamic tool directory](dynamic-tool-directory.md) — `dynamicTools` and next-turn visibility of `ops_load_sdk`
