// The decision note (chat-context-exhaustion D6): after the exhaustion
// outcome commits, kawai records the flagged episode once — keyed by session
// and flag time in `team_exhaustion_episodes`, so a repeated evaluation sends
// nothing — and, for a session bound to a task, sends one normal-priority
// direct note tagged `context-exhausted` to whoever dispatched the work: the
// dropped message's assignment's dispatcher, else the outstanding
// assignment's, else the task's creator. Nothing is sent when that is the
// human, a killed, archived, or flagged session; the attention item (D8)
// then asks the human. The note is self-sent like kawai's resume and handoff
// notes, so a reply never targets the flagged session. Kawai never compacts.
import type { Database } from 'bun:sqlite'
import type { ChatContextExhausted, ChatUsageReport } from '../../shared/chat'
import type { TeamTaskAssignment } from '../../shared/teamTasks'
import type { ChatSessionRecord } from '../db'
import { runGitAsync } from '../git/gitCommand'
import { outstandingOf } from './assignmentStore'
import type { ExhaustionOutcome } from './contextExhaustion'
import type { GroupDefinition } from './groupFile'
import type { MailboxStore, TeamMessage } from './mailboxStore'
import type { TaskStore } from './taskStore'

export const CONTEXT_EXHAUSTED_TAG = 'context-exhausted'

/** One flagged episode as recorded (D6/D8). */
export interface ExhaustionEpisode {
  sessionId: string
  flaggedAt: string
  teamId: string
  reason: string
  taskId: string | null
  droppedId: string | null
  /** The note's recipient; null when none was eligible (the human decides). */
  recipientSession: string | null
  noteId: string | null
  createdAt: string
}

export interface ExhaustionNotesOptions {
  store: MailboxStore
  tasks: TaskStore
  getRecord: (id: string) => ChatSessionRecord | undefined
  teamOf: (sessionId: string) => string | undefined
  groupOf: (sessionId: string, groupId: string) => GroupDefinition | undefined
  usageOf: (profileId: string) => ChatUsageReport | null
  cooldownUntil: (profileId: string) => string | null
  /** HEAD of a directory; defaults to `git rev-parse HEAD`. */
  head?: (cwd: string) => Promise<string | null>
}

const gitHead = async (cwd: string): Promise<string | null> => {
  const result = await runGitAsync(['rev-parse', 'HEAD'], { cwd })
  return result.ok && result.stdout.trim() ? result.stdout.trim() : null
}

const toEpisode = (row: Record<string, unknown>): ExhaustionEpisode => ({
  sessionId: String(row.session_id),
  flaggedAt: String(row.flagged_at),
  teamId: String(row.team_id),
  reason: String(row.reason),
  taskId: row.task_id === null ? null : String(row.task_id),
  droppedId: row.dropped_id === null ? null : String(row.dropped_id),
  recipientSession: row.recipient_session === null ? null : String(row.recipient_session),
  noteId: row.note_id === null ? null : String(row.note_id),
  createdAt: String(row.created_at),
})

export class ExhaustionNotes {
  constructor(private readonly db: Database, private readonly options: ExhaustionNotesOptions) {}

  /** Every recorded episode of a team, oldest first (the attention read). */
  episodes(teamId: string): ExhaustionEpisode[] {
    return (this.db.prepare('SELECT * FROM team_exhaustion_episodes WHERE team_id = ? ORDER BY created_at, rowid')
      .all(teamId) as Record<string, unknown>[]).map(toEpisode)
  }

