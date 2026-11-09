import { assert, test, report } from './lib/harness.mjs'
import { ownsScopeContext } from '../lib/publication/registrar.js'

await test('a scope owns exactly its own context object, whatever module instance read the tag', () => {
  const ctx = { name: 'agent-ctx' }
  const agent = { ctx }
  // The host tags contexts with a Symbol minted by its copy of @deepseek-ai/dsh-scope.
  // A second copy of that package cannot read the tag, so identity must not depend on it.
  assert.equal(ownsScopeContext(ctx, agent), true, 'the scope\'s own context is accepted')
  assert.equal(ownsScopeContext({ name: 'other' }, agent), false, 'a foreign context is rejected')
  assert.equal(ownsScopeContext(ctx, { ctx: { name: 'other' } }), false, 'a different owner is rejected')
  assert.equal(ownsScopeContext(ctx, undefined), false, 'an absent scope is rejected')
  assert.equal(ownsScopeContext(ctx, { name: 'agent' }), false, 'an object without ctx never matches')
})

report()
