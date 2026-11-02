/**
 * Detection rules for "this shell call writes a download to disk".
 *
 * The cases split into two groups and the second one matters more:
 *
 *   - downloads that must be recognised, including the spellings that are easy
 *     to miss (`-oFILE` with no space, `--output=FILE`, a redirect after a `;`)
 *   - ordinary commands that must stay ALLOWED, because a refusal here breaks a
 *     working session. This group is deliberately larger than the first.
 *
 * Every assertion runs the real detector; there is no mocking, so removing a
 * rule or loosening a guard turns this suite red.
 */
import { strict as assert } from 'node:assert'
import { inspectCommand, inspectSegment, splitSubcommands } from '../lib/download-guard/detect.js'

let checks = 0

/** Assert one command line is recognised as a download with the given rule. */
function fires(command, rule, extra = {}) {
  const hit = inspectCommand(command)
  assert.notEqual(hit, undefined, `expected a hit for ${JSON.stringify(command)}`)
  assert.equal(hit.rule, rule, `rule for ${JSON.stringify(command)}`)
  for (const [key, value] of Object.entries(extra)) {
    assert.equal(hit[key], value, `${key} for ${JSON.stringify(command)}`)
  }
  checks += 1
}

/** Assert one command line is left alone. */
function allows(command) {
  const hit = inspectCommand(command)
  assert.equal(hit, undefined, `expected no hit for ${JSON.stringify(command)}, got ${JSON.stringify(hit)}`)
  checks += 1
}

// --- recognised downloads ---------------------------------------------------

fires('curl -o out.iso https://example.test/a.iso', 'curl-output', {
  url: 'https://example.test/a.iso',
  target: 'out.iso',
})
fires('curl -oFILE https://example.test/a.iso', 'curl-output', { target: 'FILE' })
fires('curl --output out.iso https://example.test/a.iso', 'curl-output', { target: 'out.iso' })
fires('curl --output=out.iso https://example.test/a.iso', 'curl-output', { target: 'out.iso' })
fires('curl -sSL -o out.iso https://example.test/a.iso', 'curl-output', { target: 'out.iso' })
// A repeated -o resolves to the last one, which is the file curl writes.
fires('curl -o first.iso -o second.iso https://example.test/a.iso', 'curl-output', { target: 'second.iso' })
fires('curl -O https://example.test/a.iso', 'curl-remote-name')
fires('curl -sSLO https://example.test/a.iso', 'curl-remote-name')
fires('curl https://example.test/a.iso > out.iso', 'redirect', { target: 'out.iso' })
fires('curl https://example.test/a.iso >> out.iso', 'redirect', { target: 'out.iso' })

fires('wget https://example.test/a.iso', 'wget', { url: 'https://example.test/a.iso' })
fires('wget -O out.iso https://example.test/a.iso', 'wget', { target: 'out.iso' })
fires('wget --output-document=out.iso https://example.test/a.iso', 'wget', { target: 'out.iso' })
fires('wget -q https://example.test/a.iso', 'wget')

fires('Invoke-WebRequest -Uri https://example.test/a.iso -OutFile out.iso', 'Invoke-WebRequest', { target: 'out.iso' })
fires('iwr https://example.test/a.iso -OutFile out.iso', 'Invoke-WebRequest', { target: 'out.iso' })
fires('Invoke-RestMethod https://example.test/a.iso -OutFile out.iso', 'Invoke-RestMethod', { target: 'out.iso' })
fires('Start-BitsTransfer -Source https://example.test/a.iso -Destination out.iso', 'Start-BitsTransfer', { target: 'out.iso' })

// A download after an unrelated command is still found, and a Windows path to
// the executable is recognised by its base name.
fires('cd /tmp && curl -o out.iso https://example.test/a.iso', 'curl-output')
fires('echo start; wget https://example.test/a.iso', 'wget')
fires('C:\\Windows\\System32\\curl.exe -o out.iso https://example.test/a.iso', 'curl-output')
fires('/usr/bin/wget https://example.test/a.iso', 'wget')
// A leading environment assignment is not the command word.
fires('FOO=1 BAR=2 wget https://example.test/a.iso', 'wget')

// --- ordinary commands that must stay allowed -------------------------------

allows('ls -la')
allows('git status')
allows('npm run build')
allows('cat package.json')
allows('grep -rn TODO src/')
allows('node scripts/build.mjs')

// curl that prints to stdout is not a download: no file receives the bytes.
allows('curl https://example.test/api')
allows('curl -s https://example.test/api')
allows('curl -I https://example.test/api')
allows('curl -X POST -d @body.json https://example.test/api')

// The historic false positive: the word "download" in an argument proves
// nothing about whether bytes land on disk.
allows('node download.cjs --help')
allows('node download.cjs')
allows('./download.sh --dry-run')
allows('echo download')
allows('grep -rn "wget" docs/')

// Redirecting *from* is a read, not a write.
allows('sort < input.txt')
allows('cat < input.txt > /dev/null')
allows('command > /dev/null')
allows('node tool.js 2>&1 | tee log.txt')

// PowerShell cmdlets that return objects rather than writing files.
allows('Invoke-RestMethod https://example.test/api')
allows('Invoke-WebRequest https://example.test/api')
allows('iwr https://example.test/api')

// A pipe into something that is not a downloader.
allows('curl https://example.test/api | jq .')
allows('wget -qO- https://example.test/api | head -5')

// --- argument shapes --------------------------------------------------------

assert.deepEqual(splitSubcommands('a; b && c || d | e'), ['a', 'b', 'c', 'd', 'e'])
assert.deepEqual(splitSubcommands('echo "a;b"'), ['echo "a;b"'])
assert.deepEqual(splitSubcommands("echo 'x && y'"), ["echo 'x && y'"])
assert.deepEqual(splitSubcommands('  \n  '), [])
checks += 4

// The detector must not crash on the shapes a tool call can actually carry.
assert.equal(inspectCommand(''), undefined)
assert.equal(inspectCommand(undefined), undefined)
assert.equal(inspectCommand(null), undefined)
assert.equal(inspectCommand(42), undefined)
assert.equal(inspectSegment(''), undefined)
checks += 5

console.log(`PASS download-guard detection: ${checks} checks`)
