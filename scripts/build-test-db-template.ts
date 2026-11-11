// build-test-db-template.ts - Builds the run's template test database
// (check-time-optimization D5): `bun scripts/build-test-db-template.ts
// <runRoot>` migrates <runRoot>/template.db, closes it, and prints its path.
// On failure it prints the error, which names the failing migration, and
// exits 1. The unit runner spawns it before the first batch.

import { buildTemplateDatabase } from './lib/testDbTemplate'

const runRoot = process.argv[2]
if (!runRoot) {
  console.error('usage: bun scripts/build-test-db-template.ts <runRoot>')
  process.exit(2)
}
try {
  process.stdout.write(`${buildTemplateDatabase(runRoot)}\n`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
