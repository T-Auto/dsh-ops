/**
 * The `corpus` fixture family: the settlement corpus, where the answer is one
 * amount per shard and no amount can be written without opening its shard.
 * @module dsh-ops/bench/fixtures/corpus
 */

import { mulberry32, pad, pick, randInt, WORDS } from './internal.mjs'

/**
 * The rule sheet `deepCorpus` ships as `README.md`: the only place the precedence
 * between an index page and a ledger page is written down.
 *
 * It is prose on purpose. The model has to read it, then apply it once per shard —
 * the corpus is far too large to carry around, so the rule has to survive as a rule.
 */
const SETTLEMENT_README = `# Settlement corpus

\`shards/shard-NN.md\` is one shard review. Every review carries four sections in
order: \`## Charter\`, \`## Index\`, \`## Ledger\` and \`## Archive\`.

A review's **live settlement** is the single \`SETTLE\` line in its \`## Ledger\` whose
\`page=\` number is the highest page listed in that review's \`## Index\`. A \`SETTLE\`
line whose page is missing from the index is a page carried over from an earlier
settlement run and does not count. Pages listed in the index that have no ledger
line carry no amount.

\`VOID SETTLE\` lines are cancellations. They never count, whatever page they name.

The amount of a live settlement is the \`amount=\` value on that line.
`

/**
 * `deepCorpus` — a 256K-token corpus in which every shard has to be visited
 * (PLAN §7.10).
 *
 * The point is the size of the covered set, not of one file: the answer is one line
 * per shard, and no line can be written without opening its shard, so answering at
 * all costs the whole corpus. At ~256K tokens the "read everything into context"
 * strategy no longer fits a 256K window (dsh compacts at 0.8 × contextWindow and
 * keeps 16%), so this measures **bounded traversal** at the size where traversal is
 * the only option: locate the live settlement in each shard, carry two fields
 * forward, and leave the rest of the bytes behind.
 *
 * Each shard is deliberately two-fact: the live page is the maximum of the shuffled
 * `## Index` list, while the `## Ledger` also carries a stale page *above* that
 * maximum and a low unindexed page — so "the first SETTLE line", "the highest page
 * anywhere in the file" and "the highest page in the ledger" are all wrong answers,
 * and only the index decides. Bulk prose fills ~95% of every shard, and it can
 * never contain a marker (the word pool is lowercase), so a search for the structured
 * lines is exact.
 * @param {{seed?: number, shards?: number, charsPerShard?: number, pagesPerShard?: number}} params - the shape of the corpus.
 * @returns {{files: {path: string, content: string}[], exports: {report: string[], shards: number, chars: number}}} the fixture.
 */
export function deepCorpus(params = {}) {
  const seed = params.seed ?? 41
  const shardCount = Math.max(2, params.shards ?? 32)
  const charsPerShard = Math.max(4000, params.charsPerShard ?? 30000)
  const pagesPerShard = Math.max(4, params.pagesPerShard ?? 10)
  const next = mulberry32(seed)
  const width = String(shardCount - 1).length
  const usedAmounts = new Set()

  // Distinct amounts across the whole corpus: no shard's answer can be guessed from
  // another shard's, and a repeated amount cannot mask a mis-joined page.
  const amount = () => {
    let value
    do {
      value = randInt(next, 1000, 99999)
    } while (usedAmounts.has(value))
    usedAmounts.add(value)
    return value
  }

  const note = () => `${pick(next, WORDS)} ${pick(next, WORDS)} ${pick(next, WORDS)}.`
  // Bulk filler: lowercase sentences only, so the markers stay exactly countable.
  const prose = (budget) => {
    const lines = []
    let used = 0
    while (used < budget) {
      const text = `${pick(next, WORDS)} ${pick(next, WORDS)} ${pick(next, WORDS)} ${pick(next, WORDS)} ${pick(next, WORDS)}.`
      lines.push(text)
      used += text.length + 1
      if (lines.length % 6 === 0) {
        lines.push('')
        used += 1
      }
    }
    return lines
  }

  const files = []
  const report = []
  let chars = 0

  for (let index = 0; index < shardCount; index += 1) {
    const name = `shard-${pad(index, width)}`
    const pool = new Set()
    while (pool.size < pagesPerShard) pool.add(randInt(next, 100, 9999))
    const indexed = [...pool].sort((a, b) => a - b)
    const livePage = indexed[indexed.length - 1]
    // Shuffled, so the live page is not simply the last index entry.
    const shuffled = [...indexed]
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1))
      const swap = shuffled[i]
      shuffled[i] = shuffled[j]
      shuffled[j] = swap
    }
    const decoyPage = indexed[Math.max(0, randInt(next, 0, indexed.length - 2))]
    const stalePage = livePage + randInt(next, 20, 200)
    const lowPage = Math.max(1, indexed[0] - randInt(next, 10, 60))

    const liveAmount = amount()
    const ledger = [
      `- SETTLE ${name} page=${livePage} amount=${liveAmount}`,
      `- SETTLE ${name} page=${decoyPage} amount=${amount()}`,
      `- SETTLE ${name} page=${stalePage} amount=${amount()}`,
      `- SETTLE ${name} page=${lowPage} amount=${amount()}`,
    ]
    for (let i = ledger.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1))
      const swap = ledger[i]
      ledger[i] = ledger[j]
      ledger[j] = swap
    }
    const voids = [
      `- VOID SETTLE ${name} page=${stalePage + randInt(next, 5, 90)} amount=${amount()}`,
      `- VOID SETTLE ${name} page=${randInt(next, 10000, 99999)} amount=${amount()}`,
    ]

    const charterBudget = Math.floor(charsPerShard * 0.58)
    const archiveBudget = Math.max(1000, charsPerShard - charterBudget - 1200)
    const content = [
      `# ${name} — settlement review`,
      '',
      '## Charter',
      '',
      ...prose(charterBudget),
      '',
      '## Index',
      '',
      ...shuffled.map((page) => `- page ${page} — ${note()} ${note()}`),
      '',
      '## Ledger',
      '',
      ...ledger,
      '',
      '## Archive',
      '',
      ...prose(archiveBudget),
      '',
      ...voids,
      '',
    ].join('\n')

    // Invariants: the live page is the index maximum, exactly one ledger line names
    // it, and no marker leaked into the prose — otherwise the expected report would
    // not be the only defensible answer.
    const settlements = content.split('\n').filter((line) => line.startsWith('- SETTLE '))
    if (settlements.length !== 4) throw new Error(`${name}: expected 4 SETTLE lines, wrote ${settlements.length}`)
    if (settlements.filter((line) => line.includes(`page=${livePage} `)).length !== 1) {
      throw new Error(`${name}: the live page ${livePage} must be named exactly once`)
    }
    if (settlements.some((line) => line.startsWith('- SETTLE ') && !line.includes(` ${name} `))) {
      throw new Error(`${name}: a SETTLE line names another shard`)
    }
    if (content.split('SETTLE').length !== 7) {
      throw new Error(`${name}: expected exactly 6 SETTLE markers (4 ledger + 2 void)`)
    }
    if (new Set([livePage, decoyPage, stalePage, lowPage]).size !== 4) throw new Error(`${name}: the four candidate pages must differ`)
    if (indexed.includes(stalePage) || indexed.includes(lowPage)) throw new Error(`${name}: the decoy pages must be unindexed`)

    files.push({ path: `shards/${name}.md`, content })
    chars += content.length
    report.push(`${name} ${liveAmount}`)
  }

  return { files: [...files, { path: 'README.md', content: SETTLEMENT_README }], exports: { report, shards: shardCount, chars } }
}
