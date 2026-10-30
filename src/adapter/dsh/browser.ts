/**
 * The adapter's browser facet: the only place the client half names a DSH module
 * that resolves to a value.
 *
 * `types.ts` stays type-only so importing the adapter never evaluates a DSH
 * package; the browser half needs the Host's native controls as values, so that
 * one seam lives here and nowhere else. `test/adapter-boundary.test.mjs` fails if
 * another source file imports `@deepseek-ai/*` directly, and checks that this
 * module exports nothing but the primitives module.
 */
export { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
