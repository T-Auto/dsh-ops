/**
 * The decision layer: detection plus operator configuration becomes a refusal
 * or an allow.
 *
 * The assertions that matter most are the ALLOW ones. A guard that refuses
 * work the operator never asked to change is worse than the slow download it
 * exists to prevent, so an unconfigured install, a template missing the URL
 * placeholder, and a template that cannot fill the file name all have to
 * resolve to "run the command".
 */
import { strict as assert } from 'node:assert'
import { decideDownload, refusalReason, renderForwarder } from '../lib/download-guard/policy.js'
import { inspectCommand } from '../lib/download-guard/detect.js'

let checks = 0

const CMD = 'curl -o out.iso https://example.test/a.iso'
const HIT = inspectCommand(CMD)
const TEMPLATE = 'aria2c -x16 -s16 -o {file} {url}'

assert.notEqual(HIT, undefined, 'precondition: the sample command is detected')

/** Assert a decision kind. */
function decides(hit, config, expected) {
  const decision = decideDownload(hit, config, CMD)
  assert.equal(decision.kind, expected, `expected ${expected}, got ${decision.kind}`)
  checks += 1
}

// --- refuses when properly configured --------------------------------------

decides(HIT, { template: TEMPLATE }, 'deny')

{
  const decision = decideDownload(HIT, { template: TEMPLATE }, CMD)
  assert.equal(decision.info.code, 'DOWNLOAD_TO_FILE')
  assert.equal(decision.info.name, 'DownloadGuardError')
  // The refusal must carry a runnable command, not just a complaint.
  assert.ok(decision.reason.includes('aria2c -x16 -s16 -o out.iso https://example.test/a.iso'))
  // It must also name what was blocked, so the model can tell which call failed.
  assert.ok(decision.reason.includes('out.iso'))
  checks += 3
}

// --- allows in every ambiguous case ----------------------------------------

// No detection, no opinion.
decides(undefined, { template: TEMPLATE }, 'allow')
// No configuration: the operator has not opted in.
decides(HIT, undefined, 'allow')
// Blank template is the same as no configuration.
decides(HIT, { template: '   ' }, 'allow')
// A template without {url} cannot produce a runnable download command.
decides(HIT, { template: 'aria2c {file}' }, 'allow')
// No URL visible in the original command means the template cannot be filled.
decides({ rule: 'wget' }, { template: TEMPLATE }, 'allow')

// --- rendering -------------------------------------------------------------

{
  const rendered = renderForwarder(TEMPLATE, HIT)
  assert.equal(rendered, 'aria2c -x16 -s16 -o out.iso https://example.test/a.iso')
  checks += 1
}
{
  // No target: the file placeholder stays visible rather than being guessed.
  const rendered = renderForwarder(TEMPLATE, { rule: 'curl-remote-name', url: 'https://example.test/a.iso' })
  assert.equal(rendered, 'aria2c -x16 -s16 -o {file} https://example.test/a.iso')
  checks += 1
}
{
  // Paths with spaces are quoted so the suggested command actually runs.
  const rendered = renderForwarder('aria2c -o {file} {url}', {
    rule: 'curl-output',
    url: 'https://example.test/a.iso',
    target: 'C:/Program Files/out.iso',
  })
  assert.ok(rendered.includes("'C:/Program Files/out.iso'"), rendered)
  checks += 1
}
{
  // A URL containing a single quote must not break out of the quoting.
  const rendered = renderForwarder('dl {url}', { rule: 'wget', url: "https://example.test/a'b" })
  assert.ok(!rendered.includes("a'b"), rendered)
  checks += 1
}

// --- the refusal text itself ----------------------------------------------

{
  const longCommand = `curl -o out.iso https://example.test/${'x'.repeat(400)}`
  const reason = refusalReason(HIT, TEMPLATE, longCommand)
  // Long commands are truncated so the refusal stays readable.
  assert.ok(reason.includes('...'))
  // The rule name appears, so the model knows what pattern fired.
  assert.ok(reason.includes('curl-output'))
  checks += 2
}

console.log(`PASS download-guard policy: ${checks} checks`)
