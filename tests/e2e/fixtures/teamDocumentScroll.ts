// Isolated production-app fixture for document overflow and Team reveals.
// Durable plan/task facts live only in this fixture's DB; navigator/history
// projections use the same wire interception as chat-typing-performance.
import { expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMessage } from '../../../src/shared/types'
import type { ChatEvent } from '../../../src/shared/chat'
import { ServerProcess } from './serverProcess'

export function documentScrollFixture() {
  const home = mkdtempSync(join(tmpdir(), 'kawai-scroll-'))
  const root = join(home, 'repo')
  mkdirSync(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
  git('init', '-q')
  writeFileSync(join(root, 'README.md'), 'Scroll fixture\n')
  git('add', 'README.md')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture')
  const dbPath = join(home, 'fixture.db')
  const env = {
    ...process.env, HOME: home, NODE_ENV: 'development', AGENTBOARD_CHAT_FIXTURE: '1',
    AGENTBOARD_DB_PATH: dbPath, LOG_FILE: join(home, 'server.log'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), PI_HOME: join(home, 'pi'),
    TMUX_TMPDIR: home, TMUX: '', TMUX_SESSION: 'scroll-fixture',
    AGENTBOARD_TMUX_PID_FILE: join(home, 'tmux.pid'), AGENTBOARD_REMOTE_HOSTS: '',
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '',
  }
  const seed = execFileSync('bun', ['-e', `
    import { initDatabase } from './src/server/db';
    import { PlanStore } from './src/server/plans/planStore';
    import { DecisionStore } from './src/server/plans/decisions/decisionStore';
    import { ExecutionStore } from './src/server/plans/execution/executionStore';
    import { TaskStore } from './src/server/team/taskStore';
    import { normalizePlanContent } from './src/shared/plans';
    import { resolveTeam } from './src/server/team/teamIdentity';
    const [root, file] = JSON.parse(await Bun.stdin.text());
    if (!file.startsWith(process.env.HOME + '/')) throw new Error('Not isolated');
    const sessions = initDatabase({ path: file });
    const db = sessions.db;
    const teamId = (await resolveTeam(root)).teamId;
    const plans = new PlanStore(db);
    const human = { kind: 'human', sessionId: null };
    const planId = plans.insertPlan({ teamId, title: 'Scroll regression plan', creator: human });
    const content = normalizePlanContent({ goal: 'Plan context. '.repeat(1500),
      changes: [{ change: 'scroll-change', group: 'devs' }], roles: [{ group: 'devs', profiles: [] }] });
    const revision = plans.insertRevision(planId, { content, contentHash: 'fixture-hash', pin: null, author: human });
    plans.setRevisionStatus(planId, revision, 'approved');
    plans.setCurrentApproved(planId, revision);
    const card = new DecisionStore(db).insertCard({ teamId, planId, revision, change: null, taskId: null,
      question: 'Which scroll behavior?', options: ['Keep the viewport'], context: 'Fixture question',
      askedBy: { session: 'fixture-agent', group: null, profile: null },
      addressedTo: 'owner', addressedGroup: null, messageId: null });
    const executions = new ExecutionStore(db);
    const execution = executions.insertExecution({ teamId, planId, revision, contentHash: 'fixture-hash',
      reportId: 'fixture-report', inputHash: 'fixture-input', landingMode: 'direct', baseBranch: 'master',
      baseCommit: 'abc', floor: { version: 1, map: {} }, maxParallel: 1, mergeMethod: 'merge',
      changes: [{ change: 'scroll-change', landed: false }] });
    const row = executions.change(execution.id, 'scroll-change');
    executions.transition(execution.id, 'scroll-change', { state: row.state, generation: row.generation },
      { state: 'stopped', stopReason: 'ci-timeout' });
    const task = new TaskStore(db).create({ teamId, title: 'Scroll regression task',
      direction: 'Task context. '.repeat(1000), creator: human });
    console.log('SEED:' + JSON.stringify({ planId, cardId: card.id, taskId: task.id }));
    sessions.close();
  `], { cwd: process.cwd(), env, input: JSON.stringify([root, dbPath]), encoding: 'utf8' })
  const ids = JSON.parse(seed.split('\n').find(line => line.startsWith('SEED:'))!.slice(5)) as {
    planId: string; cardId: string; taskId: string
  }
  const port = String(Number(process.env.E2E_PORT || 4173) + 150)
  const url = `http://127.0.0.1:${port}`
  const server = new ServerProcess()
  type DetailMessage = Extract<ServerMessage, { type: 'team-plan-detail' }>
  let lastDetail: DetailMessage | undefined
  let push: ((message: ServerMessage) => void) | undefined
  let tall = false
  let missing = false

  const decorateDetail = (message: DetailMessage) => {
    const result = structuredClone(message)
    if (missing) result.detail.decisions = []
    else if (tall && result.detail.decisions?.[0]) result.detail.decisions[0].card.context = 'Tall card\n'.repeat(80)
    return result
  }
  return {
    ...ids, root, url,
    async start(page: Page) {
      execFileSync('tmux', ['new-session', '-d', '-s', 'scroll-fixture'], { env })
      server.spawn('bun', ['src/server/index.ts'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, PORT: port, HOSTNAME: '127.0.0.1', AGENTBOARD_STATIC_DIR: join(process.cwd(), 'dist/client') } })
      await expect.poll(async () => {
        try { return (await page.request.get(url, { timeout: 1000 })).ok() } catch { return false }
      }, { timeout: 30_000, message: 'isolated scroll server starts' }).toBe(true)
    },
    async openChat(page: Page) {
      tall = false; missing = false
      await page.routeWebSocket(/\/ws$/, ws => {
        const remote = ws.connectToServer()
        push = message => ws.send(JSON.stringify(message))
        ws.onMessage(message => remote.send(message))
        remote.onMessage(raw => {
          if (typeof raw !== 'string') return ws.send(raw)
          let message = JSON.parse(raw) as ServerMessage
          if (message.type === 'workspace-snapshot') {
            const repo = message.snapshot.repositories.find(repo => repo.worktrees.some(tree => tree.path === root))
            if (repo) repo.worktrees = [repo.worktrees.find(tree => tree.path === root)!, ...Array.from({ length: 50 }, (_,i) => ({
              id: `${repo.id}::scroll-${i}`, repositoryId: repo.id, path: `${root}/scroll-${i}`,
              branch: `scroll-${i}`, headRevision: 'abcdef012345', detached: i % 3 === 0, isMain: false,
              dirty: true, openspec: { changes: [], stale: false },
            }))]
          }
          if (message.type === 'chat-snapshot') {
            message.events = Array.from({ length: 90 }, (_, i): ChatEvent => ({
              type: 'assistant_text', id: `scroll-message-${i}`, sequence: 0, at: new Date().toISOString(),
              turnId: 'scroll-turn', messageId: `scroll-message-${i}`, text: `Transcript row ${i}.\n\n${'Long content. '.repeat(30)}`,
            }))
          }
          if (message.type === 'team-plan-detail') { lastDetail = message; message = decorateDetail(message) }
          ws.send(JSON.stringify(message))
        })
      })
      await page.goto(url)
      await page.getByRole('button', { name: 'New session', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: 'New Session' })
      await dialog.getByLabel('Session kind').selectOption('chat')
      await dialog.getByLabel('Project Path').fill(root)
      await dialog.getByLabel('Display Name').fill('Scroll fixture chat')
      await dialog.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(page.getByTestId('chat-name')).toHaveText('Scroll fixture chat')
      await expect(page.getByTestId('section-header').filter({ hasText: 'scroll-49' })).toBeAttached({ timeout: 45_000 })
      await expect(page.getByTestId('chat-message-copy')).toHaveCount(90)
    },
    async team(page: Page, tab = 'plans', id = '') {
      await page.evaluate(({ root, tab, id }) => {
        location.hash = `#/team/${encodeURIComponent(root)}/${tab}${id ? `/${id}` : ''}`
      }, { root, tab, id })
      await expect(page.getByTestId('team-workspace')).toBeVisible()
    },
    update(options: { tall?: boolean; missing?: boolean } = {}) {
      tall = options.tall ?? tall; missing = options.missing ?? missing
      if (!lastDetail || !push) throw new Error('Plan detail not loaded')
      push(decorateDetail(lastDetail))
    },
    async stop() {
      await server.stop({ tmuxRoot: home })
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export async function viewportFacts(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector('#root > div')!
    const rect = app.getBoundingClientRect()
    return { mode: document.compatMode, height: innerHeight, extent: document.documentElement.scrollHeight,
      documentScroll: document.scrollingElement!.scrollTop, appScroll: app.scrollTop,
      top: rect.top, bottom: rect.bottom }
  })
}

export async function expectViewport(page: Page, extent = true) {
  await expect.poll(async () => {
    const facts = await viewportFacts(page)
    return facts.mode === 'CSS1Compat' && Math.abs(facts.documentScroll) <= 1 && Math.abs(facts.appScroll) <= 1
      && Math.abs(facts.top) <= 1 && Math.abs(facts.bottom - facts.height) <= 1
      && (!extent || facts.extent <= facts.height + 1)
  }).toBe(true)
}
