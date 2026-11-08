// Re-map on publication (review-findings-ledger D9, table RM). Called inside
// the publication transaction: when the new revision's identity hash differs
// from the previous revision's, each blocking or disputed finding gets one
// `remapped` or `superseded` event under `revision:<taskId>:<revision>:<id>`
// and one journal line. The publication's own replay never reaches here, and
// the key makes a second pass write nothing (I5).
import { SYSTEM_ACTOR } from '../../shared/team'
import { foldLedger, remapOnPublication } from '../../shared/findingsLedger'
import type { TaskRevision } from '../../shared/teamTasks'
import type { TaskStore } from './taskStore'

/** Write the re-map events of publishing `revision`; returns how many were written. */
export function remapFindings(store: TaskStore, taskId: string, revision: TaskRevision): number {
  const previous = store.revisions(taskId).find(entry => entry.revision === revision.revision - 1)
  if (!previous?.identity || !revision.identity) return 0
  const findings = store.findings
  const rows = foldLedger(findings.countedSubmissions(taskId), findings.events(taskId))
  const events = remapOnPublication(rows, previous.identity, { identity: revision.identity, contract: revision.contract ?? null })
  let written = 0
  for (const event of events) {
    const id = findings.insertEvent({
      taskId, findingId: event.findingId, kind: event.kind, revision: revision.revision, contractIdentity: revision.identity,
      clause: event.clause, actor: SYSTEM_ACTOR, sourceKey: `revision:${taskId}:${revision.revision}:${event.findingId}`,
    })
    if (id === null) continue
    written++
    store.appendJournal(taskId, SYSTEM_ACTOR, event.kind === 'remapped'
      ? `Re-mapped ${event.findingId} to ${event.clause} (revision ${revision.revision}); its state is kept`
      : `Superseded ${event.findingId}: revision ${revision.revision} (${revision.identity}) has no clause it can cite; it no longer blocks`)
  }
  return written
}
