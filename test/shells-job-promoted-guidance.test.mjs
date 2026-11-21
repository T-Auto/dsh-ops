/**
 * The promoted Bash render is the model's decision point for a command that
 * outlived its foreground timeout (#814): job_output and job_kill are the only
 * two handles left, and a job kill at the host layer terminates the whole
 * process tree. The defect behind the issue lives in the host's subprocess and
 * job layer (an inherited pipe keeps a daemon inside the tree, and a tree kill
 * takes out daemons the command started, e.g. an adb server); this repository
 * cannot fix the host, so its render must at least state what a job kill
 * reaches and how to keep daemons out of the blast radius.
 */
import { assert, test, report } from './lib/harness.mjs'
import { renderHostBash } from '../lib/shells/host-contract.js'

await test('the promoted render states that job_kill terminates the whole process tree', () => {
  const value = {
    kind: 'promoted', jobId: 'job-7', label: 'adb start-server', timeoutMs: 120000,
    output: '* daemon not running; starting it now',
  }
  const text = renderHostBash(value)
  // The existing handles stay named, and the moved-to-job line keeps its shape.
  assert.match(text, /still running after 120000ms; moved to background job job-7/)
  assert.match(text, /job_output/)
  assert.match(text, /job_kill/)
  // #814: the render must say what a job kill reaches before the model uses it.
  assert.match(text, /whole process tree/)
  // ... and which victims that implies, plus how to avoid them next time.
  assert.match(text, /daemon/)
  assert.match(text, /run_in_background/)
})

await test('the background render keeps its exact one-line shape', () => {
  const text = renderHostBash({ kind: 'background', jobId: 'j-1', label: 'watcher' })
  assert.equal(text, 'started background job j-1 (\"watcher\")')
})

report('shells-job-promoted-guidance')
