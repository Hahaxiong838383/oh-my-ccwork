import assert from 'node:assert/strict'
import { patents, PATENT_COUNT } from '../src/data/patents.ts'

assert.equal(PATENT_COUNT, 46, 'canonical patent total must match the public portfolio')
assert.equal(new Set(patents.map((patent) => patent.number)).size, PATENT_COUNT, 'patent numbers must be unique')
assert.equal(
  patents.filter((patent) => patent.inventorRole === '首位发明人').length,
  44,
  'lead-inventor count must remain complete',
)
assert.equal(
  patents.filter((patent) => patent.inventorRole === '合作发明人').length,
  2,
  'collaborative-inventor count must remain complete',
)
assert.equal(
  patents.filter((patent) => patent.status === '实用新型').length,
  12,
  'utility patent count must remain complete',
)

console.log(`Patent portfolio OK: ${PATENT_COUNT} unique records (44 lead + 2 collaborative)`)
