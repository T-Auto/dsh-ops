/** Check the actual npm archive against the frozen payload inventory, not npm's file count. */
import { createHash } from 'node:crypto'
import { NIUBASH_PIN, NIUBASH_PACKAGE_PATH, NIUBASH_RECEIPT } from '../../../lib/cli/niubash-payload.js'
import { tar } from './tar-modes.js'

export function checkNiubashTarball(file) {
  const prefix = `package/${NIUBASH_PACKAGE_PATH}/`
  const seen = new Set()
  let receipt = false
  tar.list({ file, sync: true, strict: true, onentry(entry) {
    if (!entry.path.startsWith(prefix)) return
    const name = entry.path.slice(prefix.length).replace(/\/$/u, '')
    if (!name && entry.type === 'Directory') return
    if (entry.type === 'Directory') {
      if (!NIUBASH_PIN.directories.includes(name)) throw Error(`Unknown packed Niubash directory: ${name}`)
      return
    }
    if (seen.has(name) || entry.type !== 'File') throw Error(`Ambiguous packed Niubash member: ${name}`)
    seen.add(name)
    if (name === NIUBASH_RECEIPT) {
      const chunks = []
      entry.on('data', chunk => chunks.push(chunk))
      entry.on('end', () => {
        const record = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (record.version !== 1 || record.archiveSha256 !== NIUBASH_PIN.archiveSha256
          || record.upstreamVersion !== NIUBASH_PIN.upstreamVersion
          || record.executableSha256 !== NIUBASH_PIN.executableSha256
          || JSON.stringify(record.files) !== JSON.stringify(NIUBASH_PIN.files)
          || JSON.stringify(record.sizes) !== JSON.stringify(NIUBASH_PIN.sizes)) throw Error('Invalid packed Niubash provenance')
        receipt = true
      })
      return
    }
    if (!Object.hasOwn(NIUBASH_PIN.files, name) || entry.size !== NIUBASH_PIN.sizes[name]) {
      throw Error(`Unexpected or invalid packed Niubash member: ${name}`)
    }
    const hash = createHash('sha256')
    entry.on('data', chunk => hash.update(chunk))
    entry.on('end', () => {
      if (hash.digest('hex') !== NIUBASH_PIN.files[name]) throw Error(`Packed Niubash checksum mismatch: ${name}`)
    })
  } })
  if (!receipt || seen.size !== Object.keys(NIUBASH_PIN.files).length + 1) throw Error('Incomplete packed Niubash payload')
}
