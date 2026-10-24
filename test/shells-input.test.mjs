import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { privateRuntimePath } from '../lib/bash-ipc.js'
import { pinnedBashExecutable } from '../lib/shells/pinned.js'
import { bashToolDefinition } from '../lib/shells/tool.js'
import { assert, report, test, withTempDir } from './lib/harness.mjs'
import { bootHost, shutdown } from './lib/host.mjs'

const bash = process.platform === 'win32'
  ? pinnedBashExecutable({ file: process.env.DSH_OPS_TEST_BASH }) : '/bin/bash'

await test('private MSYS PATH preserves caller tool precedence after required usr/bin (#364)', async () => {
  await withTempDir('shell-path', async root => {
    const caller = path.join(root, 'caller tools'), runtime = path.join(root, 'runtime')
    for (const directory of [caller, ...['usr/bin', 'ucrt64/bin', 'cmd'].map(part => path.join(runtime, part))]) {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'ops-path-probe'), 'exit 0\n', { mode: 0o755 })
    }
    fs.unlinkSync(path.join(runtime, 'usr/bin/ops-path-probe'))
    const env = { ...process.env, PATH: privateRuntimePath(runtime, caller) }
    const locate = () => {
      const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'command -v ops-path-probe'], { env, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim().replaceAll('\\', '/')
    }
    assert.match(locate(), /\/caller tools\/ops-path-probe$/, 'caller tool must precede optional bundled programs')
    fs.writeFileSync(path.join(runtime, 'usr/bin/ops-path-probe'), 'exit 0\n', { mode: 0o755 })
    assert.match(locate(), /\/runtime\/usr\/bin\/ops-path-probe$/, 'required private MSYS directory stays first')
    assert.equal(privateRuntimePath(runtime, '').split(path.delimiter).includes(''), false, 'do not add current-directory lookup when inherited PATH is empty')
  })
})

await test('Bash receives a closed empty pipe and observes EOF without reading Windows NUL (#372)', async () => {
  await withTempDir('shell-stdin', async root => {
    const { ctx } = await bootHost()
    try {
      await ctx.plugin(Subprocess)
      const definition = bashToolDefinition({ file: bash, source: 'config', subprocess: ctx.get('subprocess') })
      const result = await definition.execute({
        command: "if [[ -p /dev/stdin ]]; then printf pipe; elif [[ -S /dev/stdin ]]; then printf socket; else printf device; fi; IFS= read -r line; printf ':%s' \"$?\"",
        workdir: root, timeoutMs: 10_000,
      })
      assert.equal(result.status, 'completed', JSON.stringify(result))
      // Node's POSIX stdio 'pipe' can be a Unix socket; both are distinct from /dev/null.
      if (process.platform === 'win32') assert.equal(result.stdout.text, 'pipe:1', 'MSYS fd 0 must be a pipe already at EOF')
      else assert.match(result.stdout.text, /^(pipe|socket):1$/, 'POSIX batch input must be a stream already at EOF')
      assert.equal(result.stderr.text, '')
      const script = path.join(root, 'empty-input.sh')
      fs.writeFileSync(script, "IFS= read -r line; printf 'eof:%s' \"$?\"\n")
      const scripted = await definition.execute({ script_path: script, workdir: root, timeoutMs: 10_000 })
      assert.equal(scripted.status, 'completed', JSON.stringify(scripted))
      assert.equal(scripted.stdout.text, 'eof:1', 'script_path must also see immediate EOF')
    } finally { await shutdown(ctx) }
  })
})
report('shells-input')
