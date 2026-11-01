import { assert, test, report } from './lib/harness.mjs'
import { inspectCommand } from '../lib/download-guard/detect.js'
import { decideDownload, renderForwarder } from '../lib/download-guard/policy.js'
import { resolveConfig } from '../lib/config.js'

await test('stdout, discarded output, quoted text and script bodies are not disk download calls', () => {
  for (const command of [
    'wget -O - https://example.test/a', 'wget --output-document=- https://example.test/a',
    'wget -O "-" https://example.test/a', 'curl -o /dev/null https://example.test/a',
    'curl -o NUL https://example.test/a', 'curl -o "-" https://example.test/a',
    'curl -w "status > note.txt" https://example.test/a',
    "cat <<'EOF'\ncurl -o file https://example.test/a\nEOF",
    '# example only\ncurl --help -o file https://example.test/a',
    'wget --spider https://example.test/a',
  ]) assert.equal(inspectCommand(command), undefined, command)
})
await test('literal quoted targets are unquoted once and PowerShell flags ignore case', () => {
  assert.equal(inspectCommand('curl -o "a b.iso" "https://example.test/a?q=1&b=2"').target, 'a b.iso')
  assert.equal(inspectCommand('Invoke-WebRequest https://example.test/a -outfile "a b.iso"').target, 'a b.iso')
})
await test('a refusal requires every template argument and never invents a URL or output path', () => {
  assert.equal(decideDownload({ rule: 'wget', url: 'https://example.test/a' }, { template: 'fetch {url} {file}' }, '').kind, 'allow')
  assert.equal(inspectCommand('curl -o file --header "Referer: https://example.test/a" "$URL"'), undefined)
  assert.equal(inspectCommand('curl -o file https://example.test/a https://example.test/b'), undefined)
})
await test('template placeholders cannot be embedded inside shell quotes', () => {
  assert.throws(() => resolveConfig({ downloadGuard: { template: 'fetch "{url}"' } }), /unquoted|standalone/)
  assert.throws(() => resolveConfig({ downloadGuard: { template: 'fetch prefix{url}' } }), /unquoted|standalone/)
  assert.throws(() => resolveConfig({ downloadGuard: { template: 'fetch "before {url} after"' } }), /unquoted|standalone/)
  assert.throws(() => resolveConfig({ downloadGuard: { template: 'fetch "before {url}' } }), /unquoted|balanced/)
})
await test('PowerShell alternatives quote an apostrophe as literal data', () => {
  const config = resolveConfig({ downloadGuard: { template: 'fetch {url}', shell: 'pwsh' } })
  assert.equal(config.downloadGuard.shell, 'pwsh')
  assert.equal(renderForwarder('fetch {url}', { rule: 'wget', url: "https://example.test/a'b" }, 'pwsh'), "fetch 'https://example.test/a''b'")
  assert.equal(renderForwarder('fetch {url} {file}', { rule: 'wget', url: 'https://example.test/{file}', target: 'out' }), "fetch 'https://example.test/{file}' out")
})
report('download-guard-edge')
