// Durable team mail (agent-teams design D1/D5/D10): every message lives in
// the `team_messages` table from send to settle, so the queue survives
// restarts and the mailbox view reads the same rows the dispatcher does.
// Claims are atomic (`UPDATE … WHERE state='queued'` — the changed-row count
// picks the one winner), and delivery is recorded as three durable facts:
// claimed → pushed_at (just before the turn push) → delivered_at (the
// recipient transcript carried the id). Threads count hops along the reply
// chain; a send past the limit is stored dead-lettered instead of queued.
import type { Database } from 'bun:sqlite'
import { mailboxSql, worktreeTaskMailSql } from './mailboxSql'
import { createMessageTable } from './messageSchema'
import { mapRow } from './messageRow'
import { MessageEventLog, storeActor, type StoreActor } from './messageEvents'

import type {
  ChatHandoffPackage,
  MessageEvent,
  MessageEventKind,
  MessageState,
  MessagePriority,
  TeamActor,
  TeamMessage,
} from '../../shared/team'
export type { MessageState, MessagePriority, TeamMessage, MessageEvent } from '../../shared/team'

export interface EnqueueInput {
  teamId: string
  /** Routing vocabulary (D4): `human` settles on send and never reaches the dispatcher. */
  toKind: 'group' | 'session' | 'human'
  /** Recipient id; null for `toKind: 'human'`. */
  toId: string | null
  /** Actor vocabulary (D4). Absent on agent sends; never merged with `toKind`. */
  fromKind?: TeamActor['kind']
  /** Sender session; null for a human sender. */
  fromSession: string | null
  fromGroup: string | null
  originPath: string
  priority?: MessagePriority
  tags?: string[]
  body: string
  /** The message being replied to; absent starts a new thread. */
  inReplyTo?: TeamMessage
  deliverAt?: string | null
  attachThread?: boolean
  /** Sender group's hopLimit, else the default. */
  hopLimit?: number
  /** Team task the message works under (validated by the caller). */
  taskId?: string | null
  /** Forwarded work after a limit (profile routing). */
  handoff?: ChatHandoffPackage | null
  excludedProfile?: string | null
  /** Who caused the send (event log): the human through a composer, else the system. */
  actor?: 'system' | 'human'
}

/** Outcome of {@link MailboxStore.cancelResult}: cancelled, or why not (nothing changed). */
export type CancelResult =
  | { ok: true }
  | { ok: false; code: 'resume-in-flight'; holder: string | null; resumeId: string }
  | { ok: false; code: 'linked-resume'; parkedId: string }
  | { ok: false; code: 'state-changed'; state: MessageState | null }

export const DEFAULT_HOP_LIMIT = 20

const nowIso = () => new Date().toISOString()
const SYSTEM: StoreActor = { kind: 'system' }
const HUMAN: StoreActor = { kind: 'human' }
/** Longest agent-supplied cancel or discard text kept on a row. */
export const REASON_LIMIT = 300

export class MailboxStore {
  private readonly listeners = new Set<(teamId: string, message?: TeamMessage) => void>()

