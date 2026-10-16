import fs from 'node:fs'
import path from 'node:path'

export const SEED = 870016

// Every created path is owned explicitly. Cleanup never recursively removes a tree.
export function createFixtures({ parent, scale = 1 }) {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10) throw new Error('scale must be > 0 and <= 10')
  const root = fs.mkdtempSync(path.join(parent, 'dsh-ops-file-bench-'))
  const owned = { root, files: new Set(), directories: new Set([root]), cases: [] }
  const mkdir = directory => {
    if (owned.directories.has(directory)) return
    mkdir(path.dirname(directory))
    fs.mkdirSync(directory)
    owned.directories.add(directory)
  }
  const write = (relative, data) => {
    const file = path.join(root, relative)
    mkdir(path.dirname(file))
    fs.writeFileSync(file, data, { flag: 'wx' })
    owned.files.add(file)
  }
  const count = n => Math.max(1, Math.round(n * scale))
  const add = (fixture, id, tool, args, extra = {}) => owned.cases.push({ fixture, id, tool, args: { path: path.join(root, fixture), ...args }, ...extra })
  let seed = SEED
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  try {
    for (const fixture of ['small-files', 'deep-tree']) {
      for (let i = 0; i < count(10000); i++) {
        const content = Buffer.alloc(4096, 97 + random() % 26)
        content[4095] = 10
        const branch = `d${String(Math.floor(i / 100)).padStart(3, '0')}`
        const directory = fixture === 'deep-tree' ? [...Array(31).fill('d'), branch].join('/') : branch
        write(`${fixture}/${directory}/f${String(i).padStart(5, '0')}.txt`, content)
      }
    }
    for (let i = 0; i < count(100); i++) {
      for (const excluded of ['node_modules', '.hidden', 'target', '.venv']) {
        write(`small-files/d${String(i).padStart(3, '0')}/${excluded}/excluded.txt`, 'needle\n')
      }
    }
    add('small-files', 'grep-miss', 'grep', { pattern: 'BENCH_NEVER_PRESENT_87', outputMode: 'summary' })
    add('small-files', 'glob', 'glob', { pattern: ['**/*.txt', '!**/absent/**'], outputMode: 'paths', sort: 'path', limit: 100 })
    add('deep-tree', 'grep-miss', 'grep', { pattern: 'BENCH_NEVER_PRESENT_87', outputMode: 'summary' })

    write('big-file/large.txt', Buffer.alloc(33 * 1024 * 1024, 120))
    for (let i = 0; i < 4; i++) write(`big-file/small-${i}.txt`, 'ordinary text\nneedle\n')
    add('big-file', 'grep', 'grep', { pattern: 'needle', outputMode: 'summary' })
    add('big-file', 'inspect-oversize', 'inspect_local_file', { path: path.join(root, 'big-file/large.txt'), view: 'hex', offset: 1, limit: 2 }, { expectedError: 'OUTPUT_LIMIT' })
    // An accepted file is also necessary: rejecting 33 MiB alone cannot measure hex window reads.
    write('big-file/window.txt', Buffer.alloc(8 * 1024 * 1024, 65))
    add('big-file', 'inspect-window', 'inspect_local_file', { path: path.join(root, 'big-file/window.txt'), view: 'hex', offset: 1, limit: 2 })

    for (let i = 0; i < count(200); i++) write(`dense-hits/f${String(i).padStart(4, '0')}.txt`, 'needle needle 中文\n'.repeat(256))
    for (const outputMode of ['summary', 'count', 'content']) add('dense-hits', outputMode, 'grep', { pattern: 'needle', outputMode, limit: 10 })
    add('dense-hits', 'content-offset', 'grep', { pattern: 'needle', outputMode: 'content', offset: 128, limit: 10, beforeContext: 1, afterContext: 1 })

    write('edge-text/long.txt', 'needle ' + 'x'.repeat(1024 * 1024 - 7) + '\n')
    write('edge-text/unicode.txt', '\uFEFFneedle 中文 "引号" \\ \t \u0000\r\nneedle 第二行\r\n')
    write('edge-text/invalid.txt', Buffer.concat([Buffer.from('needle\n'), Buffer.from([0xff])]))
    write('edge-text/boundary.txt', 'x'.repeat(4095) + '中文 needle\n')
    for (const [id, file] of [['long-line', 'long.txt'], ['unicode', 'unicode.txt'], ['invalid-utf8', 'invalid.txt'], ['utf8-boundary', 'boundary.txt']]) {
      add('edge-text', id, 'grep', { path: path.join(root, 'edge-text', file), pattern: 'needle', outputMode: 'content', limit: 1 })
    }
    return owned
  } catch (error) {
    cleanupOwned(owned)
    throw error
  }
}

export function cleanupOwned(owned) {
  const files = [], directories = []
  const inventory = directory => {
    if (!owned.directories.has(directory) || fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Unexpected directory during cleanup: ${directory}`)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) inventory(target)
      else if (entry.isFile() && owned.files.has(target)) files.push(target)
      else throw new Error(`Unexpected file during cleanup; leaving fixture intact: ${target}`)
    }
    directories.push(directory)
  }
  inventory(owned.root) // Verify the whole inventory before deleting anything.
  for (const file of files) fs.unlinkSync(file)
  for (const directory of directories) fs.rmdirSync(directory)
}
