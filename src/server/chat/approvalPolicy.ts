// Per-session approval policy (chat-auto-approve-tools design D1): who
// answers a chat session's tool approvals — the user via approval cards
// (manual) or the session itself (auto). Pure decision logic only; the
// driver applies it inside canUseTool. The CLI evaluates the user's Claude
// Code settings rules before canUseTool runs, so deny rules keep applying
// under auto. Questions are never auto-answered.
import type { ChatApprovalPolicy } from '../../shared/chat'
import { ASK_USER_QUESTION_TOOL } from './contentBlocks'

/** What canUseTool should do with a tool use under the current policy. */
export type ApprovalDecision = 'ask' | 'allow'

/** Shared with the client's settings store so both sides sanitize alike. */
export { parseApprovalPolicy } from '../../shared/chat'

/** Ask under manual; allow everything under auto except agent questions. */
export function decideApproval(
  policy: ChatApprovalPolicy,
  toolName: string
): ApprovalDecision {
  if (policy !== 'auto') return 'ask'
  if (toolName === ASK_USER_QUESTION_TOOL) return 'ask'
  return 'allow'
}
