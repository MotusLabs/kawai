// E10 headless (task-results-handoffs 8.3): a contributor's result on a
// human-created task leaves it open and the contributor's accept writes
// nothing; an amendment flags the result Needs re-evaluation; a finished
// child never closes its parent; the human accepts over open child work
// only with a journaled reason; a restart keeps results, findings, and the
// acceptance.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import { resolveTeam } from '../team/teamIdentity'
import type { ChatEvent } from '../../shared/chat'
import { fixtureEnv, fixtureManager, fixtureRepo, waitFor } from './fixtures/fixtureTeam'

test('E10: guarded acceptance, needs re-evaluation, children never close parents, and restart keeps the record', async () => {
  const { root, repo, worktree } = fixtureRepo('kawai-e10-', { devs: 'max: 3' })
  const restore = fixtureEnv(root)
  let manager = fixtureManager(root, new Map<string, ChatEvent[]>())
  try {
    const team = await resolveTeam(repo)
    const human = { kind: 'human' as const, team }
    const task = await manager.tasks.create(human, { title: 'Export', direction: 'CSV export', acceptance: 'Exports every row', worktree })
    const dispatched = await manager.assignments.dispatch(human, {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Please build it', requestKey: 'e10-assign',
    })
    const mail = manager.mailbox.store
    await waitFor(() => mail.get(dispatched.message!.id)?.state === 'delivered', 'instruction delivered')
    const dev = { kind: 'agent' as const, sessionId: mail.get(dispatched.message!.id)!.claimedBy! }
    await waitFor(() => manager.getSnapshot(dev.sessionId)?.status === 'waiting', 'contributor idle')

    // The contributor's result leaves the task open; its accept is refused and writes nothing.
    const result = await manager.results.submit(dev, task.id, { summary: 'CSV export', commit: 'abc123' })
    const findings = await manager.results.submitFindings(dev, task.id, { resultId: result.id, kind: 'review', verdict: 'pass', findings: 'Self-check' })
    const journalBefore = manager.tasks.store.journal(task.id).length
    await expect(manager.results.accept(dev, task.id, result.id, 'it is done')).rejects.toThrow('accept its results and close it')
    expect(manager.tasks.store.get(task.id)?.status).toBe('open')
    expect(manager.tasks.store.results.get(result.id)).toMatchObject({ acceptedAt: null, acceptedBy: null })
    expect(manager.tasks.store.journal(task.id)).toHaveLength(journalBefore)

    // An amendment flags the earlier result.
    await manager.tasks.amend(human, task.id, { direction: 'CSV and TSV export' })
    expect(manager.tasks.store.results.get(result.id)?.needsReevaluation).toBe(true)

    // A finished child never closes its parent; an open child stays open work.
    const finished = await manager.tasks.create(human, { title: 'Headers', direction: 'Header row', parent_id: task.id })
    const open = await manager.tasks.create(human, { title: 'Docs', direction: 'Document it', parent_id: task.id })
    await manager.tasks.setStatus(human, finished.id, 'done')
    expect(manager.tasks.store.get(task.id)?.status).toBe('open')

    // The human accepts only with a stated reason, which is journaled.
    await expect(manager.results.accept(human, task.id, result.id)).rejects.toThrow('needs a stated reason; nothing was accepted')
    expect(manager.tasks.store.results.get(result.id)?.acceptedAt).toBeNull()
    const accepted = await manager.results.accept(human, task.id, result.id, 'TSV follows in Docs')
    expect(accepted.openChildren.map(child => child.id)).toEqual([open.id])
    expect(accepted.task.status).toBe('done')
    expect(manager.tasks.store.journal(task.id).some(entry => entry.author.kind === 'human' && entry.text.includes('TSV follows in Docs'))).toBe(true)
    expect(manager.tasks.store.get(open.id)?.status).toBe('open')

    // A restart keeps the results, findings, and acceptance.
    manager.shutdown()
    manager = fixtureManager(root, new Map<string, ChatEvent[]>())
    const reread = manager.tasks.store.results.get(result.id)!
    expect(reread).toMatchObject({ acceptedBy: { kind: 'human' }, needsReevaluation: true, submittedBy: dev })
    expect(reread.acceptedAt).not.toBeNull()
    expect(reread.findings.map(entry => entry.id)).toEqual([findings.id])
    expect(manager.tasks.store.get(task.id)?.status).toBe('done')
    expect(manager.tasks.store.detail(task.id)?.task.outstandingResult).toMatchObject({ id: result.id, accepted: true })
  } finally {
    manager.shutdown()
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
