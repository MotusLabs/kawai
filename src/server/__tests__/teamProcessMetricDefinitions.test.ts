// team-process-metrics: the shared observation definitions are documented per
// surface, including how a Prometheus histogram estimate relates to the
// Metrics view's exact read-time percentiles.
// @reads: docs/operations/process-observability.md
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const docPath = path.resolve(import.meta.dir, '..', '..', '..', 'docs', 'operations', 'process-observability.md')

// @covers: team-process-metrics › Observation definitions are shared across surfaces › Different percentile methods
test('the operations doc documents a histogram percentile estimate as an approximation that never equals the Metrics view exact percentile', () => {
  const doc = fs.readFileSync(docPath, 'utf8')
  // The estimate is documented as an approximation...
  expect(doc).toMatch(/Estimating a percentile from\s+histogram buckets in Prometheus is an approximation at bucket resolution/)
  // ...and it is not claimed to equal the Metrics view's exact percentile.
  expect(doc).toMatch(/is\s+not equal to the Metrics view's exact read-time percentiles/)
})
