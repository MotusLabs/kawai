// Records `masterSchemaShape.json`: the schema a fresh database had under
// master bdc0131, the last build before schema versions, produced by that
// build's own code (initDatabase plus every store constructor, which then
// created its tables lazily). The baseline must reproduce it exactly.
//
// Regenerate (only if the pinned commit itself changes — a later schema
// change is a numbered migration and never edits this fixture):
//   mkdir -p /tmp/kawai-master && git archive bdc0131 src package.json tsconfig.json | tar -x -C /tmp/kawai-master
//   ln -s "$PWD/node_modules" /tmp/kawai-master/node_modules
//   LOG_FILE=/tmp/kawai-master.log bun src/server/__tests__/fixtures/generateMasterSchemaShape.ts /tmp/kawai-master
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schemaShape } from './schemaShape'

const root = process.argv[2]
if (!root) throw new Error('usage: generateMasterSchemaShape.ts <checkout of bdc0131>')
const from = (module: string) => import(path.join(path.resolve(root), 'src/server', module))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-master-shape-'))
try {
  const { initDatabase } = await from('db.ts')
  const session = initDatabase({ path: path.join(dir, 'agentboard.db') })
  const db = session.db
  const { MailboxStore } = await from('team/mailboxStore.ts')
  const { LimitEventStore } = await from('team/routing/limitEvents.ts')
  const { LimitOutcomes } = await from('team/routing/limitOutcomes.ts')
  const { WorktreeStaffing } = await from('team/staffing.ts')
  const { MemberRelease } = await from('team/memberRelease.ts')
  const { AssignmentStore } = await from('team/assignmentStore.ts')
  const { TaskStore } = await from('team/taskStore.ts')
  const { PlanStore } = await from('plans/planStore.ts')
  const { StrategyStore } = await from('strategy/strategyStore.ts')
  const { ChatTurnEndStore } = await from('chat/chatTurnEndStore.ts')
  const { SessionDirectory } = await from('team/sessionDirectory.ts')
  const { MessageQuery } = await from('team/messageQuery.ts')
  const mail = new MailboxStore(db)
  const limits = new LimitEventStore(db)
  // Only the constructors run: each created its table, nothing else is called.
  new LimitOutcomes(db, { limits } as never)
  new WorktreeStaffing(db, mail, {} as never)
  new MemberRelease(db, {} as never)
  const assignments = new AssignmentStore(db, mail)
  new TaskStore(db, mail, assignments)
  new PlanStore(db)
  new StrategyStore(db)
  new ChatTurnEndStore(db)
  new SessionDirectory(db)
  new MessageQuery(db)
  const shape = schemaShape(db)
  session.close()
  const out = path.join(import.meta.dir, 'masterSchemaShape.json')
  fs.writeFileSync(out, `${JSON.stringify(shape, null, 2)}\n`)
  console.log(`wrote ${out}: ${Object.keys(shape.tables).length} tables`)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
