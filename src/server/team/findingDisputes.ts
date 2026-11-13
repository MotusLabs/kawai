// Disputes and their decisions (review-findings-ledger D6, tables DS and DD).
// A result's author disputes blocking findings with counter-evidence. On a
// plan change's task each disputed finding gets one decision card, raised
// on the author's behalf and committed in one transaction with its
// `disputed` event and card link; a card's decisions and overrides reach
// `applyCardDecision` after their commit, and a startup replay repairs any
// that never did (recovery matrix). On any other task the task's owner
// (task-owner-remaining-rights D1) or the human decides with
// `task_decide_dispute`, and the dispute's mail goes to the owner. Every Kawai-written event carries
// a replay key (I5); every refusal writes nothing (I3).
import { decisionApplies, disputeRefusal, type LedgerRow } from '../../shared/findingsLedger'
import { FINDING_LIMITS } from '../../shared/reviewFindings'
import type { TaskActor, TeamTask } from '../../shared/teamTasks'
import type { TaskStore } from './taskStore'
import { ownerLabel, taskOwner } from './taskStatusRights'
import type { CardLink } from './findingStore'

export interface DisputeCardPort {
  /** Raise one card on `sessionId`'s behalf about `task`, committing `within(cardId)` in the card's transaction. */
  raise(input: { sessionId: string; task: TeamTask; question: string; options: string[]; context: string }, within: (cardId: string) => void): Promise<string>
}

export interface FindingMailPort {
  /** One system message to a session about a task (the owner of a manual task, the implementer after a re-gate). */
  toSession(input: { teamId: string; sessionId: string; taskId: string; body: string; tags: string[] }): void
}

export interface DisputeInput { id: string; counterEvidence: string }

export interface DisputeOutcome { disputed: Array<{ id: string; cardId: string | null }> }

const cut = (text: string | null, max = 1_000) => (text === null ? '(none)' : text.length > max ? `${text.slice(0, max)}…` : text)

export class FindingDisputes {
  cards: DisputeCardPort | null = null
  mail: FindingMailPort | null = null

  constructor(
    private readonly store: TaskStore,
    private readonly ledger: (taskId: string) => LedgerRow[],
    private readonly evidence: (taskId: string, findingId: string) => string | null,
    private readonly onWrite?: (taskId: string) => void,
  ) {}

  /** DS1–DS7: dispute blocking findings; validated whole before anything is written. */
  async dispute(input: { teamId: string; task: TeamTask; actor: TaskActor & { kind: 'agent' }; disputes: DisputeInput[] }): Promise<DisputeOutcome> {
    const { task, actor } = input
    if (input.disputes.length === 0) throw new Error('Name at least one finding to dispute')
    if (input.disputes.length > FINDING_LIMITS.disputes) throw new Error(`A call disputes at most ${FINDING_LIMITS.disputes} findings; nothing was written`)
    if (!this.store.results.submittedBy(task.id, actor.sessionId!)) {
      throw new Error('Only a member that submitted a result on this task can dispute its findings; nothing was written')
    }
    const rows = new Map(this.ledger(task.id).map(row => [row.id, row]))
    const problems: string[] = []
    const seen = new Set<string>()
    for (const entry of input.disputes) {
      if (seen.has(entry.id)) problems.push(`${entry.id} is named twice`)
      seen.add(entry.id)
      const refusal = disputeRefusal(rows.get(entry.id), entry.id)
      if (refusal) problems.push(refusal)
      const text = entry.counterEvidence.trim()
      if (!text) problems.push(`${entry.id}: a dispute needs counter-evidence`)
      if (text.length > FINDING_LIMITS.counterEvidenceChars) problems.push(`${entry.id}: counter-evidence is over ${FINDING_LIMITS.counterEvidenceChars} characters`)
    }
    if (problems.length > 0) throw new Error(`Dispute refused, nothing was written: ${problems.join('; ')}`)

    const disputed: DisputeOutcome['disputed'] = []
    for (const entry of input.disputes) {
      const row = rows.get(entry.id)!
      const sourceKey = `dispute:${task.id}:${row.id}:${row.transitions.length}`
      const write = () => this.store.findings.insertEvent({
        taskId: task.id, findingId: row.id, kind: 'disputed', resultId: this.store.results.outstanding(task.id)?.id ?? null,
        contractIdentity: task.identity ?? null, clause: row.clause, actor, text: entry.counterEvidence.trim(), sourceKey,
      })
      const journal = `Disputed ${row.id} (${row.level}, ${row.clause ?? 'no clause'}): ${cut(entry.counterEvidence.trim(), 300)}`
      if (task.planId && this.cards) {
        const cardId = await this.cards.raise({
          sessionId: actor.sessionId!, task,
          question: `Dispute of ${row.id} (${row.level}, ${row.clause ?? 'no clause'}) on task "${task.title}": uphold the finding, or reject it?`,
          options: [`Uphold ${row.id}`, `Reject ${row.id}`],
          context: `Finding ${row.id} evidence: ${cut(this.evidence(task.id, row.id))}\n\nCounter-evidence: ${cut(entry.counterEvidence.trim())}`,
        }, cardId => {
          const eventId = write()
          if (eventId === null) throw new Error(`${row.id} was disputed meanwhile; nothing was written`)
          this.store.findings.linkCard({ cardId, taskId: task.id, findingId: row.id, disputeEventId: eventId })
          this.store.appendJournal(task.id, actor, `${journal} (card ${cardId})`)
        })
        disputed.push({ id: row.id, cardId })
      } else {
        this.store.immediate(() => {
          if (write() === null) throw new Error(`${row.id} was disputed meanwhile; nothing was written`)
          this.store.appendJournal(task.id, actor, journal)
        })
        const owner = taskOwner(task)
        if (owner) {
          this.mail?.toSession({
            teamId: input.teamId, sessionId: owner, taskId: task.id, tags: ['finding-dispute'],
            body: `Kawai: ${actor.sessionId} disputes ${row.id} on task "${task.title}" (${task.id}). Counter-evidence: ${cut(entry.counterEvidence.trim())}\n\nDecide it with task_decide_dispute (uphold or reject, with a rationale).`,
          })
        }
        disputed.push({ id: row.id, cardId: null })
      }
    }
    this.onWrite?.(task.id)
    return { disputed }
  }

