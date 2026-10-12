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

import type { ChatHandoffPackage, MessageState, MessagePriority, TeamMessage } from '../../shared/team'
export type { MessageState, MessagePriority, TeamMessage } from '../../shared/team'

export interface EnqueueInput {
  teamId: string
  toKind: 'group' | 'session'
  toId: string
  fromSession: string
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
}

export const DEFAULT_HOP_LIMIT = 20

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_messages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_group TEXT,
  origin_path TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  tags TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT NOT NULL,
  in_reply_to TEXT,
  hop INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  deliver_at TEXT,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  delivered_at TEXT,
  reason TEXT,
  possible_duplicate INTEGER NOT NULL DEFAULT 0,
  attach_thread INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  claim_commit TEXT,
  parked_until TEXT,
  park_count INTEGER NOT NULL DEFAULT 0,
  resume_message_id TEXT,
  handoff TEXT,
  excluded_profile TEXT
);
CREATE INDEX IF NOT EXISTS team_messages_queue ON team_messages (team_id, state);
CREATE INDEX IF NOT EXISTS team_messages_thread ON team_messages (thread_id);
CREATE INDEX IF NOT EXISTS team_messages_recipient ON team_messages (to_id, state);
CREATE INDEX IF NOT EXISTS team_messages_claimant ON team_messages (claimed_by, state);
`

/** Columns added after the table first shipped, for databases that predate them. */
function migrateTable(db: Database) {
  const columns = db.prepare('PRAGMA table_info(team_messages)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'task_id')) db.exec('ALTER TABLE team_messages ADD COLUMN task_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS team_messages_task ON team_messages (task_id)')
  // Profile routing: claim commit, parking, and handoff.
  for (const [name, type] of [
    ['claim_commit', 'TEXT'], ['parked_until', 'TEXT'], ['park_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['resume_message_id', 'TEXT'], ['handoff', 'TEXT'], ['excluded_profile', 'TEXT'],
  ] as const) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE team_messages ADD COLUMN ${name} ${type}`)
  }
}

