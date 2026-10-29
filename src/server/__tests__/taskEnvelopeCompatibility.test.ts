// Legacy task envelopes (bounded-log-reads-and-task-get design D7, C1; rows
// V1–V2): task mail recorded before the bounded header must keep parsing,
// keep its receipt, and replay as a peer message. The fixtures are literal
// envelopes in the format of base 567ec21e — the header line "Latest journal
// entries (task_get has the full journal):" included — written by hand with
// independently stated expectations, never produced by a renderer under
// test. They pin the producers and parsers as they are; rows V3–V7 and the
// versioned header land with the registration commit, and these rows alone
// do not fix C1.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schemaDb } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { parseEnvelope } from '../team/envelope'
import { codexReceiptMessageId, receiptMessageId, reconcileMailbox, transcriptReceipt } from '../team/receipt'
import { parseTranscriptContent } from '../chat/transcriptReplay'
import { parseCodexRollout } from '../chat/codex/codexRollout'

const TASK_ID = '6f1c2a3b-4d5e-4f60-8172-93a4b5c6d7e8'
const DUPLICATE_ID = '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d'
const EMPTY_JOURNAL_ID = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
const NO_TASK_ID = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'

/** A task envelope with a non-empty journal, a plan, a worktree, and a linked change. */
const LEGACY_TASK = `<kawai-message metadata="{&quot;messageId&quot;:&quot;${TASK_ID}&quot;,&quot;senderSession&quot;:&quot;chat-lead-0001&quot;,&quot;senderKind&quot;:&quot;agent&quot;,&quot;senderGroup&quot;:&quot;lead&quot;,&quot;priority&quot;:&quot;normal&quot;,&quot;originPath&quot;:&quot;/repo&quot;,&quot;tags&quot;:[&quot;review&quot;],&quot;threadId&quot;:&quot;${TASK_ID}&quot;,&quot;possibleDuplicate&quot;:false,&quot;task&quot;:{&quot;id&quot;:&quot;task-legacy-0001&quot;,&quot;title&quot;:&quot;Legacy export&quot;,&quot;status&quot;:&quot;active&quot;,&quot;revision&quot;:3,&quot;direction&quot;:&quot;Ship the CSV export.&quot;,&quot;acceptance&quot;:&quot;Downloads work.&quot;,&quot;openspecChange&quot;:&quot;add-export&quot;,&quot;worktree&quot;:&quot;/repo/.worktrees/export&quot;,&quot;journal&quot;:[{&quot;author&quot;:&quot;chat-lead-0001&quot;,&quot;text&quot;:&quot;Started the export.&quot;,&quot;createdAt&quot;:&quot;2026-10-01T09:00:00.000Z&quot;},{&quot;author&quot;:&quot;human&quot;,&quot;text&quot;:&quot;Keep the header row &amp; &lt;b&gt;.&quot;,&quot;createdAt&quot;:&quot;2026-10-02T10:30:00.000Z&quot;}],&quot;plan&quot;:{&quot;id&quot;:&quot;plan-0001&quot;,&quot;title&quot;:&quot;Exports&quot;,&quot;revision&quot;:2,&quot;change&quot;:&quot;add-export&quot;}}}">
[Task task-legacy-0001: Legacy export] status active, revision 3
Worktree: /repo/.worktrees/export
Plan: Exports (revision 2), change add-export
Linked OpenSpec change: add-export. Its proposal, design, and tasks are the authoritative direction; the text below summarizes them.
Direction:
Ship the CSV export.
Acceptance criteria:
Downloads work.
Latest journal entries (task_get has the full journal):
- 2026-10-01T09:00:00.000Z chat-lead-0001: Started the export.
- 2026-10-02T10:30:00.000Z human: Keep the header row & <b>.
[Message]
Please review the export.
Second line.
</kawai-message>`

