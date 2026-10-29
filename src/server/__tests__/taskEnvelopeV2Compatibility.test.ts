// Task-header generations (bounded-log-reads-and-task-get design D7, C1;
// rows V3–V7): new task mail records generation 2 and its bounded journal
// line, an explicit 1 or an absent version keeps the legacy renderer and
// round-trips as recorded, and a version that is unknown, not an integer,
// set without a task, or not matching its header does not parse. The
// literals here are written by hand with independently stated expectations
// — the header lines included — and the current generation is also driven
// through the real dispatcher, receipt extractors, reconcile, and both
// runtimes' replay. The frozen pre-change fixtures (V1–V2) stay in
// taskEnvelopeCompatibility.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatPeerMessage } from '../../shared/chat'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { parseTranscriptContent } from '../chat/transcriptReplay'
import { parseCodexRollout } from '../chat/codex/codexRollout'
import { MailDispatcher, type MailRecipient } from '../team/dispatcher'
import { formatEnvelope, parseEnvelope } from '../team/envelope'
import { MailboxStore } from '../team/mailboxStore'
import { mailboxHandlers } from '../team/mailboxTools'
import { codexReceiptMessageId, receiptMessageId, reconcileMailbox, transcriptReceipt } from '../team/receipt'
import { buildTaskContext } from '../team/taskContext'
import { TaskStore } from '../team/taskStore'
import { TeamMailbox } from '../team/TeamMailbox'
import { clearTeamCache, resolveTeam } from '../team/teamIdentity'

const GEN1 = 'Latest journal entries (task_get has the full journal):'
const GEN2 = 'Latest journal entries (task_get pages the journal with journal_before and journal_limit; task_journal_read returns any entry whole):'

/** The attribute escaping of a recorded envelope, written out for the literals below. */
const attr = (json: string) => json.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const wrap = (metadata: string, text: string) => `<kawai-message metadata="${attr(metadata)}">\n${text}\n</kawai-message>`

const PEER = '"senderSession":"chat-lead-0001","senderKind":"agent","senderGroup":"lead","priority":"normal","originPath":"/repo","tags":[]'
const TASK = '"task":{"id":"task-v-0001","title":"Export","status":"active","revision":4,"direction":"Ship it.","acceptance":"Downloads work.","openspecChange":"add-export","worktree":"/repo/.worktrees/export","journal":[{"author":"chat-dev-0002","text":"Halfway <b> & on.","createdAt":"2026-10-20T08:00:00.000Z"}],"plan":{"id":"plan-0001","title":"Exports","revision":2,"change":"add-export"},"execution":{"id":"exec-0001","revision":2}}'
const HEADER = (journalLine: string) => [
  '[Task task-v-0001: Export] status active, revision 4',
  'Worktree: /repo/.worktrees/export',
  'Plan: Exports (revision 2), change add-export',
  'Execution: exec-0001 running plan revision 2',
  'Linked OpenSpec change: add-export. Its proposal, design, and tasks are the authoritative direction; the text below summarizes them.',
  'Direction:',
  'Ship it.',
  'Acceptance criteria:',
  'Downloads work.',
  journalLine,
  '- 2026-10-20T08:00:00.000Z chat-dev-0002: Halfway <b> & on.',
  '[Message]',
].join('\n')
const HANDOFF = '"handoff":{"fromSession":"chat-dev-0002","fromProfile":"glm","claimCommit":null,"lastError":"429 quota","progress":{"toolCalls":1,"tools":["Edit"],"filesTouched":["src/a.ts"]}}'
const HANDOFF_HEADER = [
  '[Handoff] Session chat-dev-0002 (profile glm) hit a provider limit and handed this work on.',
  'Progress since it claimed the work: 1 tool call (Edit).',
  'Files touched: src/a.ts.',
  'Last error: 429 quota.',
  'Before acting, reconstruct its progress from the working directory: run `git status` and inspect what changed.',
].join('\n')

const ids = { current: 'b1c2d3e4-0001-4a00-8000-000000000001', duplicate: 'b1c2d3e4-0002-4a00-8000-000000000002', explicit: 'b1c2d3e4-0003-4a00-8000-000000000003', absent: 'b1c2d3e4-0004-4a00-8000-000000000004' }
const meta = (id: string, extra: string, duplicate = false) => `{"messageId":"${id}",${PEER},"threadId":"${id}","possibleDuplicate":${duplicate},${extra}}`

