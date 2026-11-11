// reportBackups.ts - Appends one JSON line to KAWAI_PROBE_OUT naming a probe,
// the backups beside its database, and the template the runner exported.
import fs from 'node:fs'
import path from 'node:path'

export function reportBackups(name: string, dbPath: string): void {
  let backups: string[] = []
  try {
    backups = fs.readdirSync(path.join(path.dirname(dbPath), 'backups'))
  } catch {
    // no backups directory
  }
  const template = process.env.KAWAI_TEST_DB_TEMPLATE ?? null
  fs.appendFileSync(
    process.env.KAWAI_PROBE_OUT!,
    `${JSON.stringify({ name, backups, template, templateExists: template !== null && fs.existsSync(template) })}\n`
  )
}
