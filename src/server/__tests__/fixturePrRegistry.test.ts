// The fixture pull-request registry is repo-scoped (CI runs the walkthrough
// specs in one server, and two of them drive executions for a branch of the
// same name): one team's pull request must never answer another team's
// lookups, and GitHub's duplicate rule fires only for an OPEN pull request —
// a merged or closed one frees the branch for a new pull request.
import { describe, expect, test } from 'bun:test'
import { fixturePrClose, fixturePullRequest, fixtureRoundAdapters } from '../plans/execution/fixtureAdapters'

const adapters = fixtureRoundAdapters()
const repoA = '/tmp/kawai-fixture-pr-registry-a-origin.git'
const repoB = '/tmp/kawai-fixture-pr-registry-b-origin.git'

describe('fixture PR registry', () => {
  test('two repos each create a pull request for the same head branch', async () => {
    const first = await adapters.prCreate(repoA, { head: 'registry/walk-api', base: 'master', title: 'a', body: '' })
    expect(first.ok).toBe(true)
    const second = await adapters.prCreate(repoB, { head: 'registry/walk-api', base: 'master', title: 'b', body: '' })
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) expect(second.data.number).not.toBe(first.data.number)
  })

  test('a merged pull request does not block a new one for the same head', async () => {
    const created = await adapters.prCreate(repoA, { head: 'registry/merged-api', base: 'master', title: 'a', body: '' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // The promotion merge records the merge commit on the registry row this way.
    const row = fixturePullRequest(created.data.number)
    expect(row).not.toBeNull()
    if (row) row.mergeCommit = 'merged'
    const again = await adapters.prCreate(repoA, { head: 'registry/merged-api', base: 'master', title: 'a2', body: '' })
    expect(again.ok).toBe(true)
  })

  test('an open pull request still refuses a second one for the same head', async () => {
    const created = await adapters.prCreate(repoB, { head: 'registry/open-api', base: 'master', title: 'b', body: '' })
    expect(created.ok).toBe(true)
    const refused = await adapters.prCreate(repoB, { head: 'registry/open-api', base: 'master', title: 'b2', body: '' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.message).toContain('already exists as #')
  })

  test('listing and closing are repo-scoped', async () => {
    const created = await adapters.prCreate(repoA, { head: 'registry/scope-api', base: 'master', title: 'a', body: '' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const elsewhere = await adapters.prList(repoB, { head: 'registry/scope-api', base: 'master' })
    expect(elsewhere.ok && elsewhere.data).toEqual([])
    const own = await adapters.prList(repoA, { head: 'registry/scope-api', base: 'master' })
    expect(own.ok && own.data.map(row => row.number)).toEqual([created.data.number])
    const closedElsewhere = await fixturePrClose(repoB, created.data.number)
    expect(closedElsewhere.ok).toBe(false)
    const closed = await fixturePrClose(repoA, created.data.number)
    expect(closed.ok).toBe(true)
  })
})