  /**
   * Record the session's current episode and send its note, once. The
   * episode row and the recipient are written synchronously, before the
   * HEAD read, so a second evaluation of the same episode finds the row.
   * Resolves to the note, or null when nothing was sent.
   */
  async record(outcome: ExhaustionOutcome): Promise<TeamMessage | null> {
    const record = this.options.getRecord(outcome.sessionId)
    const flag = record?.contextExhausted
    const teamId = this.options.teamOf(outcome.sessionId)
    if (!record || !flag || !teamId) return null
    const taskId = record.taskId ?? outcome.dropped?.taskId ?? null
    const task = taskId ? this.options.tasks.get(taskId) : null
    const recipient = task ? this.recipientFor(task.id, task.creator, outcome.dropped, outcome.sessionId) : null
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO team_exhaustion_episodes
      (session_id, flagged_at, team_id, reason, task_id, dropped_id, recipient_session, note_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(outcome.sessionId, flag.at, teamId, flag.reason, task?.id ?? null, outcome.dropped?.id ?? null,
        recipient?.sessionId ?? null, new Date().toISOString()).changes === 1
    if (!inserted || !task || !recipient) return null
    const head = await (this.options.head ?? gitHead)(record.projectPath).catch(() => null)
    const note = this.options.store.enqueue({
      teamId, toKind: 'session', toId: recipient.sessionId, fromSession: recipient.sessionId,
      fromGroup: recipient.groupId ?? null, originPath: recipient.projectPath, tags: [CONTEXT_EXHAUSTED_TAG],
      taskId: task.id,
      body: this.body(record, flag, task, outcome, head),
    })
    this.db.prepare('UPDATE team_exhaustion_episodes SET note_id = ? WHERE session_id = ? AND flagged_at = ?')
      .run(note.id, outcome.sessionId, flag.at)
    return note
  }

  /**
   * Who dispatched the work: the dropped message's assignment, else the
   * outstanding one, else the task's creator. Null when that is the human,
   * or a killed, archived, or flagged session (or the flagged one itself).
   */
  private recipientFor(
    taskId: string, creator: { kind: string; sessionId?: string | null },
    dropped: TeamMessage | null, flaggedId: string,
  ): ChatSessionRecord | null {
    const assignments: TeamTaskAssignment[] = this.options.tasks.assignmentsOf(taskId)
    const assignment = (dropped ? assignments.find(row => row.messageId === dropped.id) : undefined) ?? outstandingOf(assignments)
    const party = assignment ? assignment.createdBy : creator
    if (party.kind !== 'agent' || !party.sessionId || party.sessionId === flaggedId) return null
    const record = this.options.getRecord(party.sessionId)
    if (!record || record.archivedAt != null || record.contextExhausted) return null
    return record
  }

  private body(
    record: ChatSessionRecord, flag: ChatContextExhausted, task: { id: string; title: string; revision: number },
    outcome: ExhaustionOutcome, head: string | null,
  ): string {
    const dropped = outcome.dropped
    const progress = outcome.progress
    const acknowledged = this.options.tasks.acknowledgements.highest(task.id, record.sessionId)
    const lines = [
      `[context-exhausted] Session ${record.name} (${record.sessionId}) working on task "${task.title}" (${task.id}) ` +
        `stopped: its context is exhausted (${flag.reason}, since ${flag.at}). It takes no mail until the human compacts it; kawai never does.`,
      `Worker: profile ${record.claudeProfileId ?? 'default'}${record.model ? `, model ${record.model}` : ''}.`,
      dropped
        ? `Dropped message: ${dropped.id} — ${dropped.state === 'dead' ? `dead-lettered ${dropped.reason ?? ''}`.trim() : `now ${dropped.state}${dropped.toKind === 'group' ? ` for group ${dropped.toId}` : ''}`}.`
        : 'Dropped message: none tracked.',
      ...outcome.released.filter(row => row.id !== dropped?.id).map(row =>
        `Parked work ${row.id} ${row.state === 'queued' ? `returned to group ${row.toId}` : `dead-lettered ${row.reason ?? ''}`.trim()}.`),
      progress
        ? `Progress since its claim: ${progress.toolCalls} tool call${progress.toolCalls === 1 ? '' : 's'}` +
          `${progress.tools.length > 0 ? ` (${progress.tools.join(', ')})` : ''}; files touched: ` +
          `${progress.filesTouched.length > 0 ? progress.filesTouched.join(', ') : 'none recorded'}.`
        : 'Progress since its claim: unknown.',
      `Commit at claim: ${outcome.claimCommit ?? 'unknown'}. HEAD now: ${head ?? 'unknown'} (in ${record.projectPath}).`,
      `Task revision ${task.revision}: ${acknowledged !== null && acknowledged >= task.revision
        ? 'acknowledged by it.'
        : `not acknowledged by it (its last acknowledgement: ${acknowledged === null ? 'none' : `revision ${acknowledged}`}).`}`,
      ...this.providerLines(record),
      'Decide how to continue: dispatch the work again to a group or another session — on a provider with headroom when its limit is near — ' +
        'or ask the human to /compact this session. Mail and retries to it are refused while it is flagged.',
    ]
    return lines.join('\n')
  }

  /** Usage and cooldown of each provider of the session's group (its own profile without a group). */
  private providerLines(record: ChatSessionRecord): string[] {
    const group = record.groupId ? this.options.groupOf(record.sessionId, record.groupId) : undefined
    const profiles = group && group.profiles.length > 0
      ? group.profiles.map(profile => profile.profileId)
      : [record.claudeProfileId ?? 'default']
    return [
      `Providers${group ? ` of group ${group.id}` : ''}:`,
      ...profiles.map(profileId => {
        const usage = this.options.usageOf(profileId)
        const windows = usage && usage.windows.length > 0
          ? usage.windows.map(window => `${window.label} ${Math.round(window.percentUsed)}%${window.resetsAt ? ` (resets ${window.resetsAt})` : ''}`).join(', ')
          : 'no usage reported'
        const cooling = this.options.cooldownUntil(profileId)
        return `- ${profileId}: ${windows}; ${cooling ? `cooling until ${cooling}` : 'not cooling'}.`
      }),
    ]
  }
}
