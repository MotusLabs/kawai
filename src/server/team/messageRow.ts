// Row mapping for `team_messages`, shared by the mailbox store and the
// messages query layer. Null-safe: a missing id column maps to null, never
// to the string "null".
import type { ChatHandoffPackage, MessageState, TeamMessage } from '../../shared/team'
import type { RevisionNotice } from '../../shared/teamTasks'
import { isHandoffPackage } from './routing/handoff'

export function mapRow(row: Record<string, unknown>): TeamMessage {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
  let tags: string[] = []
  try {
    const parsed: unknown = JSON.parse(String(row.tags ?? '[]'))
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
  } catch {
    // A corrupt tag list reads as none; the message itself stays usable.
  }
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    toKind: row.to_kind === 'group' || row.to_kind === 'session' ? row.to_kind : 'human',
    toId: text(row.to_id),
    fromKind: row.from_kind === 'human' || row.from_kind === 'system' ? row.from_kind : 'agent',
    fromSession: text(row.from_session),
    fromGroup: text(row.from_group),
    originPath: String(row.origin_path),
    priority: row.priority === 'urgent' ? 'urgent' : 'normal',
    tags,
    threadId: String(row.thread_id),
    inReplyTo: text(row.in_reply_to),
    hop: Number(row.hop ?? 1),
    body: String(row.body),
    state: String(row.state) as MessageState,
    claimedBy: text(row.claimed_by),
    claimedAt: text(row.claimed_at),
    deliverAt: text(row.deliver_at),
    createdAt: String(row.created_at),
    pushedAt: text(row.pushed_at),
    deliveredAt: text(row.delivered_at),
    reason: text(row.reason),
    possibleDuplicate: Number(row.possible_duplicate ?? 0) === 1,
    attachThread: Number(row.attach_thread ?? 0) === 1,
    taskId: text(row.task_id),
    taskRevision: row.task_revision === null || row.task_revision === undefined ? null : Number(row.task_revision),
    claimCommit: text(row.claim_commit),
    parkedUntil: text(row.parked_until),
    parkCount: Number(row.park_count ?? 0),
    resumeMessageId: text(row.resume_message_id),
    handoff: parseHandoff(row.handoff),
    excludedProfile: text(row.excluded_profile),
    revisionNotice: parseRevisionNotice(row.revision_notice),
  }
}

/** A notice row's announced revision (task-revision-publication D3); null for every other row. */
function parseRevisionNotice(value: unknown): RevisionNotice | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown> | null
    if (!parsed || typeof parsed.revision !== 'number' || typeof parsed.previousRevision !== 'number' ||
      typeof parsed.assignmentId !== 'string' || !(parsed.rationale === null || typeof parsed.rationale === 'string')) return null
    return { revision: parsed.revision, previousRevision: parsed.previousRevision, assignmentId: parsed.assignmentId, rationale: parsed.rationale }
  } catch {
    // A corrupt notice reads as none; the message itself stays usable.
    return null
  }
}

function parseHandoff(value: unknown): ChatHandoffPackage | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isHandoffPackage(parsed) ? parsed : null
  } catch {
    // A corrupt package reads as none; the message itself stays usable.
    return null
  }
}
