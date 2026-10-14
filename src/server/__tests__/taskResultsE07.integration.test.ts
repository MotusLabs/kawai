// E07 headless (task-results-handoffs 8.1): a developer spawned into the
// task's worktree submits a result; a review handoff queues behind it with
// the worktree-occupied waiting reason; Release worktree and hand off
// archives the developer — result and transcript kept — and the queued
// review reaches exactly one reviewer spawned into the freed worktree;
// findings stay on the examined result and a newer result inherits none.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import { resolveTeam } from '../team/teamIdentity'
import type { ChatEvent } from '../../shared/chat'
import { fixtureEnv, fixtureManager, fixtureRepo, waitFor } from './fixtures/fixtureTeam'

test('E07: result, queued review, release and hand off to one reviewer, findings bound to the examined result', async () => {
  const { root, repo, worktree } = fixtureRepo('kawai-e07-', { devs: 'max: 3', reviewers: 'max: 3' })
  const restore = fixtureEnv(root)
  const events = new Map<string, ChatEvent[]>()
  const manager = fixtureManager(root, events)
  try {
    const team = await resolveTeam(repo)
    const human = { kind: 'human' as const, team }
    const mail = manager.mailbox.store
    const task = await manager.tasks.create(human, { title: 'Export', direction: 'CSV export', worktree })
    // A developer is spawned into the worktree for the instruction and takes it.
    const dispatched = await manager.assignments.dispatch(human, {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Please build it', requestKey: 'e07-assign',
    })
    await waitFor(() => mail.get(dispatched.message!.id)?.state === 'delivered', 'instruction delivered')
    const dev = mail.get(dispatched.message!.id)!.claimedBy!
    await waitFor(() => manager.getSnapshot(dev)?.status === 'waiting', 'developer idle')
    const result = await manager.results.submit({ kind: 'agent', sessionId: dev }, task.id, {
      summary: 'CSV export', commit: 'abc123', tests: [{ description: 'bun run test', outcome: 'pass' }],
    })
    expect(result).toMatchObject({ worktree, taskRevision: 1 })

    // Request review: it queues behind the developer, who occupies the worktree.
    const review = await manager.results.handoff(human, task.id, {
      kind: 'review', resultId: result.id, target: { kind: 'group', id: 'reviewers' }, instructions: 'Review the export', requestKey: 'e07-review',
    })
    const reviewMail = review.assignment.messageId!
    await waitFor(() => manager.waitingFor(team.teamId)[reviewMail] !== undefined, 'waiting reason')
    const reason = manager.waitingFor(team.teamId)[reviewMail]!
    expect([reason.blocker, ...reason.others].some(constraint => constraint.kind === 'worktree-occupied' && constraint.sessionIds?.includes(dev))).toBe(true)
    expect(mail.get(reviewMail)?.state).toBe('queued')

    // Release and hand off: the developer is archived, the queued review proceeds — one reviewer.
    const released = await manager.results.release!.release(human, task.id, {
      target: 'reviewers', instructions: 'Review the export', requestKey: 'e07-release',
    })
    expect(released).toMatchObject({ released: [dev], handoff: { duplicate: true, assignment: { id: review.assignment.id } } })
    expect(manager.isArchived(dev)).toBe(true)
    await waitFor(() => mail.get(reviewMail)?.state === 'delivered', 'review delivered')
    const reviewer = mail.get(reviewMail)!.claimedBy!
    expect(reviewer).not.toBe(dev)
    expect(mail.forTask(task.id).filter(message => message.toId === 'reviewers')).toHaveLength(1)
    const reviewerPeers = (events.get(reviewer) ?? []).filter(event => event.type === 'peer_message')
    expect(JSON.stringify(reviewerPeers)).toContain(`Review of result ${result.id} (commit abc123)`)
    // The developer's result and transcript stay.
    expect(manager.tasks.store.results.get(result.id)?.submittedBy).toEqual({ kind: 'agent', sessionId: dev })
    expect((events.get(dev) ?? []).some(event => event.type === 'peer_message')).toBe(true)

    // Findings bind to the examined result; a newer result inherits none.
    await waitFor(() => manager.getSnapshot(reviewer)?.status === 'waiting', 'reviewer idle')
    const findings = await manager.results.submitFindings({ kind: 'agent', sessionId: reviewer }, task.id, {
      resultId: result.id, kind: 'review', verdict: 'pass', findings: 'Looks right',
    })
    expect(findings).toMatchObject({ resultId: result.id, handoffId: review.assignment.id })
    const newer = await manager.results.submit({ kind: 'agent', sessionId: reviewer }, task.id, { summary: 'CSV export, polished', commit: 'def456' })
    expect(manager.tasks.store.results.get(newer.id)!.findings).toEqual([])
    expect(manager.tasks.store.results.get(result.id)!.findings).toHaveLength(1)
  } finally {
    manager.shutdown()
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
