// Product strategy end to end with the fixture manager in one temporary
// repository (product-strategy 6.1): a human captures the product, an
// agent reads the empty strategy, saves a material draft with Unknown
// measures and an impact proposal, submits it for review, and the human
// approves the exact revision — asserting the approved revision and hash,
// the single impact-review item, superseded revisions staying unchanged
// and readable, and that the agent surface still has no approve tool.
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../db'
import { SessionRegistry } from '../SessionRegistry'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { resolveTeam } from '../team/teamIdentity'
import { cleanGitEnv } from '../git/gitCommand'
import { strategyHandlers, STRATEGY_FORBIDDEN_TOOL_NAMES, STRATEGY_TOOL_NAMES } from '../strategy/strategyTools'
import { UNKNOWN } from '../../shared/productStrategy'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

test('an agent proposes and the human approves: exact revision, one impact item, no agent approve tool', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-strategy-integration-')))
  const repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai/groups/devs.md'), '---\ncanCreateTasks: true\n---\nBuild features')
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  const configDir = path.join(root, 'claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const transcriptDir = path.join(configDir, 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  const dbPath = path.join(root, 'sessions.db')
  const manager = new ChatSessionManager({
    db: initDatabase({ path: dbPath }), registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
    onEvent: () => {},
    queryFactory: params => {
      const sdkId = params.options.resume ?? crypto.randomUUID()
      const file = path.join(transcriptDir, `${sdkId}.jsonl`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      const prompt = (async function* () {
        for await (const message of params.prompt) {
          fs.appendFileSync(file, JSON.stringify({ ...message, uuid: crypto.randomUUID() }) + '\n')
          yield message
        }
      })()
      const fixture = fixtureQueryFactory({ ...params, prompt })
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: sdkId } as SDKMessage
        yield* fixture
      })()
      return Object.assign(stream, { interrupt: () => fixture.interrupt(), close: () => fixture.close() }) as Query
    },
  })
  try {
    const team = await resolveTeam(repo)
    const human = { kind: 'human' as const, team }

    // Work proceeds without a strategy (S11): a task exists normally and
    // creates no strategy record or binding.
    const task = await manager.tasks.create(human, { title: 'Unrelated work', direction: 'Proceeds standalone' })
    expect(manager.strategies.store.forTeam(team.teamId)).toBeNull()

    // The human captures the product through the first save (the UI path).
    const capture = await manager.strategies.saveDraft(human, {
      product_id: 'kawai', title: 'Kawai',
      content: { purpose: 'Supervised autonomous software development', primaryUsers: 'Small platform teams' },
      expected_draft_hash: null,
    })
    expect(capture.ok).toBe(true)

    // One agent, bound to its session through the tool handlers.
    const dev = await manager.createAvailableSession({ projectPath: repo, groupId: 'devs' })
    if (!dev.ok) throw new Error(dev.error)
    const tools = strategyHandlers(manager.strategies, dev.session.id)

    // The agent reads the strategy: a record, no approved revision.
    const before = await tools.strategy_get({})
    expect(before).toMatchObject({ strategy: { productId: 'kawai', currentApprovedRevision: null } })
    expect(before!.revisions).toEqual([])
    expect(before!.decisions).toEqual([])
    // A forged human actor in the arguments is stripped: saving works as the
    // agent, and there is still no approve tool to call.
    expect(Object.keys(tools).sort()).toEqual([...STRATEGY_TOOL_NAMES].sort())
    for (const forbidden of STRATEGY_FORBIDDEN_TOOL_NAMES) expect(tools).not.toHaveProperty(forbidden)

    // The agent saves a material draft with Unknown measures and an impact
    // proposal, then submits it for review.
    const saved = await tools.strategy_save_draft({
      actor: { kind: 'human' },
      content: {
        purpose: 'Supervised autonomous software development',
        primaryUsers: 'Small platform teams',
        successMeasures: [{ outcome: 'Direction stability', measure: 'strategy revisions per month' }],
        claims: [{ text: 'Leads want explicit approval gates', kind: 'owner_preference' }],
      },
      impact_proposal: 'First approved direction; sets purpose and approval model',
      expected_draft_hash: null,
    })
    expect(saved.ok).toBe(true)
    if (saved.ok) {
      expect(saved.draft.content.successMeasures[0]).toMatchObject({ baseline: UNKNOWN, target: UNKNOWN })
      expect(saved.draft.impactProposal).toBe('First approved direction; sets purpose and approval model')
    }
    const submitted = await tools.strategy_submit_for_review({})
    expect(submitted.ok).toBe(true)

    // The human approves the exact revision and hash.
    const revision = submitted.ok ? submitted.revision : null
    const approved = await manager.strategies.approve(human, {
      revision: revision!.revision, content_hash: revision!.contentHash, command_id: 'approve-first',
      expected_current_revision: null, approval_scope: 'Direction only', open_questions: 'Baselines unmeasured',
    })
    expect(approved.ok).toBe(true)

    // A second, material proposal supersedes the first; the earlier revision
    // stays unchanged and readable. The agent re-reads its draft first (the
    // CAS expectation), as the real tool flow does.
    const mid = await tools.strategy_get({})
    const ownDraft = mid!.drafts.find(draft => draft.draftId === dev.session.id)!
    const second = await tools.strategy_save_draft({
      content: { purpose: 'A narrower purpose: supervised delivery, not general autonomy', boundaries: ['No autonomous merges to master'] },
      impact_proposal: 'Narrows purpose; adds a hard boundary',
      expected_draft_hash: ownDraft.contentHash,
    })
    expect(second.ok).toBe(true)
    const secondSubmitted = await tools.strategy_submit_for_review({})
    const secondRevision = secondSubmitted.ok ? secondSubmitted.revision : null
    const superseding = await manager.strategies.approve(human, {
      revision: secondRevision!.revision, content_hash: secondRevision!.contentHash, command_id: 'approve-second',
      expected_current_revision: 1,
    })
    expect(superseding.ok).toBe(true)

    const detail = (await manager.strategies.get(human))!
    expect(detail.strategy.currentApprovedRevision).toBe(2)
    expect(detail.revisions[0]).toMatchObject({ revision: 1, status: 'superseded' })
    expect(detail.revisions[0]!.content.purpose).toBe('Supervised autonomous software development')
    expect(detail.revisions[0]!.contentHash).toBe(revision!.contentHash)
    expect(detail.revisions[1]).toMatchObject({ revision: 2, status: 'approved' })
    expect(detail.decisions.map(decision => decision.decision)).toEqual(['approve', 'approve'])
    // Exactly one impact-review item per approval — publication created no
    // other work (only the pre-existing task, no mail, no spawned sessions).
    expect(detail.impactReviews).toHaveLength(2)
    expect(manager.tasks.store.list(team.teamId).map(row => row.id)).toEqual([task.id])
    expect(manager.mailbox.store.listForTeam(team.teamId)).toEqual([])
    // Evidence rows landed for the claims the submitted revisions carried
    // (revision 1's owner-preference claim; revision 2 carried none).
    expect(detail.evidence.map(row => [row.revision, row.kind])).toEqual([[1, 'owner_preference']])
    // The strategy and its history survive a restart.
    manager.shutdown()
    const reopened = new ChatSessionManager({
      db: initDatabase({ path: dbPath }), registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
      onEvent: () => {},
      queryFactory: () => { throw new Error('not started') },
    })
    const after = (await reopened.strategies.get(human))!
    expect(after.strategy.currentApprovedRevision).toBe(2)
    expect(after.revisions.map(row => row.status)).toEqual(['superseded', 'approved'])
    expect(after.impactReviews).toHaveLength(2)
    reopened.shutdown()
  } finally {
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
    fs.rmSync(root, { recursive: true, force: true })
  }
})
