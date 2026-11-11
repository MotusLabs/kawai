// testDbTemplate.ts - The run's template test database
// (check-time-optimization D5). Before the first batch the unit runner, through
// scripts/build-test-db-template.ts in a child process, migrates one database at `<runRoot>/template.db` with the production
// `initDatabase`, closes it, and exports its path as KAWAI_TEST_DB_TEMPLATE;
// `freshTestDatabase` (src/server/__tests__/helpers/testDatabase.ts) copies
// it instead of migrating a new file. The database runs in rollback-journal
// mode, so a closed template is one self-contained file; a `-wal` or `-shm`
// beside it, or a failed build, fails the run, naming the migration.

import fs from 'node:fs'
import path from 'node:path'
import { initDatabase } from '../../src/server/db'
import type { Migration } from '../../src/server/dbSafety/migrations'
import { TEMPLATE_NAME } from './testDbTemplatePaths'

export { TEMPLATE_ENV, TEMPLATE_NAME } from './testDbTemplatePaths'

/** Build and close the template; returns its path. Throws, naming the
 * failing migration (DatabaseStartupError's message names version and
 * name), when the build fails. `migrations` is for tests. */
export function buildTemplateDatabase(runRoot: string, migrations?: readonly Migration[]): string {
  const templatePath = path.join(runRoot, TEMPLATE_NAME)
  let database
  try {
    database = initDatabase({ path: templatePath, ...(migrations !== undefined ? { migrations } : {}) })
  } catch (error) {
    throw new Error(`[test-runner] the template test database did not build: ${error instanceof Error ? error.message : String(error)}`)
  }
  database.close()
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(`${templatePath}${suffix}`)) {
      throw new Error(`[test-runner] the template test database left ${TEMPLATE_NAME}${suffix} beside it; a copy would be incomplete`)
    }
  }
  return templatePath
}
