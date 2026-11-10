# Presets and the default mode

English | [中文](预设与默认模式.md)

`ops-ptc` is OPS's fifth enhanced built-in mode. It is not a from-scratch preset but a patch fragment of the
host's official PTC preset: this plugin only enhances presets the host already declares, so `ops-ptc` declares
its own `@deepseek-ai/dsh-agent-preset` row and the single `dsh-ops` row publishes the tool surface through a
section of the same name. This page covers where the fragment comes from, how it is installed, how to make it
the default, and how it differs from the official PTC preset.

## The fragment and the sync script

`presets/ops-ptc.patch.yml` is generated; do not hand-edit it:

- Source: `@deepseek-ai/dsh-web-app/presets/ptc.patch.yml` (the host-shipped official PTC preset).
- Generator: `scripts/sync-preset-ops-ptc.mjs`. It edits the upstream text at anchored lines, so `!!js`
  expressions, comments and their expression form survive byte for byte, then parses the result to self-check.
- The only differences from upstream are identity: the row id becomes `preset-ops-ptc`, and the preset's
  `id` / `name` / `description` / `order` become `ops-ptc` / `OPS (PTC)` / a one-sentence description / `6`
  (order 6 sorts OPS PTC after the official rows). `config.plugins` stays byte for byte
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

## Installation with the package

`presets/` ships with the package (listed in `package.json` `files`) and `dsh.bundle.patch` is an array:

```yaml
dsh:
  bundle:
    patch:
      - ./cordis.patch.yml
      - ./presets/ops-ptc.patch.yml
```

The two patch files are layered in order, so the `ops-ptc` preset row is declared by the bundle layer and shows
up in the host's Agent presets picker without any hand-written YAML. Re-run the generator when a host upgrade
makes the fragment stale.

To merge the fragment into an existing profile by hand, append the `- insert:` entry from
`presets/ops-ptc.patch.yml` to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`; do not insert the same row
twice, since patches match by id and repeated declarations replace rather than merge.

## Making it the default

The `dsh-ops` bundle patch currently ends `cordis.patch.yml` with an id-targeted override that points the
default preset at `ops-ptc`:

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: ops-ptc
    selectedDefault: ops-ptc
```

The packaged bundle layer carries that override, but whether it applies is determined by the
`cordis.patch.yml` actually merged after installation; installation never rewrites a user profile, so a user
override or a settings-page choice wins. Two ways to set it:

- **Bundle layer (packaged default)**: the override above only matches the `agent-preset-registry` row when this
  bundle's patch layer is applied after `dsh-web-app`'s. Profiles that never load that row (headless, for
  example) print one `patch: entry "agent-preset-registry" not found` warning at startup and that entry is
  skipped; it is not fatal.
- **Profile layer (user choice, recommended)**: append the same snippet to
  `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. Profile layers are applied last, so they win over the bundle
  layer; this is also where you switch the default between the official PTC and OPS PTC presets.

Field semantics: `default` is the deployment default used when no user selection exists, while
`selectedDefault` is the volatile user-level default that new sessions resolve over it, and it is what the host's
Agent presets settings page writes. **An id-targeted patch does not deep-merge**: it replaces the matched row's
whole `config`, so restate the other key whenever you change one.

### Risks and rollback

- Declare the preset row before changing the default. The registry resolves recovery sessions against the current
  definition; a missing or failed preset row leaves new sessions unable to use that preset. Removing the override
  (or pointing it back at `standard` / `ptc`) is the rollback.
- Existing sessions keep the composition they already bound; changing the default only affects sessions created
  afterwards. Changing the choice on the settings page likewise writes `selectedDefault`.
- When the host later adds fields to `agent-preset-registry`, the id-targeted override replaces that whole config
  block; that is the main cost of putting the default in the bundle layer. The safer option is to override only in
  your own profile patch and re-check after upgrades.

## Differences from the official PTC preset

| Item | Official PTC (`ptc`) | OPS PTC (`ops-ptc`) |
| --- | --- | --- |
| Preset declaration | `dsh-web-app`'s `presets/ptc.patch.yml` | this package's `presets/ops-ptc.patch.yml` (row id `preset-ops-ptc`) |
| Publication surface | official PTC tools | same as the `ptc` section: `run_code` under real PTC presentation plus the same-stack typed SDK file tools |
| Compaction | official `compaction-basic` | official `compaction-basic` as well; no `dsh-compress-codex` |
| Batch-call guidance | none | `batchingGuidance`: code default false, packaged `ops-ptc` section true; can be turned off in YAML |
| Single-row section | `ptc` | `ops-ptc` (same keys plus `batchingGuidance`) |
| Ordering | order 2 | order 6, sorted last |

Having both modes over one tool surface is the point of the contrast arm: `ptc` keeps the official preset
unchanged, while `ops-ptc` uses the same APIs and compaction policy and only adds a switchable batch-call
guidance. The guidance is injected once after three consecutive writes to one normalized path in a turn, rides
the tool result's deferred context, and never touches the system prompt prefix. See the OPS PTC mode section of
the [configuration reference](configuration-reference.md) for the switch and trigger details.

## See also

- [Configuration reference](configuration-reference.md) — every key and default of the `ops-ptc` section
- [Component reference](component-reference.md) — the `dsh-ops/mode-ops-ptc` legacy row versus the merged section
- [Dynamic tool directory](dynamic-tool-directory.md) — `dynamicTools` and next-turn visibility of `ops_load_sdk`
