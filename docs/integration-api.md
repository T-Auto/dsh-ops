# OPS Integration API

English | [中文](集成接口.md)

This document describes the opt-in preset integration exported as `dsh-ops/integration`.
Installing OPS or importing the module publishes nothing. The preset owner must mount one
integration inside its own composition, or provide an explicit preset id.

## Minimal Native integration

```js
import { integration } from 'dsh-ops/integration'
export default integration({ preset: 'acme-chat' })
```

The default publishes the resident Native file surface and an `ops_discover_tools` entry for
that exact preset. It does not replace official tools or publish Bash. Sibling preset compositions
remain unchanged; the parent-child boundary below still applies.
Selection activates only reviewed OPS capabilities and takes effect on the next model step.

## Detailed configuration

```js
integration({
  preset: 'acme-chat',
  files: true,
  shell: true,
  presentation: 'native',
  discovery: true,
  allowedTools: ['stat', 'grep', 'read_files'],
  alwaysLoaded: ['stat'],
  replaceOfficial: false,
  promptPolicy: true,
  extraGuidance: 'Use OPS for bounded repository inspection.',
})
```

`files`, `shell`, discovery, prompt guidance, and official replacement are independent choices.
`alwaysLoaded` must be a subset of `allowedTools`; unknown keys and unavailable capabilities fail
synchronously. The `shell` choice publishes `ops_bash` only where the host and authorization
permit it. Bash is resident, not a discovery choice.

## Complete option defaults and precedence

Explicit keys override the selected profile; `profile` defaults to `native`. Profile defaults are:

| Profile | files | shell | presentation | discovery |
| --- | --- | --- | --- | --- |
| native | true | false | native | true |
| ptc | true | false | ptc | true |
| discovery | false | false | native | true |
| shell | false | true | native | false |

`replaceOfficial` defaults false, `promptPolicy` true, `extraGuidance` empty,
`required` false, `denyCredentialReads` true, and `allowSystemShellFallback` false.
`binaryPath` and `bashPath` default to managed resolution and affect only the corresponding runtime.
`allowedTools` defaults to all loadable APIs when discovery is on, otherwise `[]`;
`alwaysLoaded` defaults `[]` and must be a subset of the allow-list. Native files publish the five
resident read/search/pager tools independently of this advanced list. External arrays all default
`[]`; disabled wins over allowed, and startup names must be allowed and not disabled.
`extraGuidance` is Native-only and is rejected in PTC, rather than silently ignored.
PTC also rejects `denyCredentialReads` overrides (its credential boundary remains enforced).
`bashPath` and `allowSystemShellFallback` require `shell: true`.

For only file tools, use `{ preset, discovery: false }`; for only Shell, use
`{ preset, profile: 'shell' }`; for only external tools, use
`{ preset, profile: 'discovery', allowedTools: [], externalTools: ['acme_lookup'] }`.
No configuration changes the host's own presentation or permission policy.

## Diagnostics and compatibility

The integration adds `ops_status` for current scoped diagnostics; see [diagnostics](diagnostics.md).
The bundled discovery row now serves built-in/headless compositions only. Unknown custom presets
must explicitly opt in; this intentionally removes the previous accidental global discovery entry.
Existing component exports remain available with their documented legacy semantics; do not use
private `lib/*` paths as public API. Existing headless/no-preset Standard fallback remains supported.

## PTC

Use `profile: 'ptc'` only when the host presents the selected preset as actual PTC (`run_code` plus
the `tools:ptc-only` section). `files: false` is invalid. `discovery: false` removes the typed SDK
loader, while the PTC resident contracts remain. OPS currently does **not** expose a third-party
PTC provider/SDK registration contract; Native provider integration must not be described as one.

## Lifecycle and ownership

The binding is scoped to the mounting composition and exact preset id. Sibling compositions remain
unchanged. Mount at the preset composition scope and do not place unrelated preset compositions
beneath it: the host inherits ancestor registrations and restrictions, even across preset ids. An
unrelated child can see unusable inherited OPS definitions, and an ancestor replacement mask can
hide inherited official tools there. A child `allow` cannot lift an ancestor `deny`; child-own tool
registrations are exempt from those masks. OPS execution checks reject another preset's inherited
callbacks, but do not provide schema isolation across this unsupported nesting boundary.
A second binding for the same id and scope is rejected. Dispose the
returned Cordis fiber to withdraw tools, prompt sections, replacements, pending activation and old
callbacks. OPS checks binding, scope, presentation and current host authority at execution time; the
provider remains responsible for its own code and authorization.

Official tools are kept unless `replaceOfficial: true`, and a replacement is hidden only while its
OPS counterpart is actually visible. A missing worker or failed publication therefore leaves the
official tool available. Compatibility mode still lifts replacements without unloading OPS.

## External advanced tools

See [External Native provider contract](external-provider.md). Plugins register reviewed metadata,
parameters, result schema/rendering and a mandatory authorization callback through
`registerNativeCapability`. Presets explicitly allow names using `externalTools` (default `[]`),
optionally select `externalAlwaysLoaded`, and deny names using `externalDisabled`. Pure external
Native discovery needs no OPS worker, file component, Bash or subprocess service. External PTC
SDK registration is not supported.