  subscribe(listener: (teamId: string, message?: TeamMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(id: string, changed: boolean): boolean {
    if (changed) {
      const message = this.get(id)
      if (message) for (const listener of this.listeners) listener(message.teamId, message)
    }
    return changed
  }

  private readonly statements: Record<keyof typeof mailboxSql, ReturnType<Database['prepare']>>
  private readonly dynamicStatements = new Map<string, ReturnType<Database['prepare']>>()
  /** Append-only history of every transition (team-message-threads D2). */
  readonly events: MessageEventLog
  constructor(private readonly db: Database, private readonly options: { recipientExists?: (id: string) => boolean } = {}) {
    createMessageTable(db)
    this.events = new MessageEventLog(db)
    this.statements = Object.fromEntries(Object.entries(mailboxSql).map(([key, sql]) => [key, db.prepare(sql)])) as typeof this.statements
  }

  private cachedStatement(sql: string) {
    let statement = this.dynamicStatements.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.dynamicStatements.set(sql, statement) }
    return statement
  }

  /**
   * Store a new message. It is queued — or dead-lettered with reason
   * `hop-limit` when its hop along the reply chain exceeds the limit.
   */
  enqueue(input: EnqueueInput, now = nowIso()): TeamMessage {
    const id = crypto.randomUUID()
    // Provider recovery continues accepted work; it is not another agent reply.
    const hop = input.inReplyTo ? input.inReplyTo.hop + (input.handoff ? 0 : 1) : 1
    const limit = input.hopLimit ?? DEFAULT_HOP_LIMIT
    const overLimit = !input.handoff && hop > limit
    this.statements.enqueue.run({
      $id: id,
      $teamId: input.teamId,
      $toKind: input.toKind,
      $toId: input.toId,
      $fromSession: input.fromSession,
      // A sender with no session is the human; anything else is an agent.
      $fromKind: input.fromKind ?? (input.fromSession === null ? 'human' : 'agent'),
      $fromGroup: input.fromGroup,
      $originPath: input.originPath,
      $priority: input.priority ?? 'normal',
      $tags: JSON.stringify([...new Set(input.tags ?? [])]),
      $threadId: input.inReplyTo?.threadId ?? id,
      $inReplyTo: input.inReplyTo?.id ?? null,
      $hop: hop,
      $body: input.body,
      $state: overLimit ? 'dead' : 'queued',
      $deliverAt: input.deliverAt ?? null,
      $createdAt: now,
      $reason: overLimit ? 'hop-limit' : null,
      $attachThread: input.attachThread ? 1 : 0,
      $taskId: input.taskId ?? null,
      $handoff: input.handoff ? JSON.stringify(input.handoff) : null,
      $excludedProfile: input.excludedProfile ?? null,
    })
    this.changed(id, true)
    const message = this.get(id)!
    // A new row: nothing was overwritten; the hop-limit reason is the one written.
    this.events.record({
      messageId: id, teamId: message.teamId, kind: overLimit ? 'dead-lettered' : 'sent',
      actor: storeActor(input.actor), at: now,
      facts: { prevState: null, prevClaimedBy: null, prevRecipient: null, prevReason: null, reason: message.reason },
    })
    return message
  }

  get(id: string): TeamMessage | null {
    const row = this.statements.get.get({ $id: id })
    return row ? mapRow(row as Record<string, unknown>) : null
  }

  /**
   * The next message an idle recipient should get: urgent before normal,
   * direct before group, then oldest. Scheduled rows count once due. An
   * `accept` filter (worktree staffing, team-tasks D4) skips rows this
   * recipient may not take, keeping that order for the rest.
   */
  nextEligible(
    recipient: { teamId: string; sessionId: string; groupId: string | null },
    now = nowIso(),
    accept?: (message: TeamMessage) => boolean
  ): TeamMessage | null {
    // all(), not iterate(): leaving an iteration early would leave the shared
    // prepared statement mid-step for its next caller.
    const rows = this.statements.nextEligible.all({
      $teamId: recipient.teamId, $sessionId: recipient.sessionId,
      $groupId: recipient.groupId, $now: now,
    }) as Record<string, unknown>[]
    for (const row of rows) {
      const message = mapRow(row)
      if (!accept || accept(message)) return message
    }
    return null
  }

  /** Due queued group mail of every team, urgent first then oldest (routing). */
  dueGroupMail(now = nowIso()): TeamMessage[] {
    return (this.statements.dueGroupMail.all({ $now: now }) as Record<string, unknown>[]).map(mapRow)
  }

  /** Claim a row reserved for a spawn by the session spawned for it. */
  claimSpawned(id: string, sessionId: string, now = nowIso()): boolean {
    return this.logged(id, () => this.changed(id, this.statements.claimSpawned.run({
      $id: id, $sessionId: sessionId, $now: now,
    }).changes === 1), 'claimed', SYSTEM, now)
  }

  /** Reserve queued mail for a spawn (inside the cap transaction). */
  reserveForSpawn(id: string): boolean {
    return this.transition(id, ['queued'], { state: 'spawning' }, 'reserved')
  }

  /**
   * Due queued group mail whose task targets a worktree, urgent first then
   * oldest, with that target (staffing candidates, team-tasks D4).
   */
  worktreeTaskMail(now = nowIso()): Array<{ message: TeamMessage; worktree: string }> {
    return (this.cachedStatement(worktreeTaskMailSql).all({ $now: now }) as Record<string, unknown>[])
      .map(row => ({ message: mapRow(row), worktree: String(row.task_worktree) }))
  }

  /** Rows left reserved by an interrupted spawn (startup reconciliation). */
  spawningRows(): TeamMessage[] {
    return this.select(`state = 'spawning'`, {})
  }

  /** Atomic claim: true for exactly one caller per queued (or held) message. */
  claim(id: string, sessionId: string, now = nowIso()): boolean {
    return this.logged(id, () => this.changed(id, this.statements.claim.run({
      $id: id, $sessionId: sessionId, $now: now,
    }).changes === 1), 'claimed', SYSTEM, now)
  }

  /** Re-check recipient availability inside the transaction that wins the claim. */
  claimWhen(id: string, sessionId: string, isEligible: () => boolean, reserved = false): boolean {
    return this.db.transaction(() => isEligible() &&
      (reserved ? this.claimSpawned(id, sessionId) : this.claim(id, sessionId)))()
  }

  /** Urgent direct mail held while the recipient's card awaits the human. */
  holdForRequest(id: string): boolean {
    return this.transition(id, ['queued'], { state: 'awaiting-request' }, 'held-for-request')
  }

  /**
   * Written immediately before the turn push (D10 step 2). `taskRevision` is
   * the revision the delivered task context carried (team-message-threads D6);
   * it is snapshotted here so a later amendment never rewrites it.
   */
  markPushed(id: string, now = nowIso(), taskRevision: number | null = null): boolean {
    return this.logged(id, () => this.changed(id, this.statements.markPushed.run({
      $id: id, $now: now, $taskRevision: taskRevision,
    }).changes === 1), 'pushed', SYSTEM, now)
  }

  /**
   * Human-directed mail has no agent to claim or push it: recorded delivered
   * on send (team-message-threads D5), still carrying the task revision the
   * delivery would have.
   */
  deliverOnSend(id: string, taskRevision: number | null = null, now = nowIso()): boolean {
    return this.transition(id, ['queued'], {
      state: 'delivered', delivered_at: now, task_revision: taskRevision,
    }, 'delivered')
  }

  /** The acknowledgement boundary (D10 step 3): the transcript carried the id. */
  markDelivered(id: string, now = nowIso()): boolean {
    return this.logged(id, () => this.changed(id, this.statements.markDelivered.run({ $id: id, $now: now }).changes === 1), 'delivered', SYSTEM, now)
  }

  /** Back to the queue; the claim, push, and any spawn reservation are forgotten. */
  requeue(id: string): boolean {
    return this.transition(id, ['claimed', 'awaiting-request', 'spawning'], {
      state: 'queued', claimed_by: null, claimed_at: null, pushed_at: null,
    }, 'requeued')
  }

  deadLetter(id: string, reason: string, actor: StoreActor = SYSTEM): boolean {
    return this.transition(id, ['queued', 'claimed', 'awaiting-request', 'spawning'], { state: 'dead', reason }, 'dead-lettered', actor)
  }

  /** Receipt neither confirmed nor refuted (D10): out of automatic delivery. */
  holdUncertain(id: string, reason: string): boolean {
    return this.transition(id, ['claimed'], { state: 'uncertain', reason }, 'held-uncertain')
  }

  /** HEAD of the claimant's directory, recorded once after the claim. */
  setClaimCommit(id: string, commit: string): boolean {
    return this.changed(id, this.cachedStatement('UPDATE team_messages SET claim_commit = $commit WHERE id = $id AND claim_commit IS NULL')
      .run({ $id: id, $commit: commit }).changes === 1)
  }

  /** Keep handled work on its agent after a limit, with a resume scheduled. */
  park(id: string, until: string, resumeMessageId: string): boolean {
    const message = this.get(id)
    if (!message) return false
    return this.transition(id, ['delivered', 'parked'], {
      state: 'parked', parked_until: until, resume_message_id: resumeMessageId, park_count: message.parkCount + 1,
    }, 'parked')
  }

  /** The parked agent worked again successfully: the work is simply delivered. */
  unpark(id: string): boolean {
    return this.transition(id, ['parked'], { state: 'delivered', parked_until: null, resume_message_id: null }, 'unparked')
  }

  /**
   * Back to a group's queue after a limit: claim and delivery are forgotten,
   * and direct mail is retargeted to the group of the agent that held it.
   * With no group, keep the direct target and schedule it after recovery.
   */
  release(id: string, groupId: string | null, deliverAt: string | null = null): boolean {
    return this.transition(id, ['delivered', 'parked'], {
      state: 'queued', ...(groupId ? { to_kind: 'group', to_id: groupId } : {}),
      deliver_at: deliverAt, claimed_by: null, claimed_at: null, pushed_at: null,
      delivered_at: null, parked_until: null, resume_message_id: null, claim_commit: null,
    }, 'released')
  }

  /** Handed off: `reason` names the message that carries the work on. */
  markForwarded(id: string, reason: string): boolean {
    return this.transition(id, ['delivered', 'parked'], { state: 'forwarded', reason, parked_until: null, resume_message_id: null }, 'forwarded')
  }

  /** Messages an agent holds parked. */
  parkedBy(sessionId: string): TeamMessage[] {
    return this.select(`state = 'parked' AND claimed_by = $sessionId`, { $sessionId: sessionId })
  }

  /** The parked message a resume message belongs to. */
  parkedFor(resumeMessageId: string): TeamMessage | null {
    return this.select(`state = 'parked' AND resume_message_id = $resume`, { $resume: resumeMessageId })[0] ?? null
  }

  /** Boolean form of {@link cancelResult}: whether the message was cancelled. */
  cancel(id: string, actor: StoreActor, reason?: string): boolean {
    return this.cancelResult(id, actor, reason).ok
  }

  /**
   * Cancel undelivered mail: queued, scheduled, held for a request, or parked.
   * One invariant holds for every caller (team-mailbox-management D2): parked
   * work always has a live resume, or is cancelled together with it.
   * - Parked: a `queued`/`awaiting-request` resume is cancelled with the work
   *   in one transaction, so it can never be claimed afterwards. A `claimed`,
   *   `delivered`, or `uncertain` (possibly delivered) resume means the resume
   *   turn may be in flight: refused (`resume-in-flight`), nothing changed. A
   *   `dead` resume is discarded with the work. Work with no resume is
   *   cancelled alone.
   * - A resume linked to parked work is refused (`linked-resume`) for every
   *   actor; kawai's own replacement goes through {@link replaceResume}.
   * An agent actor's `reason` is written on the row, cut and attributed (D4).
   */
  cancelResult(id: string, actor: StoreActor, reason?: string): CancelResult {
    return this.db.transaction((): CancelResult => {
      const before = this.get(id)
      const changed: CancelResult = { ok: false, code: 'state-changed', state: before?.state ?? null }
      if (!before) return changed
      const resume = before.state === 'parked' && before.resumeMessageId ? this.get(before.resumeMessageId) : null
      if (resume && ['claimed', 'delivered', 'uncertain'].includes(resume.state)) {
        return { ok: false, code: 'resume-in-flight', holder: before.claimedBy, resumeId: resume.id }
      }
      const linked = ['queued', 'awaiting-request'].includes(before.state) ? this.parkedFor(id) : null
      if (linked) return { ok: false, code: 'linked-resume', parkedId: linked.id }
      const cancelled = this.transition(id, ['queued', 'awaiting-request', 'parked'], {
        state: 'cancelled', parked_until: null, resume_message_id: null,
        ...this.actionReason(actor, 'cancelled', reason),
      }, 'cancelled', actor)
      if (!cancelled) return { ...changed, state: this.get(id)?.state ?? null }
      if (resume) this.settleResume(resume, `parked work ${id} cancelled`, actor)
      return { ok: true }
    })()
  }

  /**
   * Kawai's own resume bookkeeping (re-park, unpark, release, forward): unlink
   * the parked row's resume and cancel it if nobody has taken it. The
   * `linked-resume` refusal is for outside callers, not for this.
   */
  replaceResume(parkedId: string): void {
    this.db.transaction(() => {
      const parked = this.get(parkedId)
      if (!parked?.resumeMessageId) return
      const resumeId = parked.resumeMessageId
      this.cachedStatement('UPDATE team_messages SET resume_message_id = NULL WHERE id = $id').run({ $id: parkedId })
      const resume = this.get(resumeId)
      if (resume) this.settleResume(resume, null, SYSTEM)
      this.changed(parkedId, true)
    })()
  }

  /**
   * End a resume nobody has taken: a waiting one is cancelled, a dead one is
   * discarded so a later human Retry cannot revive it for work that moved on.
   * Claimed, delivered, and uncertain resumes may have run and are left alone.
   */
  private settleResume(resume: TeamMessage, reason: string | null, actor: StoreActor): void {
    const set: Record<string, string> = reason ? { reason } : {}
    if (['queued', 'awaiting-request'].includes(resume.state)) {
      this.transition(resume.id, ['queued', 'awaiting-request'], { state: 'cancelled', ...set }, 'cancelled', actor)
    } else if (resume.state === 'dead') {
      this.transition(resume.id, ['dead'], { state: 'discarded', ...set }, 'discarded', actor)
    }
  }

  /** `reason` column update for an agent's cancel or discard; humans write none. */
  private actionReason(actor: StoreActor, verb: 'cancelled' | 'discarded', reason?: string): { reason?: string } {
    if (actor.kind !== 'agent') return {}
    return { reason: `${verb} by ${actor.sessionId}: ${(reason ?? '').trim().slice(0, REASON_LIMIT)}` }
  }

  /**
   * The user retries a dead letter (queued again, its hop reset so the
   * thread may continue) or an uncertain message (to the same recipient only,
   * as direct mail flagged as a possible duplicate).
   */
  retry(id: string): boolean {
    const message = this.get(id)
    const recipient = message?.state === 'uncertain' ? message.claimedBy : message?.toKind === 'session' ? message.toId : null
    if (message && ['dead', 'uncertain'].includes(message.state) && recipient && this.options.recipientExists && !this.options.recipientExists(recipient)) {
      this.transition(id, ['dead', 'uncertain'], {
        state: 'dead', reason: 'killed-recipient', to_kind: 'session', to_id: recipient,
        ...(message.state === 'uncertain' ? { possible_duplicate: 1 } : {}),
      }, 'dead-lettered', HUMAN)
      return false
    }
    if (message?.state === 'dead') {
      return this.transition(id, ['dead'], { state: 'queued', hop: 1, reason: null }, 'retried', HUMAN)
    }
    if (message?.state === 'uncertain' && message.claimedBy) {
      return this.transition(id, ['uncertain'], {
        state: 'queued', to_kind: 'session', to_id: message.claimedBy,
        claimed_by: null, claimed_at: null, pushed_at: null, reason: null, possible_duplicate: 1,
      }, 'retried', HUMAN)
    }
    return false
  }

  /** Discard a dead or uncertain message for good (human, or a mailbox manager). */
  discard(id: string, actor: StoreActor, reason?: string): boolean {
    return this.transition(id, ['dead', 'uncertain'], { state: 'discarded', ...this.actionReason(actor, 'discarded', reason) }, 'discarded', actor)
  }

  /** Direct mail queued for a killed session can never arrive: dead-letter it. */
  deadLetterDirectTo(sessionId: string, reason: string): number {
    return this.db.transaction(() => {
      const affected = this.select(`to_kind = 'session' AND to_id = $sessionId AND state IN ('queued', 'awaiting-request')`, {
        $sessionId: sessionId,
      })
      const count = this.statements.deadLetterDirectTo.run({
        $sessionId: sessionId, $reason: reason,
      }).changes
      for (const before of affected) {
        this.changed(before.id, true)
        this.recordEvent(before, 'dead-lettered', SYSTEM, nowIso(), reason)
      }
      return count
    })()
  }

  /** Claimed rows not yet acknowledged (startup reconciliation, D10). */
  unacknowledgedClaims(): TeamMessage[] {
    return this.select(`state = 'claimed'`, {})
  }

  /**
   * Due urgent direct mail for one recipient, oldest first. Backs the
   * dispatcher's interrupt pass without walking the team's whole mailbox.
   */
  urgentDirectFor(sessionId: string, now = nowIso()): TeamMessage[] {
    return (this.statements.urgentDirectFor.all({ $sessionId: sessionId, $now: now }) as Record<string, unknown>[])
      .map(mapRow)
  }

  /** A session's claimed, unacknowledged rows (turn-end settlement). */
  claimsFor(sessionId: string): TeamMessage[] {
    return (this.statements.claimsFor.all({ $sessionId: sessionId }) as Record<string, unknown>[])
      .map(mapRow)
  }

  /** Confirmed conversation history only; undelivered mail is not context. */
  thread(threadId: string): TeamMessage[] {
    return this.select("thread_id = $threadId AND state = 'delivered'", { $threadId: threadId })
  }

  /** Every message referencing a task, in any state (task detail view). */
  forTask(taskId: string): TeamMessage[] {
    return this.select('task_id = $taskId', { $taskId: taskId })
  }

  /** Urgent direct mail held for a session's pending request. */
  awaitingRequestFor(sessionId: string): TeamMessage[] {
    return this.select(`state = 'awaiting-request' AND to_kind = 'session' AND to_id = $sessionId`, {
      $sessionId: sessionId,
    })
  }

  /** Teams with mail that may be deliverable now. */
  teamsWithQueuedMail(now = nowIso()): string[] {
    return (this.statements.teamsWithQueuedMail.all({ $now: now }) as Array<{ team_id: string }>)
      .map(row => row.team_id)
  }

  /**
   * Direct mail on the waiting surface (team-waiting-reasons D2): queued and
   * due now, or held for the recipient's pending approval or answer. The
   * dispatcher's pass-end reason computation walks exactly these rows.
   */
  waitingDirectMail(now = nowIso()): TeamMessage[] {
    return this.select(
      `to_kind = 'session' AND (state = 'awaiting-request' OR (state = 'queued' AND (deliver_at IS NULL OR deliver_at <= $now)))`,
      { $now: now }
    )
  }

  /** Every row on the waiting surface, every team (queued, awaiting-request, spawning). */
  waitingRows(): TeamMessage[] {
    return this.select(`state IN ('queued', 'awaiting-request', 'spawning')`, {})
  }

  /** Earliest future due time among scheduled rows; null when none. */
  nextDueAt(now = nowIso()): string | null {
    const row = this.statements.nextDueAt.get({ $now: now }) as { due: string | null }
    return row.due
  }

  /** The mailbox view: everything not settled, plus dead and uncertain. */
  listForTeam(teamId: string): TeamMessage[] {
    return this.select(`team_id = $teamId AND state IN ('queued', 'awaiting-request', 'spawning', 'claimed', 'parked', 'dead', 'uncertain')`, {
      $teamId: teamId,
    })
  }

  private select(where: string, params: Record<string, string>): TeamMessage[] {
    return (this.cachedStatement(`SELECT * FROM team_messages WHERE ${where} ORDER BY created_at, rowid`)
      .all(params) as Record<string, unknown>[]).map(mapRow)
  }

  /**
   * Run one state change and log it. The before-row is read inside the same
   * transaction so the event keeps the facts the update overwrites.
   */
  private logged(id: string, run: () => boolean, kind: MessageEventKind, actor: StoreActor = SYSTEM, at = nowIso(), reason: string | null = null): boolean {
    return this.db.transaction(() => {
      const before = this.get(id)
      const changed = run()
      if (changed && before) this.recordEvent(before, kind, actor, at, reason)
      return changed
    })()
  }

  private recordEvent(before: TeamMessage, kind: MessageEventKind, actor: StoreActor, at: string, reason: string | null = null) {
    this.events.record({
      messageId: before.id, teamId: before.teamId, kind, actor, at,
      facts: {
        prevState: before.state,
        prevClaimedBy: before.claimedBy,
        prevRecipient: before.toId,
        prevReason: before.reason,
        reason,
      },
    })
  }

  /** One message's append-only history, oldest first. */
  eventsFor(messageId: string): MessageEvent[] {
    return this.events.forMessage(messageId)
  }

  /** Every recorded event of a thread's messages. */
  threadEvents(threadId: string): MessageEvent[] {
    return this.events.forThread(threadId)
  }

  private transition(
    id: string,
    from: MessageState[],
    set: Record<string, string | number | null>,
    kind: MessageEventKind,
    actor: StoreActor = SYSTEM
  ): boolean {
    const assignments = Object.keys(set).map(column => `${column} = $${column}`).join(', ')
    const states = from.map((_, index) => `$from${index}`).join(', ')
    const params: Record<string, string | number | null> = { $id: id }
    for (const [column, value] of Object.entries(set)) params[`$${column}`] = value
    from.forEach((state, index) => { params[`$from${index}`] = state })
    const newReason = 'reason' in set ? (set.reason as string | null) : null
    return this.logged(id, () => this.changed(id, this.cachedStatement(
      `UPDATE team_messages SET ${assignments} WHERE id = $id AND state IN (${states})`
    ).run(params).changes === 1), kind, actor, nowIso(), newReason)
  }
}
