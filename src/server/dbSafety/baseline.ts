// The schema-version baseline (execution-safety-recovery D13): every schema
// function the database had before versions existed, gathered into one step.
// `migrateSchema` runs it only on a database with no recorded version, then
// records version 1 `baseline`; later starts skip it, so a numbered migration
// that drops or renames a baseline column is never undone here. Each function
// is idempotent and unchanged, so a crash before version 1 is recorded simply
// runs them again. The baseline never inspects or drops a table it does not
// create. These functions are frozen apart from bug fixes: a later schema
// change is a numbered migration in `migrations.ts`, never an edit here.
//
// Inventory (task 6.1) — the stores no longer call any of these themselves:
// - sessions: `applySessionSchema` (db.ts's ensures and `migrateDatabase`);
// - team mail: `createMessageTable`, `ensureMessageEventSchema`,
//   `ensureSessionDirectory`;
// - routing: `ensureLimitEventSchema`, `ensureLimitOutcomeSchema`;
// - staffing and release: `ensureStaffingSchema`, `ensureMemberReleaseSchema`;
// - tasks: `ensureAssignmentSchema`, `ensureTaskSchema` (with the revision
//   schema), `migrateResultTables`;
// - plans: `CREATE_PLAN_TABLES_SQL`, `migratePlanTaskLink`;
// - strategy: `CREATE_STRATEGY_TABLES_SQL`;
// - chat: `ensureTurnEndSchema`.
import type { Database } from 'bun:sqlite'
import { applySessionSchema } from './sessionSchema'
import { createMessageTable } from '../team/messageSchema'
import { ensureMessageEventSchema } from '../team/messageEvents'
import { ensureSessionDirectory } from '../team/sessionDirectory'
import { ensureLimitEventSchema } from '../team/routing/limitEvents'
import { ensureLimitOutcomeSchema } from '../team/routing/limitOutcomes'
import { ensureStaffingSchema } from '../team/staffing'
import { ensureMemberReleaseSchema } from '../team/memberRelease'
import { ensureAssignmentSchema } from '../team/assignmentStore'
import { ensureTaskSchema } from '../team/taskStore'
import { migrateResultTables } from '../team/taskResultSchema'
import { CREATE_PLAN_TABLES_SQL, migratePlanTaskLink } from '../plans/planSchema'
import { CREATE_STRATEGY_TABLES_SQL } from '../strategy/strategySchema'
import { ensureTurnEndSchema } from '../chat/chatTurnEndStore'

/** Run every baseline schema function, in dependency order (tables before their ALTERs). */
export function applyBaselineSchema(db: Database): void {
  applySessionSchema(db)
  createMessageTable(db)
  ensureMessageEventSchema(db)
  ensureSessionDirectory(db)
  ensureLimitEventSchema(db)
  ensureLimitOutcomeSchema(db)
  ensureStaffingSchema(db)
  ensureMemberReleaseSchema(db)
  ensureAssignmentSchema(db)
  ensureTaskSchema(db)
  migrateResultTables(db)
  db.exec(CREATE_PLAN_TABLES_SQL)
  migratePlanTaskLink(db)
  db.exec(CREATE_STRATEGY_TABLES_SQL)
  ensureTurnEndSchema(db)
}
