// The decision reply guard (plan-supervision design D9). A reply to a
// `decision-question` mail whose card has no decision yet is refused, for
// an agent (pointing at `decision_record`) and for the human (pointing at
// the card's Answer in the Plans view); nothing is queued. Once the card is
// decided, replies pass, so the asker and the Lead can discuss the answer.
// `DecisionService` writes its own answers with the guard bypassed, and a
// mailbox built without the plans module has no guard at all.
import type { Database } from 'bun:sqlite'
import type { ReplyGuard } from '../../team/TeamMailbox'
import { DecisionStore } from './decisionStore'

export const QUESTION_TAG = 'decision-question'

export function decisionReplyGuard(decisions: DecisionStore): ReplyGuard {
  return (parent, caller) => {
    if (!parent.tags.includes(QUESTION_TAG)) return null
    const card = decisions.cardByMessage(parent.teamId, parent.id)
    if (!card || decisions.decisionsOfCard(parent.teamId, card.id).length > 0) return null
    if (caller.kind === 'human') {
      return `This is the question of decision card ${card.id}. Answer it with the card's Answer in the Plans view, so the decision is recorded; nothing was sent.`
    }
    return `This is the question of decision card ${card.id}. Decide it with decision_record({ plan_id, card_id, … }) so the decision is recorded `
      + `(plan_id: "${card.planId}", card_id: "${card.id}"); nothing was sent.`
  }
}

/** The production guard over the server's database (wired by `SessionMailbox`). */
export const decisionReplyGuardOver = (db: Database): ReplyGuard => decisionReplyGuard(new DecisionStore(db))
