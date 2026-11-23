// Run by Bun from the fixture spec against Playwright's disposable database.
import { realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { initDatabase } from '../../../src/server/db'
import { renderContract } from '../../../src/shared/implementationContract'
import { normalizePlanContent } from '../../../src/shared/plans'
import { DecisionService } from '../../../src/server/plans/decisions/DecisionService'
import { decisionHandlers } from '../../../src/server/plans/decisions/decisionTools'
import { DecisionStore } from '../../../src/server/plans/decisions/decisionStore'
import { ExecutionStore } from '../../../src/server/plans/execution/executionStore'
import { hashPlanRevision } from '../../../src/server/plans/planHash'
import { PlanStore } from '../../../src/server/plans/planStore'
import { ExecutionRevisionStore } from '../../../src/server/plans/revisionControl/executionRevisionStore'
import { TaskService } from '../../../src/server/team/TaskService'
import { TeamMailbox } from '../../../src/server/team/TeamMailbox'
import { AssignmentStore } from '../../../src/server/team/assignmentStore'
import { AssignmentService } from '../../../src/server/team/AssignmentService'
import { MailboxStore } from '../../../src/server/team/mailboxStore'
import { TaskStore } from '../../../src/server/team/taskStore'
import { taskHandlers } from '../../../src/server/team/taskTools'
import { resolveTeam } from '../../../src/server/team/teamIdentity'
import { retryOnSqliteBusy } from '../../../src/server/__tests__/sqliteBusyRetry'

interface SeedRequest { repo: string; lead: string }

async function main({ repo, lead }: SeedRequest) {
  const database = process.env.AGENTBOARD_DB_PATH
  const fixtureRoot = process.env.E2E_TMUX_TMPDIR
  const refusal = 'Decision publication seed requires the isolated Playwright fixture database'
  if (!database || !fixtureRoot) throw new Error(refusal)
  const file = realpathSync(database)
  if (basename(file) !== 'agentboard.db' || dirname(file) !== realpathSync(fixtureRoot)) {
    throw new Error(refusal)
  }
  const team = await resolveTeam(repo)
  const sessions = initDatabase({ path: file })
  try {
    const { db } = sessions
    db.exec('PRAGMA busy_timeout = 5000')
    const plans = new PlanStore(db)
    const human = { kind: 'human', sessionId: null } as const
    const planId = plans.atomically(() => {
      const id = plans.insertPlan({ teamId: team.teamId, title: 'Decision publication walkthrough', creator: human })
      const content = normalizePlanContent({
        goal: 'Publish reviewed export directions', roles: [{ group: 'leads', profiles: [] }], leadGroup: 'leads',
        changes: [{ change: 'walk-api', group: 'leads', dependsOn: [], acceptance: [], extraChecks: [], guidance: '' }],
      })
      const revision = plans.insertRevision(id, { content, contentHash: hashPlanRevision(content, null), pin: null, author: human })
      plans.setRevisionStatus(id, revision, 'approved')
      plans.setCurrentApproved(id, revision)
      return id
    })
    const getSession = (id: string) => sessions.getChatSession(id) ?? undefined
    const mail = new MailboxStore(db)
    const assignments = new AssignmentStore(db, mail)
    const taskStore = new TaskStore(db, mail, assignments)
    const tasks = new TaskService(taskStore, { getSession, plans })
    const mailbox = new TeamMailbox(mail, { getSession, tasks: taskStore })
    // Setup only needs the actual prepare and typed ask tool paths. The live
    // server, with its full composition, owns every review and mutation under test.
    const decide = new DecisionService({
      db, decisions: new DecisionStore(db), plans, tasks, taskStore, mailbox, getSession,
      publication: { executions: new ExecutionStore(db), revisions: new ExecutionRevisionStore(db) },
      assignments: {} as AssignmentService, planService: {} as ConstructorParameters<typeof DecisionService>[0]['planService'],
    })
    const contract = { version: 1 as const, acceptance: [{ id: 'A1', text: 'The first row contains headers.' }],
      invariants: [], scope: ['src/**'], verification: [{ id: 'V1', text: 'Read the exported file.' }], excluded: [] }
    const cards = []
    for (const mode of ['approved', 'stale']) {
      const task = taskStore.create({ teamId: team.teamId, planId, planChange: 'walk-api', title: `Export ${mode}`,
        creator: human, direction: `Base direction for ${mode}`, acceptance: 'CSV rows use UTF-8.', contract })
      const { handoff } = await retryOnSqliteBusy(() => taskHandlers(tasks, lead).task_request_publication({
        task_id: task.id, base_revision: 1, request_key: mode, direction: `Prepared direction for ${mode}`,
        rationale: `Evidence for ${mode}`, notify: true, contract: renderContract(contract), evidence_refs: ['src/export.ts'],
      }))
      const question = `Review the ${mode} export direction?`
      const card = await retryOnSqliteBusy(() => decisionHandlers(decide, lead).decision_ask({
        question, publication_handoff_id: handoff.id,
      }))
      cards.push({ cardId: card.card_id, taskId: task.id, question })
    }
    process.stdout.write(`PUBLICATION_SEED ${JSON.stringify({ planId, cards })}\n`)
  } finally { sessions.close() }
}

if (import.meta.main) await main(JSON.parse(await Bun.stdin.text()))
