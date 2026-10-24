import { parseArgs } from 'node:util'
import { renderSnapshot, reviewSnapshot } from './snapshot.js'

export async function commandReview(args: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      repo: { type: 'string' }, prs: { type: 'string' }, base: { type: 'string' }, workflow: { type: 'string' }, checkout: { type: 'string' },
    } })
    if (positionals.length !== 1 || positionals[0] !== 'snapshot') throw new Error('Expected review snapshot --repo owner/name --prs 1,2 [--base main] [--checkout path]')
    const result = await reviewSnapshot({ repo: values.repo ?? '', prs: (values.prs ?? '').split(',').map(Number), base: values.base, workflow: values.workflow, checkout: values.checkout })
    console.log(renderSnapshot(result))
    return result.status === 'completed' && Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024 ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', error: { code: 'REVIEW_SNAPSHOT_UNAVAILABLE', message: String(error instanceof Error ? error.message : error).slice(0, 500) } }))
    return 1
  }
}