/** A possible-duplicate redelivery of a task envelope owned by an execution, journal non-empty. */
const LEGACY_DUPLICATE = `<kawai-message metadata="{&quot;messageId&quot;:&quot;${DUPLICATE_ID}&quot;,&quot;senderSession&quot;:null,&quot;senderKind&quot;:&quot;system&quot;,&quot;senderGroup&quot;:null,&quot;priority&quot;:&quot;urgent&quot;,&quot;originPath&quot;:&quot;/repo&quot;,&quot;tags&quot;:[],&quot;threadId&quot;:&quot;thread-0002&quot;,&quot;possibleDuplicate&quot;:true,&quot;task&quot;:{&quot;id&quot;:&quot;task-legacy-0002&quot;,&quot;title&quot;:&quot;Owned change&quot;,&quot;status&quot;:&quot;open&quot;,&quot;revision&quot;:1,&quot;direction&quot;:&quot;Line one.\\nLine two.&quot;,&quot;acceptance&quot;:null,&quot;openspecChange&quot;:null,&quot;worktree&quot;:null,&quot;journal&quot;:[{&quot;author&quot;:&quot;system&quot;,&quot;text&quot;:&quot;Dispatched.&quot;,&quot;createdAt&quot;:&quot;2026-10-03T08:00:00.000Z&quot;}],&quot;execution&quot;:{&quot;id&quot;:&quot;exec-0002&quot;,&quot;revision&quot;:4}}}">
Possible duplicate: if you have already seen this message id, treat it as a no-op.
[Task task-legacy-0002: Owned change] status open, revision 1
Execution: exec-0002 running plan revision 4
Direction:
Line one.
Line two.
Latest journal entries (task_get has the full journal):
- 2026-10-03T08:00:00.000Z system: Dispatched.
[Message]
Continue.
</kawai-message>`

/** Control: a task envelope with an empty journal (no journal line at all). */
const LEGACY_EMPTY_JOURNAL = `<kawai-message metadata="{&quot;messageId&quot;:&quot;${EMPTY_JOURNAL_ID}&quot;,&quot;senderSession&quot;:&quot;chat-lead-0001&quot;,&quot;senderKind&quot;:&quot;agent&quot;,&quot;senderGroup&quot;:&quot;lead&quot;,&quot;priority&quot;:&quot;normal&quot;,&quot;originPath&quot;:&quot;/repo&quot;,&quot;tags&quot;:[],&quot;threadId&quot;:&quot;${EMPTY_JOURNAL_ID}&quot;,&quot;possibleDuplicate&quot;:false,&quot;task&quot;:{&quot;id&quot;:&quot;task-legacy-0003&quot;,&quot;title&quot;:&quot;Fresh&quot;,&quot;status&quot;:&quot;open&quot;,&quot;revision&quot;:1,&quot;direction&quot;:&quot;Start.&quot;,&quot;acceptance&quot;:null,&quot;openspecChange&quot;:null,&quot;worktree&quot;:null,&quot;journal&quot;:[]}}">
[Task task-legacy-0003: Fresh] status open, revision 1
Direction:
Start.
[Message]
Go.
</kawai-message>`

/** Control: an envelope without a task. */
const LEGACY_NO_TASK = `<kawai-message metadata="{&quot;messageId&quot;:&quot;${NO_TASK_ID}&quot;,&quot;senderSession&quot;:&quot;chat-dev-0002&quot;,&quot;senderKind&quot;:&quot;agent&quot;,&quot;senderGroup&quot;:null,&quot;priority&quot;:&quot;normal&quot;,&quot;originPath&quot;:&quot;/repo&quot;,&quot;tags&quot;:[],&quot;threadId&quot;:&quot;${NO_TASK_ID}&quot;,&quot;possibleDuplicate&quot;:false}">
Plain peer note.
</kawai-message>`

const EXPECTED = {
  [TASK_ID]: {
    messageId: TASK_ID, senderSession: 'chat-lead-0001', senderKind: 'agent', senderGroup: 'lead', priority: 'normal',
    originPath: '/repo', tags: ['review'], threadId: TASK_ID, possibleDuplicate: false, body: 'Please review the export.\nSecond line.',
    task: {
      id: 'task-legacy-0001', title: 'Legacy export', status: 'active', revision: 3, direction: 'Ship the CSV export.',
      acceptance: 'Downloads work.', openspecChange: 'add-export', worktree: '/repo/.worktrees/export',
      journal: [
        { author: 'chat-lead-0001', text: 'Started the export.', createdAt: '2026-10-01T09:00:00.000Z' },
        { author: 'human', text: 'Keep the header row & <b>.', createdAt: '2026-10-02T10:30:00.000Z' },
      ],
      plan: { id: 'plan-0001', title: 'Exports', revision: 2, change: 'add-export' },
    },
  },
  [DUPLICATE_ID]: {
    messageId: DUPLICATE_ID, senderSession: null, senderKind: 'system', senderGroup: null, priority: 'urgent',
    originPath: '/repo', tags: [], threadId: 'thread-0002', possibleDuplicate: true, body: 'Continue.',
    task: {
      id: 'task-legacy-0002', title: 'Owned change', status: 'open', revision: 1, direction: 'Line one.\nLine two.',
      acceptance: null, openspecChange: null, worktree: null,
      journal: [{ author: 'system', text: 'Dispatched.', createdAt: '2026-10-03T08:00:00.000Z' }],
      execution: { id: 'exec-0002', revision: 4 },
    },
  },
  [EMPTY_JOURNAL_ID]: {
    messageId: EMPTY_JOURNAL_ID, senderSession: 'chat-lead-0001', senderKind: 'agent', senderGroup: 'lead', priority: 'normal',
    originPath: '/repo', tags: [], threadId: EMPTY_JOURNAL_ID, possibleDuplicate: false, body: 'Go.',
    task: { id: 'task-legacy-0003', title: 'Fresh', status: 'open', revision: 1, direction: 'Start.', acceptance: null, openspecChange: null, worktree: null, journal: [] },
  },
  [NO_TASK_ID]: {
    messageId: NO_TASK_ID, senderSession: 'chat-dev-0002', senderKind: 'agent', senderGroup: null, priority: 'normal',
    originPath: '/repo', tags: [], threadId: NO_TASK_ID, possibleDuplicate: false, body: 'Plain peer note.',
  },
} as const