  /** The non-plan path (spec: the owner or the human decides, with a rationale). */
  decide(input: { task: TeamTask; actor: TaskActor; findingId: string; decision: 'uphold' | 'reject'; rationale: string }): LedgerRow {
    const { task, actor } = input
    if (task.planId) throw new Error(`Task ${task.id} is a plan change's task: its disputes are decided on their decision cards`)
    const owner = taskOwner(task)
    const allowed = actor.kind === 'human' || (actor.kind === 'agent' && owner !== null && actor.sessionId === owner)
    if (!allowed) throw new Error(`Only ${owner ? `${ownerLabel(task)} or the human` : 'the human'} decides a dispute on this task; nothing was written`)
    const rationale = input.rationale.trim()
    if (!rationale) throw new Error('A dispute decision needs a rationale')
    const row = this.ledger(task.id).find(entry => entry.id === input.findingId)
    if (!row || row.state !== 'disputed' || row.disputeEventId === null) throw new Error(`${input.findingId} is not disputed; nothing was written`)
    this.store.immediate(() => {
      this.store.findings.insertEvent({
        taskId: task.id, findingId: row.id, kind: input.decision === 'uphold' ? 'upheld' : 'rejected', actor, text: rationale,
        contractIdentity: task.identity ?? null, sourceKey: `decide:${row.disputeEventId}`,
      })
      this.store.appendJournal(task.id, actor, `${input.decision === 'uphold' ? 'Upheld' : 'Rejected'} the dispute of ${row.id}: ${rationale}`)
    })
    this.onWrite?.(task.id)
    return this.ledger(task.id).find(entry => entry.id === row.id)!
  }

  /** DD1–DD7: apply one committed decision of a linked card; replay-safe under `decision:<id>`. */
  applyCardDecision(cardId: string, decision: { id: string; choice: string; rationale: string | null; decidedBy: { kind: string; session?: string | null } }): boolean {
    const link = this.store.findings.cardLink(cardId)
    if (link === null) return false
    const sourceKey = `decision:${decision.id}`
    // A cheap early exit; INSERT OR IGNORE under the same key is the guarantee (DD6).
    if (this.store.findings.hasEvent(sourceKey)) return false
    const row = this.ledger(link.taskId).find(entry => entry.id === link.findingId)
    const choice = decision.choice.trim().toLowerCase()
    const verdict = choice.startsWith('uphold') ? 'upheld' : choice.startsWith('reject') ? 'rejected' : null
    const applies = row !== undefined && verdict !== null && decisionApplies(row, link.disputeEventId, cardId)
    const actor = { kind: decision.decidedBy.kind === 'agent' ? 'agent' : 'human', sessionId: decision.decidedBy.session ?? null }
    const written = this.store.immediate(() => {
      const id = this.store.findings.insertEvent({
        taskId: link.taskId, findingId: link.findingId, kind: applies ? verdict! : 'ignored', cardId, decisionId: decision.id, actor,
        text: decision.rationale, sourceKey,
      })
      if (id !== null) {
        this.store.appendJournal(link.taskId, actor as TaskActor, applies
          ? `${verdict === 'upheld' ? 'Upheld' : 'Rejected'} ${link.findingId} on card ${cardId}: ${decision.rationale ?? ''}`.trim()
          : `Decision ${decision.id} on card ${cardId} (${decision.choice}) left ${link.findingId} unchanged: the finding moved on since its dispute`)
      }
      return id !== null
    })
    if (written) this.onWrite?.(link.taskId)
    return written
  }

  /** The startup replay (recovery matrix): every linked card's decisions, in order, that have no event yet. */
  replay(decisionsOf: (link: CardLink) => Array<{ id: string; choice: string; rationale: string | null; decidedBy: { kind: string; session?: string | null } }>): number {
    let applied = 0
    for (const link of this.store.findings.allCardLinks()) {
      for (const decision of decisionsOf(link)) if (this.applyCardDecision(link.cardId, decision)) applied++
    }
    return applied
  }
}
