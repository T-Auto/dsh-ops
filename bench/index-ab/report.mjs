/**
 * G4 (#614): turn measured calls into the evidence table. Pure functions so the
 * self-test can assert the arithmetic without booting a worker.
 *
 * @module dsh-ops/bench/index-ab/report
 */

import fs from 'node:fs'
import path from 'node:path'
import { median, percentile95, round } from './plan.mjs'

/** The disk budget the persistence slice enforces (ops-index MAX_SNAPSHOT_BYTES). */
export const SNAPSHOT_CAP_MIB = 256

/** The in-memory entry cost pinned by the index contract (ENTRY_BYTES). */
export const ENTRY_BYTES = 57

/** Summarize one arm's measured rounds for one query. */
export function armSummary(runs) {
  const durations = runs.map((run) => run.wallMs)
  const rss = runs.map((run) => run.rssKb).filter((value) => value !== null)
  return {
    rounds: runs.length,
    statuses: runs.map((run) => run.status),
    medianMs: round(median(durations), 2),
    p95Ms: round(percentile95(durations), 2),
    minMs: round(Math.min(...durations), 2),
    maxMs: round(Math.max(...durations), 2),
    medianRssKb: round(median(rss), 1),
    maxRssKb: rss.length ? Math.max(...rss) : null,
    stdoutBytes: runs.map((run) => run.stdout.length),
  }
}

/**
 * Compare one query's walk and index arms. Byte identity is the pass/fail part; the
 * duration delta is evidence only and never a verdict.
 */
export function compareCase(query, walkRuns, indexRuns) {
  const walk = armSummary(walkRuns)
  const index = armSummary(indexRuns)
  const outputs = new Set(walkRuns.concat(indexRuns).map((run) => run.stdoutHash))
  const identical = outputs.size === 1
  const deltaMs = round(index.medianMs - walk.medianMs, 2)
  const deltaPct = walk.medianMs ? round(((index.medianMs - walk.medianMs) / walk.medianMs) * 100, 1) : null
  const rssDeltaKb = walk.medianRssKb !== null && index.medianRssKb !== null ? round(index.medianRssKb - walk.medianRssKb, 1) : null
  // Paired deltas cancel the drift between rounds: remove the between-round component
  // that a comparison of two independently-ordered medians still carries.
  const pairs = walkRuns.map((run, at) => indexRuns[at].wallMs - run.wallMs)
  const pairedDeltaMs = round(median(pairs), 2)
  return { id: query.id, patterns: query.patterns, walk, index, identical, outputHash: [...outputs][0] ?? null, deltaMs, deltaPct, pairedDeltaMs, rssDeltaKb }
}

/** Sum of relative-name bytes under the corpus root (the name table's payload). */
export function nameBytes(root) {
  let bytes = 0
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      bytes += Buffer.byteLength(entry.name, 'utf8')
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative)
    }
  }
  visit(root, '')
  return bytes
}

/**
 * Estimate what an index for this corpus costs and compare it with the caps the
 * persistence and index slices enforce. This is arithmetic from the pinned constants,
 * not a measurement; the measured RSS is reported separately.
 */
export function budgetFor(corpus) {
  const names = nameBytes(corpus.root)
  const entries = corpus.files * ENTRY_BYTES
  const estimatedBytes = entries + names + 4096
  return {
    files: corpus.files,
    nameBytes: names,
    entryBytes: corpus.files * ENTRY_BYTES,
    estimatedMiB: round(estimatedBytes / (1024 * 1024), 2),
    snapshotCapMiB: SNAPSHOT_CAP_MIB,
    headroomMiB: round(SNAPSHOT_CAP_MIB - estimatedBytes / (1024 * 1024), 2),
  }
}
/** Render the measured evidence as the Markdown table the docs and PR quote. */
export function renderMarkdown(report) {
  const lines = []
  const env = report.environment
  lines.push('### Environment', '')
  lines.push('| fact | value |')
  lines.push('| --- | --- |')
  lines.push('| platform | ' + env.platformTag + ' |')
  lines.push('| node | ' + env.node + ' |')
  lines.push('| kernel | ' + env.kernel + ' |')
  lines.push('| cpus | ' + env.cpus + ' |')
  lines.push('| total memory | ' + env.totalMemMiB + ' MiB |')
  lines.push('| revision | ' + env.revision + ' |')
  lines.push('| worker sha256 | ' + env.workerSha256 + ' |')
  lines.push('| corpus sha256 | ' + report.corpus.hash + ' |')
  lines.push('| corpus shape | ' + report.corpus.files + ' files / ' + report.corpus.dirs + ' dirs / ' + report.corpus.bytes + ' bytes / depth ' + report.corpus.maxDepth + ' |', '')
  lines.push('### Cold first call (ms)', '')
  lines.push('| query | patterns | walk | index | delta |')
  lines.push('| --- | --- | ---: | ---: | ---: |')
  for (const item of report.cold) lines.push('| ' + item.id + ' | ' + item.patterns.join(' ') + ' | ' + item.walk + ' | ' + item.index + ' | ' + (item.delta === null ? '-' : item.delta) + ' |')
  lines.push('', '### Warm repeated calls (median of ' + report.options.repeat + ', p95)', '')
  lines.push('| query | walk median | walk p95 | index median | index p95 | delta | paired delta | delta % | identical bytes |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
  for (const item of report.cases) lines.push('| ' + item.id + ' | ' + item.walk.medianMs + ' | ' + item.walk.p95Ms + ' | ' + item.index.medianMs + ' | ' + item.index.p95Ms + ' | ' + item.deltaMs + ' | ' + item.pairedDeltaMs + ' | ' + (item.deltaPct === null ? '-' : item.deltaPct) + ' | ' + (item.identical ? 'yes' : 'NO') + ' |')
  lines.push('', '### RSS and budget', '')
  lines.push('| query | walk median RSS (kB) | index median RSS (kB) | delta (kB) |')
  lines.push('| --- | ---: | ---: | ---: |')
  for (const item of report.cases) lines.push('| ' + item.id + ' | ' + (item.walk.medianRssKb === null ? 'n/a' : item.walk.medianRssKb) + ' | ' + (item.index.medianRssKb === null ? 'n/a' : item.index.medianRssKb) + ' | ' + (item.rssDeltaKb === null ? 'n/a' : item.rssDeltaKb) + ' |')
  lines.push('')
  lines.push('| budget fact | value |')
  lines.push('| --- | --- |')
  lines.push('| estimated index bytes (57 B/entry + names + header) | ' + report.budget.estimatedMiB + ' MiB |')
  lines.push('| snapshot cap enforced by the persistence slice | ' + report.budget.snapshotCapMiB + ' MiB |')
  lines.push('| headroom | ' + report.budget.headroomMiB + ' MiB |')
  lines.push('')
  lines.push('All arms returned byte-identical results: ' + (report.verdict.outputsIdentical ? 'yes' : 'NO') + '.')
  return lines.join('\n')
}
