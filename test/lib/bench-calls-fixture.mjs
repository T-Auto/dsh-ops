import fs from 'node:fs'
import path from 'node:path'

// Tiny independent builds exercise real host dispatch without a Rust build or large corpus.
export function pluginFixture(root, label, log, { fail = false } = {}) {
  const worker = path.join(root, 'native', 'target', 'release', process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker')
  const files = {
    'package.json': JSON.stringify({ type: 'module', name: 'dsh-ops', version: label }),
    'lib/policy.js': `export const publicToolName = name => ${JSON.stringify(label + '_')} + name`,
    'lib/components/discovery/index.js': 'export function apply() {}',
    'lib/components/file/index.js': `
      import fs from 'node:fs'
      import { publicToolName } from '../../policy.js'
      export const inject = ['tools']
      export function apply(ctx, config) {
        const log = ${JSON.stringify(log)}
        const label = ${JSON.stringify(label)}
        ctx.effect(() => () => fs.appendFileSync(log, JSON.stringify({ closed: label }) + '\\n'))
        for (const name of ['grep', 'glob']) ctx.tools.register({
          name: publicToolName(name), description: 'fixture search',
          parameters: { type: 'object', properties: { pattern: {}, path: { type: 'string' } } },
          output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: label }] },
          execute: async args => {
            fs.appendFileSync(log, JSON.stringify({ label, pid: process.pid, worker: config.binaryPath, args }) + '\\n')
            if (${JSON.stringify(fail)} === true) throw new Error('fixture failure')
            if (typeof ${JSON.stringify(fail)} === 'string') return { status: ${JSON.stringify(fail)}, error: { code: 'INVALID_ARGUMENT', message: 'Unknown capability', effectState: 'none' } }
            return {}
          },
        })
      }
    `,
  }
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }
  fs.mkdirSync(path.dirname(worker), { recursive: true })
  fs.writeFileSync(worker, label)
  return { root, worker }
}

export function corpusFixture(root) {
  const tree = path.join(root, 'corpus')
  fs.mkdirSync(tree)
  fs.writeFileSync(path.join(tree, 'hello.txt'), 'hello\n')
  const manifest = { id: 'tiny', roots: [tree], identity: { sample: 1 },
    cases: [{ id: 'grep-miss', tool: 'grep', args: { pattern: 'needle', path: '.' } }] }
  const file = path.join(root, 'tiny.json')
  fs.writeFileSync(file, JSON.stringify(manifest))
  return { ...manifest, file }
}