/** Generation 2 with a non-empty journal, a plan, and an execution. */
const CURRENT = wrap(meta(ids.current, `${TASK},"taskHeaderVersion":2`), `${HEADER(GEN2)}\nBuild the export.`)
/** Generation 2 with a duplicate notice, a handoff, and a revision notice. */
const CURRENT_DUPLICATE = wrap(meta(ids.duplicate, `${TASK},"taskHeaderVersion":2,${HANDOFF},"revisionNotice":{"revision":4,"previousRevision":3,"assignmentId":"asg-1","rationale":null}`, true),
  `Possible duplicate: if you have already seen this message id, treat it as a no-op.\n${HEADER(GEN2)}\n${HANDOFF_HEADER}\nContinue.`)
/** An explicit generation 1. */
const EXPLICIT_LEGACY = wrap(meta(ids.explicit, `${TASK},"taskHeaderVersion":1`), `${HEADER(GEN1)}\nOld wording.`)
/** No version: the legacy generation, as recorded before the change. */
const ABSENT_LEGACY = wrap(meta(ids.absent, TASK), `${HEADER(GEN1)}\nRecorded before.`)

const TASK_OBJECT = {
  id: 'task-v-0001', title: 'Export', status: 'active', revision: 4, direction: 'Ship it.', acceptance: 'Downloads work.',
  openspecChange: 'add-export', worktree: '/repo/.worktrees/export',
  journal: [{ author: 'chat-dev-0002', text: 'Halfway <b> & on.', createdAt: '2026-10-20T08:00:00.000Z' }],
  plan: { id: 'plan-0001', title: 'Exports', revision: 2, change: 'add-export' }, execution: { id: 'exec-0001', revision: 2 },
}
const base = (id: string, body: string, possibleDuplicate = false) => ({
  messageId: id, senderSession: 'chat-lead-0001', senderKind: 'agent', senderGroup: 'lead', priority: 'normal', originPath: '/repo',
  tags: [], threadId: id, possibleDuplicate, body,
})
const EXPECTED = {
  [ids.current]: { ...base(ids.current, 'Build the export.'), task: TASK_OBJECT, taskHeaderVersion: 2 },
  [ids.duplicate]: {
    ...base(ids.duplicate, 'Continue.', true), task: TASK_OBJECT, taskHeaderVersion: 2,
    handoff: { fromSession: 'chat-dev-0002', fromProfile: 'glm', claimCommit: null, lastError: '429 quota', progress: { toolCalls: 1, tools: ['Edit'], filesTouched: ['src/a.ts'] } },
    revisionNotice: { revision: 4, previousRevision: 3, assignmentId: 'asg-1', rationale: null },
  },
  [ids.explicit]: { ...base(ids.explicit, 'Old wording.'), task: TASK_OBJECT, taskHeaderVersion: 1 },
  [ids.absent]: { ...base(ids.absent, 'Recorded before.'), task: TASK_OBJECT },
} as Record<string, ChatPeerMessage>