const nowIso = () => new Date().toISOString()

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
  constructor(private readonly db: Database, private readonly options: { recipientExists?: (id: string) => boolean } = {}) {
    db.exec(CREATE_TABLE_SQL)
    migrateTable(db)
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
    const hop = input.inReplyTo ? input.inReplyTo.hop + 1 : 1
    const limit = input.hopLimit ?? DEFAULT_HOP_LIMIT
    const overLimit = hop > limit
    this.statements.enqueue.run({
      $id: id,
      $teamId: input.teamId,
      $toKind: input.toKind,
      $toId: input.toId,
      $fromSession: input.fromSession,
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
    return this.get(id)!
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
    return this.changed(id, this.statements.claimSpawned.run({
      $id: id, $sessionId: sessionId, $now: now,
    }).changes === 1)
  }

  /** Reserve queued mail for a spawn (inside the cap transaction). */
  reserveForSpawn(id: string): boolean {
    return this.transition(id, ['queued'], { state: 'spawning' })
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
    return this.changed(id, this.statements.claim.run({
      $id: id, $sessionId: sessionId, $now: now,
    }).changes === 1)
  }

  /** Re-check recipient availability inside the transaction that wins the claim. */
  claimWhen(id: string, sessionId: string, isEligible: () => boolean, reserved = false): boolean {
    return this.db.transaction(() => isEligible() &&
      (reserved ? this.claimSpawned(id, sessionId) : this.claim(id, sessionId)))()
  }

  /** Urgent direct mail held while the recipient's card awaits the human. */
  holdForRequest(id: string): boolean {
    return this.transition(id, ['queued'], { state: 'awaiting-request' })
  }

  /** Written immediately before the turn push (D10 step 2). */
  markPushed(id: string, now = nowIso()): boolean {
    return this.changed(id, this.statements.markPushed.run({ $id: id, $now: now }).changes === 1)
  }

  /** The acknowledgement boundary (D10 step 3): the transcript carried the id. */
  markDelivered(id: string, now = nowIso()): boolean {
    return this.changed(id, this.statements.markDelivered.run({ $id: id, $now: now }).changes === 1)
  }

  /** Back to the queue; the claim, push, and any spawn reservation are forgotten. */
  requeue(id: string): boolean {
    return this.transition(id, ['claimed', 'awaiting-request', 'spawning'], {
      state: 'queued', claimed_by: null, claimed_at: null, pushed_at: null,
    })
  }

  deadLetter(id: string, reason: string): boolean {
    return this.transition(id, ['queued', 'claimed', 'awaiting-request', 'spawning'], { state: 'dead', reason })
  }

  /** Receipt neither confirmed nor refuted (D10): out of automatic delivery. */
  holdUncertain(id: string, reason: string): boolean {
    return this.transition(id, ['claimed'], { state: 'uncertain', reason })
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
    })
  }

  /** The parked agent worked again successfully: the work is simply delivered. */
  unpark(id: string): boolean {
    return this.transition(id, ['parked'], { state: 'delivered', parked_until: null, resume_message_id: null })
  }

  /**
   * Back to a group's queue after a limit: claim and delivery are forgotten,
   * and direct mail is retargeted to the group of the agent that held it.
   */
  release(id: string, groupId: string): boolean {
    return this.transition(id, ['delivered', 'parked'], {
      state: 'queued', to_kind: 'group', to_id: groupId, claimed_by: null, claimed_at: null, pushed_at: null,
      delivered_at: null, parked_until: null, resume_message_id: null, claim_commit: null,
    })
  }

  /** Handed off: `reason` names the message that carries the work on. */
  markForwarded(id: string, reason: string): boolean {
    return this.transition(id, ['delivered', 'parked'], { state: 'forwarded', reason, parked_until: null, resume_message_id: null })
  }

  /** Messages an agent holds parked. */
  parkedBy(sessionId: string): TeamMessage[] {
    return this.select(`state = 'parked' AND claimed_by = $sessionId`, { $sessionId: sessionId })
  }

  /** The parked message a resume message belongs to. */
  parkedFor(resumeMessageId: string): TeamMessage | null {
    return this.select(`state = 'parked' AND resume_message_id = $resume`, { $resume: resumeMessageId })[0] ?? null
  }

  /** The user cancels a queued or scheduled message. */
  cancel(id: string): boolean {
    return this.transition(id, ['queued', 'awaiting-request'], { state: 'cancelled' })
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
      })
      return false
    }
    if (message?.state === 'dead') {
      return this.transition(id, ['dead'], { state: 'queued', hop: 1, reason: null })
    }
    if (message?.state === 'uncertain' && message.claimedBy) {
      return this.transition(id, ['uncertain'], {
        state: 'queued', to_kind: 'session', to_id: message.claimedBy,
        claimed_by: null, claimed_at: null, pushed_at: null, reason: null, possible_duplicate: 1,
      })
    }
    return false
  }

  /** The user discards a dead or uncertain message for good. */
  discard(id: string): boolean {
    return this.transition(id, ['dead', 'uncertain'], { state: 'discarded' })
  }

  /** Direct mail queued for a killed session can never arrive: dead-letter it. */
  deadLetterDirectTo(sessionId: string, reason: string): number {
    const affected = this.statements.directIds.all({ $sessionId: sessionId }) as Array<{ id: string }>
    const count = this.statements.deadLetterDirectTo.run({
      $sessionId: sessionId, $reason: reason,
    }).changes
    for (const row of affected) this.changed(row.id, true)
    return count
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

  private transition(id: string, from: MessageState[], set: Record<string, string | number | null>): boolean {
    const assignments = Object.keys(set).map(column => `${column} = $${column}`).join(', ')
    const states = from.map((_, index) => `$from${index}`).join(', ')
    const params: Record<string, string | number | null> = { $id: id }
    for (const [column, value] of Object.entries(set)) params[`$${column}`] = value
    from.forEach((state, index) => { params[`$from${index}`] = state })
    return this.changed(id, this.cachedStatement(`UPDATE team_messages SET ${assignments} WHERE id = $id AND state IN (${states})`)
      .run(params).changes === 1)
  }
}

function mapRow(row: Record<string, unknown>): TeamMessage {
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
    toKind: row.to_kind === 'group' ? 'group' : 'session',
    toId: String(row.to_id),
    fromSession: String(row.from_session),
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
    claimCommit: text(row.claim_commit),
    parkedUntil: text(row.parked_until),
    parkCount: Number(row.park_count ?? 0),
    resumeMessageId: text(row.resume_message_id),
    handoff: parseHandoff(row.handoff),
    excludedProfile: text(row.excluded_profile),
  }
}

function parseHandoff(value: unknown): ChatHandoffPackage | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value) as ChatHandoffPackage
    return parsed && typeof parsed === 'object' && typeof parsed.fromSession === 'string' ? parsed : null
  } catch {
    // A corrupt package reads as none; the message itself stays usable.
    return null
  }
}
