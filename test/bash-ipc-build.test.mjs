import { bashIpcBuildBatch } from '../bin/lib/bash-ipc-command.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assert, test, report, withTempDir } from './lib/harness.mjs'

await test('IPC batch keeps non-ASCII paths in Unicode environment values, never batch bytes', () => {
  const paths = { vcvars: 'C:\\工具 空间\\vcvars64.bat', scratch: 'D:\\缓存 !\\tmp', sourceDirectory: 'E:\\中文路径\\native\\bash-ipc' }
  const result = bashIpcBuildBatch({ ...paths, names: ['opsipc', 'opsnt'] })
  assert.match(result.text, /^[\x00-\x7f]*$/)
  for (const value of Object.values(paths)) assert.equal(result.text.includes(value), false)
  assert.deepEqual(result.env, { DSH_OPS_IPC_VCVARS: paths.vcvars, DSH_OPS_IPC_SCRATCH: paths.scratch, DSH_OPS_IPC_SOURCES: paths.sourceDirectory })
  assert.match(result.text, /DisableDelayedExpansion/)
  assert.throws(() => bashIpcBuildBatch({ ...paths, names: ['injected&name'] }), /Unknown IPC proxy/)
})
if (process.platform === 'win32') await test('real cmd finds Unicode environment paths with a non-UTF8 code page', () => withTempDir('ipc-cmd', root => {
  const directory = path.join(root, '中文 空间 !')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'opsipc.cpp'), 'fixture')
  const batch = bashIpcBuildBatch({ vcvars: path.join(directory, 'vcvars64.bat'), scratch: directory, sourceDirectory: directory, names: [] })
  fs.writeFileSync(batch.env.DSH_OPS_IPC_VCVARS, '@exit /b 0\r\n', 'ascii')
  const file = path.join(root, 'probe.cmd')
  fs.writeFileSync(file, 'chcp 936 >nul\r\n' + batch.text + 'if not exist "%DSH_OPS_IPC_SOURCES%\\opsipc.cpp" exit /b 42\r\necho FOUND\r\n', 'ascii')
  const result = spawnSync('cmd.exe', ['/d', '/c', file], { env: { ...process.env, ...batch.env }, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /FOUND/)
}))
else console.log('  Windows cmd fixture unavailable: non-Windows host; no round-trip check counted')
report('bash-ipc-build')
