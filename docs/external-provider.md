# External Native provider contract

English | [中文](外部工具提供者.md)

An advanced plugin may opt into OPS discovery without changing OPS source. Mount
`dsh-ops/integration` for the target preset and register its own scoped Native capability:

```js
import { registerNativeCapability } from 'dsh-ops/integration'
export async function apply(ctx) {
  await registerNativeCapability(ctx, {
    search: 'catalogue lookup acme records',
    disclosure: 'on-demand',
    authorize: exec => Boolean(exec.agent?.session?.id),
    definition: {
      name: 'acme_lookup', description: 'Look up one Acme record.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async () => ({ found: false }),
    },
  })
}
```

Names, schemas, renderers and execution remain provider-owned. Names beginning with `ops_` and
`run_code` are reserved. A duplicate name in one scope is rejected. Registration captures a fresh
provider token; unloading aborts active calls and invalidates pending/selected capabilities. A
reinstalled same-name provider does not inherit prior authorization or selection.

Discovery searches provider metadata only. `available` must be a side-effect-free predicate;
selection never invokes `authorize` or `execute`. Selection commits at the next model step. Invocation rechecks scope ownership,
liveness, availability and provider authorization, and aborts when the provider is unloaded. OPS
policy does not sandbox arbitrary third-party code; the provider must own that security boundary.

Set `externalAlwaysLoaded` to publish a provider at startup, `externalDisabled` to deny it, and
`externalTools` to define the allow-list. Provider Native tools keep their original names and are
not converted into typed PTC SDK members. Third-party PTC registration is deliberately not part of
this contract.
