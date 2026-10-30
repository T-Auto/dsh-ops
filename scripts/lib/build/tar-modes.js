/** Preserve the npm tar stream verbatim except Unix worker mode/checksum fields. */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync, gunzipSync } from 'node:zlib'
import { npm, npmInvocation } from './util.js'

// Reuse the tar implementation shipped with the npm that performs our pack.
// Fail closed if a nonstandard npm installation does not expose its dependency.
const invocation = npmInvocation([])
const npmCli = invocation.args[0] ?? process.env.npm_execpath
  ?? path.join(npm(['root', '--global']).stdout.trim(), 'npm', 'bin', 'npm-cli.js')
if (!path.isAbsolute(npmCli) || !fs.existsSync(npmCli)) throw new Error('Cannot locate npm bundled tar library')
export const tar = createRequire(npmCli)('tar')
export const UNIX_WORKERS = ['linux-x64', 'darwin-arm64', 'darwin-x64']
  .map(platform => `package/runtime/${platform}/dsh-ops-worker`)
const WINDOWS_WORKER = 'package/runtime/win32-x64/dsh-ops-worker.exe'
const WORKERS = [...UNIX_WORKERS, WINDOWS_WORKER]

/** Parse without extraction; reject ambiguous, unsafe or incomplete runtime archives. */
export async function checkUnixWorkerModes(file, { requireModes = true } = {}) {
  const seen = new Set()
  tar.list({ file, sync: true, strict: true, onentry(entry) {
    const name = entry.path
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.')) {
      throw new Error(`Unsafe tar member: ${name}`)
    }
    if (seen.has(name)) throw new Error(`Duplicate tar member: ${name}`)
    seen.add(name)
    if (name.startsWith('package/runtime/') && /[/]dsh-ops-worker(?:[.]exe)?$/u.test(name) && !WORKERS.includes(name)) {
      throw new Error(`Unexpected runtime worker: ${name}`)
    }
    if (!WORKERS.includes(name)) return
    if (entry.type !== 'File' || entry.size === 0) throw new Error(`Invalid worker member: ${name}`)
    if (requireModes && UNIX_WORKERS.includes(name) && entry.mode !== 0o755) {
      throw new Error(`Unix worker must have TAR mode 0755: ${name}`)
    }
  } })
  for (const name of WORKERS) if (!seen.has(name)) throw new Error(`Missing worker member: ${name}`)
}

/** Only three mode fields and their checksums may differ in the decompressed tar. */
export async function fixUnixWorkerModes(file) {
  await checkUnixWorkerModes(file, { requireModes: false })
  const original = fs.readFileSync(file)
  const input = gunzipSync(original)
  const output = Buffer.from(input)
  const fixed = new Set()
  for (let offset = 0; offset + 512 <= input.length;) {
    const block = input.subarray(offset, offset + 512)
    if (block.every(byte => byte === 0)) break
    const header = new tar.Header(block)
    if (!header.cksumValid || !Number.isSafeInteger(header.size) || header.size < 0) throw new Error('Invalid TAR header')
    if (UNIX_WORKERS.includes(header.path)) {
      if (header.type !== 'File' || fixed.has(header.path)) throw new Error('Ambiguous worker TAR header')
      fixed.add(header.path)
      output.write('0000755\0', offset + 100, 8, 'ascii')
      output.fill(32, offset + 148, offset + 156)
      const checksum = output.subarray(offset, offset + 512).reduce((sum, byte) => sum + byte, 0)
      output.write(checksum.toString(8).padStart(6, '0') + '\0 ', offset + 148, 8, 'ascii')
      // No other header, metadata, padding, ordering or payload bytes are changed.
      const restored = Buffer.from(output.subarray(offset, offset + 512))
      block.copy(restored, 100, 100, 108)
      block.copy(restored, 148, 148, 156)
      if (!restored.equals(block)) throw new Error('Unexpected TAR header mutation')
    }
    offset += 512 + Math.ceil(header.size / 512) * 512
    if (offset > input.length) throw new Error('Truncated TAR payload')
  }
  if (fixed.size !== UNIX_WORKERS.length) throw new Error('Worker headers must be ordinary, unambiguous TAR members')
  if (output.equals(input)) return
  const temporary = file + '.modes-' + process.pid
  let created = false
  try {
    fs.writeFileSync(temporary, gzipSync(output), { flag: 'wx' })
    created = true
    await checkUnixWorkerModes(temporary)
    fs.renameSync(temporary, file)
  } finally {
    if (created) fs.rmSync(temporary, { force: true })
  }
}
