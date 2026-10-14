// E08 headless (task-results-handoffs 8.2): Release worktree and hand off is
// refused with an actionable reason while the developer is mid-turn and
// while it awaits an approval — nothing archived, nothing dispatched — and
// after the request is resolved and the turn ends, one retry performs
// exactly one release and one review dispatch.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import { resolveTeam } from '../team/teamIdentity'
import type { ChatEvent } from '../../shared/chat'
import { fixtureEnv, fixtureManager, fixtureRepo, waitFor } from './fixtures/fixtureTeam'

test('E08: release refused while busy and while awaiting approval; after resolution, exactly one release and one dispatch', async () => {
  const { root, repo, worktree } = fixtureRepo('kawai-e08-', { devs: 'max: 3', reviewers: 'max: 3' })
  const restore = fixtureEnv(root, '1500')
  const manager = fixtureManager(root, new Map<string, ChatEvent[]>())
  try {
    const team = await resolveTeam(repo)
    const human = { kind: 'human' as const, team }
    const mail = manager.mailbox.store
    const task = await manager.tasks.create(human, { title: 'Export', direction: 'CSV export', worktree })
    const dispatched = await manager.assignments.dispatch(human, {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Please build it', requestKey: 'e08-assign',
    })
    await waitFor(() => mail.get(dispatched.message!.id)?.state === 'delivered', 'instruction delivered')
    const dev = mail.get(dispatched.message!.id)!.claimedBy!
    await waitFor(() => manager.getSnapshot(dev)?.status === 'waiting', 'developer idle')
    await manager.results.submit({ kind: 'agent', sessionId: dev }, task.id, { summary: 'CSV export', commit: 'abc123' })
    const request = { target: 'reviewers', instructions: 'Review the export', requestKey: 'e08-release' }
    const reviews = () => mail.forTask(task.id).filter(message => message.toId === 'reviewers')
    const nothingHappened = () => {
      expect(manager.isArchived(dev)).toBe(false)
      expect(reviews()).toEqual([])
    }

    // Mid-turn: refused, naming the developer and that it is busy.
    await manager.send(dev, 'keep thinking about edge cases')
    await waitFor(() => manager.getSnapshot(dev)?.status === 'working', 'developer busy')
    await expect(manager.results.release!.release(human, task.id, request)).rejects.toThrow(`(${dev}): it is busy`)
    nothingHappened()
    await waitFor(() => manager.getSnapshot(dev)?.status === 'waiting', 'turn ended', 30_000)

    // Awaiting an approval: refused, naming the pending request.
    await manager.send(dev, 'please approval')
    await waitFor(() => manager.getPendingRequests(dev).length > 0, 'pending approval')
    await expect(manager.results.release!.release(human, task.id, request)).rejects.toThrow('awaiting an approval or answer')
    nothingHappened()

    // Resolved, turn ended: one retry, exactly one release and one dispatch.
    const pending = manager.getPendingRequests(dev)[0]!
    expect(manager.resolveApproval(dev, pending.requestId, 'allow').ok).toBe(true)
    await waitFor(() => manager.getSnapshot(dev)?.status === 'waiting' && manager.getPendingRequests(dev).length === 0, 'approval resolved and turn ended', 30_000)
    const outcome = await manager.results.release!.release(human, task.id, request)
    expect(outcome).toMatchObject({ released: [dev], handoff: { duplicate: false, assignment: { handoffKind: 'review' } } })
    expect(manager.isArchived(dev)).toBe(true)
    expect(reviews()).toHaveLength(1)
    expect(manager.tasks.store.journal(task.id).filter(entry => entry.author.kind === 'system' && entry.text.startsWith(`Released`))).toHaveLength(1)
  } finally {
    manager.shutdown()
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
