// testDbTemplatePaths.ts - What the unit runner needs of the template test
// database (check-time-optimization D5): the shared names, and the spawn of
// the build. The build (scripts/build-test-db-template.ts) runs in a child
// process, and this module imports only Node built-ins, so the database
// modules never join the check machinery's import closure.

import path from 'node:path'

export const TEMPLATE_ENV = 'KAWAI_TEST_DB_TEMPLATE'
export const TEMPLATE_NAME = 'template.db'
const BUILD_SCRIPT = path.join(import.meta.dir, '..', 'build-test-db-template.ts')

/** Build the run's template in a child; its path, or an error carrying the
 * build's message, which names a failing migration. */
export function spawnTemplateBuild(runRoot: string): string {
  // The build's own logs go nowhere; its error (on stderr) names the cause.
  const build = Bun.spawnSync({ cmd: [process.execPath, BUILD_SCRIPT, runRoot], stdout: 'ignore', stderr: 'pipe' })
  if (build.exitCode !== 0) {
    const lines = build.stderr.toString().trim().split('\n')
    throw new Error(lines.findLast((line) => line.includes('[test-runner]')) ?? `[test-runner] the template build exited ${build.exitCode}: ${lines.slice(-5).join(' ')}`)
  }
  return path.join(runRoot, TEMPLATE_NAME)
}
