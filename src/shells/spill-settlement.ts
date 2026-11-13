/** One command settlement updates the existing ledger and bounded retention scheduler. */
import { recordSettledSpill, type SpillLedgerRecord } from './spill-ledger.js'
import { noteSpillSettled } from './spill-retention-runtime.js'

export function recordSettledSpills(records: readonly SpillLedgerRecord[]): void {
  for (const record of records) {
    try { recordSettledSpill(record) } catch { /* retention cannot change an executed command */ }
  }
  try { noteSpillSettled() } catch { /* retention cannot change an executed command */ }
}