const claudeRow = (envelope: string) => JSON.stringify({ type: 'user', uuid: 'u-1', timestamp: '2026-10-21T00:00:00.000Z', message: { role: 'user', content: envelope } })
const codexRow = (envelope: string) => JSON.stringify({ timestamp: '2026-10-21T00:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: envelope }] } })
const replayed = (envelope: string) => [parseTranscriptContent(`${claudeRow(envelope)}\n`).events, parseCodexRollout(`${codexRow(envelope)}\n`)]

describe.each([
  { name: 'V4 generation 2', id: ids.current, envelope: CURRENT },
  { name: 'V4/V7 generation 2 with duplicate, handoff, and revision notice', id: ids.duplicate, envelope: CURRENT_DUPLICATE },
  { name: 'V3 explicit generation 1', id: ids.explicit, envelope: EXPLICIT_LEGACY },
  { name: 'V3 absent generation', id: ids.absent, envelope: ABSENT_LEGACY },
])('$name', ({ id, envelope }) => {
  test('parses to the stated message and renders back to the same bytes', () => {
    const parsed = parseEnvelope(envelope)
    expect(parsed).toEqual(EXPECTED[id]!)
    expect('taskHeaderVersion' in parsed!).toBe(id !== ids.absent)
    expect(formatEnvelope(parsed!)).toBe(envelope)
  })

  test('both receipt extractors find its id, and replay yields a peer message in both runtimes', () => {
    expect(receiptMessageId(claudeRow(envelope))).toBe(id)
    expect(codexReceiptMessageId(codexRow(envelope))).toBe(id)
    for (const events of replayed(envelope)) {
      expect(events.filter(event => event.type === 'user_message')).toEqual([])
      expect(events.find(event => event.type === 'peer_message')).toMatchObject({ messageId: id, body: EXPECTED[id]!.body })
    }
  })
})

describe('mismatched, unknown, and malformed generations (V5–V7)', () => {
  // @covers: team-tasks › Delivered task context stays compatible across header generations › Mismatched or unknown generation
  test('a header of the other generation, an unknown or non-integer version, or a version without a task does not parse', () => {
    expect(parseEnvelope(CURRENT.replace(GEN2, GEN1))).toBeNull()
    expect(parseEnvelope(EXPLICIT_LEGACY.replace(GEN1, GEN2))).toBeNull()
    expect(parseEnvelope(ABSENT_LEGACY.replace(GEN1, GEN2))).toBeNull()
    for (const version of ['3', '0', '1.5', '&quot;2&quot;', 'null', 'true', '[2]']) {
      const text = CURRENT.replace('&quot;taskHeaderVersion&quot;:2', `&quot;taskHeaderVersion&quot;:${version}`)
      expect(text).not.toBe(CURRENT)
      expect(parseEnvelope(text)).toBeNull()
    }
    for (const version of [1, 2]) {
      const taskless = wrap(meta(ids.current, `"taskHeaderVersion":${version}`), 'Plain note.')
      expect(parseEnvelope(taskless)).toBeNull()
    }
    const plain = wrap(`{"messageId":"${ids.current}",${PEER},"threadId":"${ids.current}","possibleDuplicate":false}`, 'Plain note.')
    expect(parseEnvelope(plain)).toEqual(base(ids.current, 'Plain note.') as ChatPeerMessage)
    // The renderer refuses the same states rather than writing an envelope the parser would reject.
    expect(() => formatEnvelope({ ...EXPECTED[ids.current]!, task: undefined })).toThrow('Invalid task header version: 2')
    expect(() => formatEnvelope({ ...EXPECTED[ids.current]!, taskHeaderVersion: 3 as never })).toThrow('Invalid task header version: 3')
  })

  test('a tampered header and an ordinary tag mention do not parse; an empty journal renders one header in both generations', () => {
    expect(parseEnvelope(CURRENT.replace('Ship it.\nAcceptance', 'Ship nothing.\nAcceptance'))).toBeNull()
    expect(parseEnvelope(CURRENT.replace('Halfway <b> & on.\n[Message]', 'Halfway.\n[Message]'))).toBeNull()
    expect(parseEnvelope(`See <kawai-message metadata="x">\n${HEADER(GEN2)}\n</kawai-message> in the docs`)).toBeNull()
    const empty = { ...EXPECTED[ids.current]!, task: { ...TASK_OBJECT, journal: [] } } as ChatPeerMessage
    const { taskHeaderVersion: _, ...legacy } = empty
    const [current, recorded] = [formatEnvelope(empty), formatEnvelope(legacy)]
    expect(current).not.toContain('Latest journal entries')
    expect(current.slice(current.indexOf('">'))).toBe(recorded.slice(recorded.indexOf('">')))
    expect(parseEnvelope(current)).toEqual(empty)
    expect(parseEnvelope(recorded)).toEqual(legacy)
  })

  test('plan, execution, handoff, revision notice, and duplicate survive generation 1 as they do generation 2', () => {
    const { taskHeaderVersion: _, ...absent } = EXPECTED[ids.duplicate]!
    for (const message of [absent, { ...absent, taskHeaderVersion: 1 as const }]) {
      const text = formatEnvelope(message)
      expect(text).toContain(GEN1)
      expect(text).not.toContain(GEN2)
      expect(parseEnvelope(text)).toEqual(message)
    }
  })
})

describe('current task mail through the real dispatcher (V4)', () => {
  let dir: string
  let db: SessionDatabase
  let store: MailboxStore
  let tasks: TaskStore
  let mailbox: TeamMailbox
  let teamId: string
  const records = new Map<string, ChatSessionRecord>()
  const row = (id: string, projectPath: string): ChatSessionRecord => ({
    sessionId: id, projectPath, groupId: 'devs', name: id, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  })

  beforeEach(async () => {
    clearTeamCache()
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-envelope-v2-')))
    const project = path.join(dir, 'project')
    fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), 'Build.')
    records.set('lead', row('lead', project)).set('dev', row('dev', project))
    db = initDatabase({ path: path.join(dir, 'db.sqlite') })
    store = new MailboxStore(db.db)
    tasks = new TaskStore(db.db, store)
    mailbox = new TeamMailbox(store, { getSession: id => records.get(id), homeDir: dir, tasks })
    teamId = (await resolveTeam(project)).teamId
  })
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  /** Send `body` (under a task with a journal when `withTask`), dispatch it to dev, and return the pushed envelope. */
  const dispatch = async (withTask: boolean) => {
    const task = tasks.create({ teamId, title: 'Export', direction: 'CSV', creator: { kind: 'agent', sessionId: 'lead' } })
    tasks.appendJournal(task.id, { kind: 'agent', sessionId: 'qa' }, 'JSON needs a schema')
    const mail = await mailboxHandlers(mailbox, 'lead').send_message({ to_kind: 'group', to_id: 'devs', body: 'Build it', ...(withTask ? { task_id: task.id } : {}) })
    const recipients: MailRecipient[] = [{ sessionId: 'dev', teamId, groupId: 'devs', idle: true, pendingRequest: false, available: true }]
    const delivered: ChatPeerMessage[] = []
    const dispatcher = new MailDispatcher(store, {
      recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
      deliver: (_id, peer) => { delivered.push(peer); recipients[0]!.idle = false },
      watchReceipt: () => {}, taskContext: id => buildTaskContext(tasks, id),
    })
    dispatcher.notify(); await dispatcher.settled(); dispatcher.close()
    expect(delivered).toHaveLength(1)
    expect(store.get(mail.id)?.state).toBe('claimed')
    return { id: mail.id, peer: delivered[0]!, text: formatEnvelope(delivered[0]!) }
  }
  const transcript = (content: string) => {
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, content)
    return file
  }

  // @covers: team-tasks › Delivered task context stays compatible across header generations › Current task mail carries its generation
  // @covers: team-tasks › Agents are told task_get is bounded › Header stops promising the full journal
  test('new task mail carries generation 2 and the bounded header, parses back, and its receipt completes it (Claude)', async () => {
    const { id, peer, text } = await dispatch(true)
    expect(peer.taskHeaderVersion).toBe(2)
    expect(text).toContain(`${GEN2}\n- `)
    expect(text).not.toContain('full journal')
    expect(text).toContain('&quot;taskHeaderVersion&quot;:2')
    expect(parseEnvelope(text)).toEqual(peer)
    expect(receiptMessageId(claudeRow(text))).toBe(id)
    expect(codexReceiptMessageId(codexRow(text))).toBe(id)
    for (const events of replayed(text)) {
      expect(events.filter(event => event.type === 'user_message')).toEqual([])
      expect(events.find(event => event.type === 'peer_message')).toMatchObject({ messageId: id, body: 'Build it', taskHeaderVersion: 2 })
    }
    reconcileMailbox(store, () => transcript(`${claudeRow(text)}\n`))
    expect(store.get(id)?.state).toBe('delivered')
  })

  test('its Codex rollout receipt completes it; a clean transcript requeues it', async () => {
    const first = await dispatch(true)
    const file = transcript(`${codexRow(first.text)}\n`)
    reconcileMailbox(store, () => file, (_session, messageId) => transcriptReceipt(file, messageId, codexReceiptMessageId))
    expect(store.get(first.id)?.state).toBe('delivered')
    const second = await dispatch(true)
    reconcileMailbox(store, () => transcript(`${claudeRow('Other turn')}\n`))
    expect(store.get(second.id)?.state).toBe('queued')
  })

  // @covers: team-tasks › Delivered task context stays compatible across header generations › Task mail recorded before the bounded header
  test('mail without a task keeps the old shape; recorded legacy task mail still completes as delivered', async () => {
    const { peer, text } = await dispatch(false)
    expect('taskHeaderVersion' in peer).toBe(false)
    expect(text).not.toContain('taskHeaderVersion')
    expect(text).not.toContain('[Task')
    expect(parseEnvelope(text)).toEqual(peer)
    // A pushed claim whose transcript holds the absent-version literal is found, not requeued.
    const legacy = await dispatch(true)
    const recorded = ABSENT_LEGACY.replaceAll(ids.absent, legacy.id)
    expect(parseEnvelope(recorded)).toMatchObject({ messageId: legacy.id, body: 'Recorded before.' })
    reconcileMailbox(store, () => transcript(`${claudeRow(recorded)}\n`))
    expect(store.get(legacy.id)?.state).toBe('delivered')
  })
})
