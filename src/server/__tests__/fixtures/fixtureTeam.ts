// A fixture team for headless walkthroughs (task-results-handoffs 8.1–8.3):
// an isolated repository with a linked worktree and group files, and a
// ChatSessionManager whose SDK-free fixture agents write every pushed prompt
// to their transcript — the receipt that confirms delivery — so mail flows
// through the real dispatcher, staffing, and spawning. Git runs with
// cleanGitEnv so a pre-commit hook's environment can never leak in.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { initDatabase } from '../../db'
import { SessionRegistry } from '../../SessionRegistry'
import { ChatSessionManager } from '../../chat/ChatSessionManager'
import { fixtureQueryFactory } from '../../chat/developmentFixture'
import { cleanGitEnv } from '../../git/gitCommand'
import type { ChatEvent } from '../../../shared/chat'

export const waitFor = async (check: () => boolean, label: string, timeoutMs = 15_000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** A throwaway repository with one linked worktree and the given group files (`id` → frontmatter). */
export function fixtureRepo(prefix: string, groups: Record<string, string>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const repo = path.join(root, 'repo')
  const worktree = path.join(root, 'feat')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat', worktree], repo)
  fs.mkdirSync(path.join(repo, '.kawai/groups'), { recursive: true })
  for (const [id, frontmatter] of Object.entries(groups)) {
    fs.writeFileSync(path.join(repo, '.kawai/groups', `${id}.md`), `---\n${frontmatter}\n---\n${id}`)
  }
  return { root, repo, worktree }
}

/** A manager over `root/sessions.db` whose fixture agents confirm receipts; `events` collects each session's events. */
export function fixtureManager(root: string, events: Map<string, ChatEvent[]>) {
  const transcriptDir = path.join(root, 'claude', 'projects', 'fixture')
  fs.mkdirSync(transcriptDir, { recursive: true })
  return new ChatSessionManager({
    db: initDatabase({ path: path.join(root, 'sessions.db') }), registry: new SessionRegistry(), authCheck: () => true, profileCatalogHome: root,
    onEvent: (id, event) => events.set(id, [...(events.get(id) ?? []), event]),
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
}

/** Point CLAUDE_CONFIG_DIR at the root and shorten fixture holds; returns the restore. */
export function fixtureEnv(root: string, holdMs = '600') {
  const prior = { config: process.env.CLAUDE_CONFIG_DIR, hold: process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS }
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = holdMs
  return () => {
    if (prior.config === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prior.config
    if (prior.hold === undefined) delete process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
    else process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = prior.hold
  }
}
