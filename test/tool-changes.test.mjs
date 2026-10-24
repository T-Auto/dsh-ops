import { assert, test, report } from './lib/harness.mjs'
import { toolChangeScopes, withToolChange } from '../lib/tool-changes.js'
await test('scope attribution is synchronous, nested global changes stay conservative, and throws restore the outer scope', () => {
  const a={}, b={}
  assert.equal(toolChangeScopes(),undefined)
  withToolChange([a],()=>{
    assert.deepEqual(toolChangeScopes(),[a])
    withToolChange([b],()=>assert.deepEqual(toolChangeScopes(),[a,b]))
    withToolChange([],()=>{
      assert.deepEqual(toolChangeScopes(),[])
      withToolChange([b],()=>assert.deepEqual(toolChangeScopes(),[]))
    })
    assert.throws(()=>withToolChange([b],()=>{throw new Error('cleanup')}),/cleanup/)
    assert.deepEqual(toolChangeScopes(),[a])
  })
  assert.equal(toolChangeScopes(),undefined)
})
report('tool-changes')
