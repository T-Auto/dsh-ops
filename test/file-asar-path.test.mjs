/** #836: a path that routes through a real .asar FILE is a virtual directory
 * only inside Electron's own patched filesystem. The standalone worker cannot read
 * archive members, so the refusal must say exactly that instead of a generic
 * no-follow PATH_RESTRICTED. A genuine directory named *.asar keeps traversing. */
import fs from 'node:fs'
import path from 'node:path'
import { assert, test, report, withTempDir } from './lib/harness.mjs'
import { callTool, envelopeOf, requireWorker } from './lib/boundary.mjs'
requireWorker('file-asar-path')
const call = async (tool, args, root, options = {}) =>
  envelopeOf(await callTool(tool, args, { root, readOnly: true, ...options }), assert)

await test('an .asar file component is an archive member, not a traversal bypass', async () => {
  await withTempDir('file-asar-path', async root => {
    fs.writeFileSync(path.join(root, 'bundle.asar'), Buffer.from([4, 0, 0, 0, 16, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef]))
    const inside = await call('inspect_local_file', { path: path.join(root, 'bundle.asar', 'app.js'), limit: 5 }, root)
    assert.equal(inside.error?.code, 'ARCHIVE_MEMBER_UNSUPPORTED', JSON.stringify(inside))
    assert.match(inside.error.message, /bundle\.asar/)
    assert.match(inside.error.message, /archive/i)
    assert.equal(inside.error.effectState, 'none')
    // A real directory keeps working: nothing about the .asar spelling is reserved.
    fs.mkdirSync(path.join(root, 'folder.asar'))
    fs.writeFileSync(path.join(root, 'folder.asar', 'inner.js'), 'real')
    const directory = await call('inspect_local_file', { path: path.join(root, 'folder.asar', 'inner.js'), limit: 5 }, root)
    assert.equal(directory.error, undefined, JSON.stringify(directory))
    assert.equal(directory.items[0].text, 'real')
    // A non-archive file component keeps the ordinary traversal refusal.
    fs.writeFileSync(path.join(root, 'readme.txt'), 'text')
    const plain = await call('inspect_local_file', { path: path.join(root, 'readme.txt', 'inner.js'), limit: 5 }, root)
    assert.equal(plain.error?.code, 'PATH_RESTRICTED', JSON.stringify(plain))
    // The archive itself stays readable as a regular binary file.
    const hex = await call('inspect_local_file', { path: path.join(root, 'bundle.asar'), view: 'hex', limit: 2 }, root)
    assert.equal(hex.error, undefined, JSON.stringify(hex))
    assert.equal(hex.items.length, 1)
  })
})

await test('the installed host archive is diagnosed the same way', async () => {
  await withTempDir('file-asar-host', async root => {
    const archive = 'D:\\deepseek_harness\\resources\\app.asar'
    if (!fs.existsSync(archive)) {
      console.log('  (host archive absent on this machine; live-host assertion not run)')
      return
    }
    const body = await call('inspect_local_file', { path: path.join(archive, 'dsh', 'package.json'), limit: 5 }, root)
    assert.equal(body.error?.code, 'ARCHIVE_MEMBER_UNSUPPORTED', JSON.stringify(body))
    assert.match(body.error.message, /app\.asar/)
  })
})

report('file-asar-path')
