// Limit outcomes for claimed work (profile-routing design D8–D10). Kawai
// tracks, per session, the mail its current turn handles (a delivered
// message, or the parked message a resume belongs to) and the tool calls it
// runs for it. A final limit event marks the turn; when that turn ends, the
// message is resolved — park, release, or forward (limitPolicy.ts):
// - park: the message stays on the agent (state `parked`, which keeps the
//   agent out of group pickup) and a resume message to it is scheduled at
//   the provider's reset;
// - release: back to the group queue, or scheduled to the same session
//   after recovery when direct mail's recipient belongs to no group;
// - forward: a new message to a group or session carries the work on with a
//   handoff package and never routes back to the limited profile; the
//   original agent gets a note naming the task and its new owner once its
//   profile has recovered (durable `team_handoff_notes` rows).
// A successful turn of a parked agent — a human message or the resume —
// unparks it and cancels any resume still queued.
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../../db'
import type { ChatHandoffPackage } from '../../../shared/team'
import type { LimitEvent, LimitOutcome, LimitOutcomeContext } from '../../../shared/routing'
import { runGitAsync } from '../../git/gitCommand'
import type { GroupDefinition } from '../groupFile'
import { DEFAULT_PARK_IF_RESET_WITHIN_MS } from '../groupFile'
import type { MailboxStore, TeamMessage } from '../mailboxStore'
import { ProgressDigest } from './handoff'
import { DEFAULT_COOLDOWN_MS, type LimitEventStore } from './limitEvents'
import { resolveLimit, type LimitResolution } from './limitPolicy'
import type { RuleRegistry } from './ruleLoader'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_handoff_notes (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  from_session TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  forwarded_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified_at TEXT
);
`

const SYSTEM = { kind: 'system' } as const

export type HandoffTarget = { kind: 'group' | 'session'; id: string }

export interface LimitOutcomesOptions {
  store: MailboxStore
  limits: LimitEventStore
  rules: Pick<RuleRegistry, 'rule'>
  getRecord: (id: string) => ChatSessionRecord | undefined
  /** The session's team id; undefined while resolving. */
  teamOf: (id: string) => string | undefined
  /** A group of the session's team. */
  groupOf: (sessionId: string, groupId: string) => GroupDefinition | undefined
  taskTitle: (taskId: string) => string | null
  targetWorktree?: (message: TeamMessage) => string | null
  restoreSession?: (id: string) => void
  onError: (error: unknown) => void
  now?: () => number
}

export class LimitOutcomes {
  /** Session → id of the message its current turn works on. */
  private readonly active = new Map<string, string>()
  /** Message id → tool calls since its claim. */
  private readonly digests = new Map<string, ProgressDigest>()
  /** Session → the final limit event of its current turn. */
  private readonly pending = new Map<string, LimitEvent>()

  constructor(private readonly db: Database, private readonly options: LimitOutcomesOptions) {
    db.exec(CREATE_TABLE_SQL)
    options.limits.subscribe(event => { if (event.final) this.pending.set(event.sessionId, event) })
  }

  private now() { return this.options.now?.() ?? Date.now() }

  /** Mail was claimed: remember the claimant's HEAD for a later handoff. */
  claimed(message: TeamMessage, sessionId: string): void {
    const cwd = this.options.getRecord(sessionId)?.projectPath
    if (!cwd || message.claimCommit) return
    // A `.then` rejection handler does not see a throw from its own
    // fulfillment handler, so the write that follows the git call has to hang
    // off `.catch` — otherwise a store torn down before the call resolves
    // surfaces as an unhandled rejection.
    void runGitAsync(['rev-parse', 'HEAD'], { cwd }).then(result => {
      if (result.ok && result.stdout.trim()) this.options.store.setClaimCommit(message.id, result.stdout.trim())
    }).catch(this.options.onError)
  }

  /** Mail was pushed as the session's next turn. */
  delivered(sessionId: string, message: TeamMessage): void {
    const workId = this.options.store.parkedFor(message.id)?.id ?? message.id
    this.active.set(sessionId, workId)
    if (!this.digests.has(workId)) this.digests.set(workId, new ProgressDigest())
  }

  /** A tool call in the session's transcript. */
  toolCall(sessionId: string, tool: string, input: unknown): void {
    const workId = this.active.get(sessionId)
    if (workId) this.digests.get(workId)?.record(tool, input)
  }

  /** The session's turn ended (after its mail was settled). */
  async turnEnded(sessionId: string, success: boolean): Promise<void> {
    const event = this.pending.get(sessionId)
    this.pending.delete(sessionId)
    const workId = this.active.get(sessionId)
    this.active.delete(sessionId)
    if (event && workId) {
      await this.resolve(workId, sessionId, event)
      return
    }
    if (success && !event) {
      // Only a human turn or this work's own resume can complete parked work.
      for (const parked of this.options.store.parkedBy(sessionId)) {
        if (!workId || workId === parked.id) this.unpark(parked)
      }
    }
  }

  /** The human hands a parked message to a group or session (spec: Users can hand off parked work). */
  handOff(messageId: string, target: HandoffTarget): TeamMessage {
    const message = this.options.store.get(messageId)
    if (!message || message.state !== 'parked' || !message.claimedBy) throw new Error('Only parked work can be handed off')
    const holder = this.options.getRecord(message.claimedBy)
    const profileId = holder?.claudeProfileId ?? 'default'
    const lastError = this.options.limits.forProfile(profileId).filter(event => event.final).at(-1)?.message ?? null
    return this.forward(message, message.claimedBy, profileId, lastError, target)
  }

  /** Send due recovery notes; returns nothing, mail goes through the queue. */
  processNotes(): void {
    const rows = this.db.prepare('SELECT * FROM team_handoff_notes WHERE notified_at IS NULL').all() as NoteRow[]
    for (const row of rows) {
      try {
        if (this.options.limits.cooldownUntil(row.profile_id)) continue
        const forwarded = this.options.store.get(row.forwarded_id)
        const owner = forwarded?.claimedBy
        const recipient = this.options.getRecord(row.from_session)
        if (!recipient || !forwarded) {
          this.markNoted(row.id)
          continue
        }
        if (!owner) continue
        const original = this.options.store.get(row.original_id)
        const task = original?.taskId ? this.options.taskTitle(original.taskId) : null
        const ownerName = this.options.getRecord(owner)?.name ?? owner
        this.options.store.enqueue({
          teamId: row.team_id, toKind: 'session', toId: row.from_session, fromSession: row.from_session,
          fromGroup: recipient.groupId ?? null, originPath: recipient.projectPath, tags: ['handoff-note'],
          taskId: original?.taskId ?? null,
          body: `Your provider limit has recovered. While it was limited, your work${task ? ` on task "${task}"` : ''} ` +
            `(message ${row.original_id}) was handed to ${ownerName} (session ${owner}). It is theirs now; do not continue it.`,
        })
        this.markNoted(row.id)
      } catch (error) {
        this.options.onError(error)
      }
    }
  }

  /** When the next note could become due (a pending note's cooldown end). */
  nextNoteAt(): number | null {
    const rows = this.db.prepare('SELECT DISTINCT profile_id FROM team_handoff_notes WHERE notified_at IS NULL').all() as Array<{ profile_id: string }>
    const ends = rows.map(row => this.options.limits.cooldownUntil(row.profile_id)).filter((end): end is string => end !== null).map(Date.parse)
    return ends.length > 0 ? Math.min(...ends) : null
  }

  private markNoted(id: string) {
    this.db.prepare('UPDATE team_handoff_notes SET notified_at = ? WHERE id = ?').run(new Date(this.now()).toISOString(), id)
  }

  private unpark(message: TeamMessage) {
    this.digests.delete(message.id)
    this.options.store.replaceResume(message.id)
    this.options.store.unpark(message.id)
  }

  private async resolve(workId: string, sessionId: string, event: LimitEvent): Promise<void> {
    const store = this.options.store
    const message = store.get(workId)
    // Work cancelled mid-resume (team-mailbox-management D2) is simply dropped:
    // no park, release, or forward, and no digest left behind.
    if (!message || !['delivered', 'parked'].includes(message.state)) { this.digests.delete(workId); return }
    const record = this.options.getRecord(sessionId)
    const groupId = message.toKind === 'group' ? message.toId : record?.groupId ?? null
    const group = groupId ? this.options.groupOf(sessionId, groupId) : undefined
    const policy = group?.onLimit ?? { parkIfResetWithinMs: DEFAULT_PARK_IF_RESET_WITHIN_MS, otherwise: 'forward' as const }
    const digest = this.digests.get(workId) ?? new ProgressDigest()
    const now = this.now()
    const resetsAt = this.resetTime(event)
    const ruled = await this.askRule(group, {
      now: new Date(now).toISOString(), profileId: event.profileId, sessionId, groupId,
      message: { id: message.id, priority: message.priority, senderGroup: message.fromGroup, tags: message.tags, worktree: this.options.targetWorktree?.(message) ?? null, taskId: message.taskId,
        ...(message.handoff ? { forwardedFromProfile: message.handoff.fromProfile } : {}),
      },
      kind: event.kind, status: event.status, error: event.message, resetsAt, parkCount: message.parkCount,
      progress: { toolCalls: digest.toolCalls, filesTouched: [...digest.files] },
    })
    // A manual handoff or cancel can settle parked work while an async rule is running.
    if (!['delivered', 'parked'].includes(store.get(workId)?.state ?? '')) { this.digests.delete(workId); return }
    const resolution: LimitResolution = resolveLimit({
      toolCalls: digest.toolCalls, resetInMs: Date.parse(resetsAt) - now, parkCount: message.parkCount, policy,
      ...(ruled ? { ruled } : {}),
    })
    // If recovery has already happened, retry without briefly pausing the agent.
    if (resolution.type === 'park' && Date.parse(resetsAt) > this.now()) {
      this.park(message, sessionId, record, resetsAt)
    } else if (resolution.type === 'forward') {
      const target = resolution.to ?? this.forwardTarget(sessionId, policy.forwardTo, groupId)
      try {
        if (target) {
          this.forward(message, sessionId, event.profileId, event.message, target)
          return
        }
      } catch (error) {
        this.options.onError(error)
      }
      // A bad explicit destination must not discard the handoff context.
      if (groupId && !(target?.kind === 'group' && target.id === groupId)) {
        try {
          this.forward(message, sessionId, event.profileId, event.message, { kind: 'group', id: groupId })
          return
        } catch (error) { this.options.onError(error) }
      }
      this.release(message, groupId, resetsAt)
    } else {
      this.release(message, groupId, resetsAt)
    }
  }

  /** Without a group, retry direct work on its original session after recovery. */
  private release(message: TeamMessage, groupId: string | null, resetsAt: string) {
    this.options.store.replaceResume(message.id)
    this.options.store.release(message.id, groupId, groupId ? null : resetsAt)
    this.digests.delete(message.id)
  }

  private async askRule(group: GroupDefinition | undefined, ctx: LimitOutcomeContext): Promise<LimitOutcome | undefined> {
    const rule = group ? this.options.rules.rule(group.id) : undefined
    if (!rule?.hasOnLimit) return undefined
    try {
      return await rule.onLimit(ctx)
    } catch (error) {
      this.options.onError(new Error(`onLimit rule for ${group!.id} failed; using the group policy: ${error instanceof Error ? error.message : String(error)}`))
      return undefined
    }
  }

  /** The provider's reset, else the built-in cooldown end. */
  private resetTime(event: LimitEvent): string {
    const reset = event.resetsAt ? Date.parse(event.resetsAt) : NaN
    return new Date(Number.isFinite(reset) ? reset : Date.parse(event.at) + DEFAULT_COOLDOWN_MS).toISOString()
  }

  private park(message: TeamMessage, sessionId: string, record: ChatSessionRecord | undefined, resetsAt: string) {
    const store = this.options.store
    store.replaceResume(message.id)
    const resume = store.enqueue({
      teamId: message.teamId, toKind: 'session', toId: sessionId, fromSession: sessionId,
      fromGroup: record?.groupId ?? null, originPath: record?.projectPath ?? message.originPath,
      tags: ['resume'], taskId: message.taskId, deliverAt: resetsAt,
      body: `Your provider limit has reset. Continue the work from message ${message.id}` +
        `${message.taskId ? ` (task ${message.taskId})` : ''} where you left off; check \`git status\` first.`,
    })
    if (!store.park(message.id, resetsAt, resume.id)) store.cancel(resume.id, SYSTEM)
  }

  /** Resolve a frontmatter `forwardTo`: a team group, else a team session, else the same group. */
  private forwardTarget(sessionId: string, forwardTo: string | undefined, sameGroup: string | null): HandoffTarget | null {
    if (forwardTo) {
      if (this.options.groupOf(sessionId, forwardTo)) return { kind: 'group', id: forwardTo }
      const team = this.options.teamOf(sessionId)
      if (team && this.options.getRecord(forwardTo) && this.options.teamOf(forwardTo) === team) return { kind: 'session', id: forwardTo }
      this.options.onError(new Error(`onLimit.forwardTo "${forwardTo}" is not a group or session of this team; forwarding to the same group`))
    }
    return sameGroup ? { kind: 'group', id: sameGroup } : null
  }

  private forward(message: TeamMessage, fromSession: string, profileId: string, lastError: string | null, target: HandoffTarget): TeamMessage {
    const store = this.options.store
    if (target.kind === 'session') {
      const recipient = this.options.getRecord(target.id)
      if (!recipient || this.options.teamOf(target.id) !== message.teamId) throw new Error('Handoff recipient is not a session of this team')
      if ((recipient.claudeProfileId ?? 'default') === profileId) throw new Error(`Cannot hand off work to its limited profile ${profileId}`)
      if (recipient.archivedAt) {
        if (!this.options.restoreSession) throw new Error('Restoring the handoff recipient is not available')
        this.options.restoreSession(target.id)
      }
    } else if (!this.options.groupOf(fromSession, target.id)) {
      throw new Error(`Unknown handoff group: ${target.id}`)
    }
    const digest = this.digests.get(message.id) ?? new ProgressDigest()
    const handoff: ChatHandoffPackage = {
      fromSession, fromProfile: profileId, claimCommit: message.claimCommit, lastError, progress: digest.snapshot(),
    }
    const forwarded = store.enqueue({
      teamId: message.teamId, toKind: target.kind, toId: target.id, fromSession: message.fromSession,
      fromGroup: message.fromGroup, originPath: message.originPath, priority: message.priority, tags: message.tags,
      body: message.body, inReplyTo: message, attachThread: true, taskId: message.taskId,
      handoff, excludedProfile: profileId,
    })
    store.replaceResume(message.id)
    store.markForwarded(message.id, `forwarded: ${forwarded.id}`)
    this.digests.delete(message.id)
    this.db.prepare(`INSERT INTO team_handoff_notes (id, team_id, from_session, profile_id, original_id, forwarded_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), message.teamId, fromSession, profileId, message.id, forwarded.id,
      new Date(this.now()).toISOString())
    return forwarded
  }
}

interface NoteRow {
  id: string
  team_id: string
  from_session: string
  profile_id: string
  original_id: string
  forwarded_id: string
}
