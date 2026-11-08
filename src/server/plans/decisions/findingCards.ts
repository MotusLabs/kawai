// Dispute cards (review-findings-ledger D6) wired between the team's
// findings ledger and the plan decision service: a dispute on a plan change's
// task raises its card through `askForTask` in the dispute's transaction;
// every committed decision or override of a linked card reaches the ledger
// after its commit; and at startup every linked card's decisions that never
// reached it are applied once (recovery matrix, "a decision committed but
// its ledger event lost"). Manual tasks' creators get one system message.
import type { MailboxStore } from '../../team/mailboxStore'
import type { TaskFindingService } from '../../team/TaskFindingService'
import type { TaskStore } from '../../team/taskStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { DecisionStore } from './decisionStore'
import type { DecisionService } from './DecisionService'

export interface FindingCardDeps {
  findings: TaskFindingService
  decisions: DecisionService
  decisionStore: DecisionStore
  taskStore: TaskStore
  mailbox: Pick<MailboxStore, 'enqueue'>
  identityOf: (teamId: string) => TeamIdentity | undefined
}

/** Connect the ports, subscribe to decisions, and replay; returns the unsubscribe. */
export function connectFindingCards(deps: FindingCardDeps): () => void {
  const disputes = deps.findings.disputes
  disputes.cards = {
    raise: async (input, within) => (await deps.decisions.askForTask(
      { sessionId: input.sessionId, task: input.task, question: input.question, options: input.options, context: input.context },
      card => within(card.id),
    )).id,
  }
  disputes.mail = {
    toSession: ({ teamId, sessionId, taskId, body, tags }) => {
      deps.mailbox.enqueue({
        teamId, toKind: 'session', toId: sessionId, fromKind: 'system', fromSession: null, fromGroup: null,
        originPath: deps.identityOf(teamId)?.groupsRoot ?? teamId, tags, body, taskId, actor: 'system',
      })
    },
  }
  const unsubscribe = deps.decisions.onDecided((card, decision) => { disputes.applyCardDecision(card.id, decision) })
  disputes.replay(link => {
    const teamId = deps.taskStore.get(link.taskId)?.teamId
    return teamId ? deps.decisionStore.decisionsOfCard(teamId, link.cardId) : []
  })
  return unsubscribe
}