const FIXTURES = [
  { name: 'V1 task, non-empty journal', id: TASK_ID, envelope: LEGACY_TASK },
  { name: 'V1 possible duplicate, execution', id: DUPLICATE_ID, envelope: LEGACY_DUPLICATE },
  { name: 'V2 empty journal', id: EMPTY_JOURNAL_ID, envelope: LEGACY_EMPTY_JOURNAL },
  { name: 'V2 no task', id: NO_TASK_ID, envelope: LEGACY_NO_TASK },
] as const

const claudeRow = (envelope: string) => JSON.stringify({ type: 'user', uuid: 'u-1', timestamp: '2026-10-04T00:00:00.000Z', message: { role: 'user', content: envelope } })
const codexRow = (envelope: string) => JSON.stringify({ timestamp: '2026-10-04T00:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: envelope }] } })

describe.each(FIXTURES)('$name', ({ id, envelope }) => {
  let dir: string
  let db: Database
  let store: MailboxStore
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-legacy-envelope-'))
    db = schemaDb(':memory:')
    store = new MailboxStore(db)
  })
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  /** A pushed, unsettled claim stored under the fixture's id, as a restart finds it. */
  const pushedClaim = () => {
    const uuid = spyOn(crypto, 'randomUUID').mockReturnValueOnce(id as `${string}-${string}-${string}-${string}-${string}`)
    try {
      const message = store.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'Work' })
      expect(message.id).toBe(id)
    } finally { uuid.mockRestore() }
    store.claim(id, 'dev')
    store.markPushed(id)
  }
  const transcript = (content: string) => {
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, content)
    return file
  }

  test('parses to the stated message, the body as peer content', () => {
    expect(parseEnvelope(envelope)).toEqual(EXPECTED[id] as never)
  })

  test('both receipt extractors find its id', () => {
    expect(receiptMessageId(claudeRow(envelope))).toBe(id)
    expect(codexReceiptMessageId(codexRow(envelope))).toBe(id)
  })

  test('reconcile completes the pushed claim as delivered and never requeues it (Claude transcript)', () => {
    pushedClaim()
    reconcileMailbox(store, () => transcript(`${claudeRow(envelope)}\n`))
    expect(store.get(id)?.state).toBe('delivered')
    expect(store.nextEligible({ teamId: 'team', sessionId: 'dev', groupId: 'devs' })).toBeNull()
  })

  test('reconcile completes the pushed claim as delivered (Codex rollout)', () => {
    pushedClaim()
    const file = transcript(`${codexRow(envelope)}\n`)
    reconcileMailbox(store, () => file, (_session, messageId) => transcriptReceipt(file, messageId, codexReceiptMessageId))
    expect(store.get(id)?.state).toBe('delivered')
  })

  test('control: a clean transcript without the envelope still refutes receipt and requeues', () => {
    pushedClaim()
    reconcileMailbox(store, () => transcript(`${claudeRow('Other turn')}\n`))
    expect(store.get(id)?.state).toBe('queued')
  })

  test('replay yields a peer message, not raw user text, in both runtimes', () => {
    const claude = parseTranscriptContent(`${claudeRow(envelope)}\n`).events
    const codex = parseCodexRollout(`${codexRow(envelope)}\n`)
    for (const events of [claude, codex]) {
      expect(events.filter(event => event.type === 'user_message')).toEqual([])
      const peer = events.find(event => event.type === 'peer_message') as Record<string, unknown> | undefined
      expect(peer).toMatchObject({ messageId: id, body: EXPECTED[id].body })
    }
  })
})
