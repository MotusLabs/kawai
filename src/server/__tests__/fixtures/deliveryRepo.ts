// Owned deterministic Git fixture for delivery oracles. This adapter prepares
// pure inputs only; production filesystem/reader composition is a later task.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../../git/gitCommand'
import { commitTimeMs } from '../../metrics/delivery/landing'
import type { CommitGraph, HistoryCommit } from '../../metrics/delivery/types'

export const FIXTURE_EPOCH = Date.parse('2026-10-01T00:00:00Z')

export class DeliveryRepo {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-git-'))
  readonly repo = path.join(this.root, 'repo')
  private readonly env: Record<string, string>

  constructor() {
    const home = path.join(this.root, 'home')
    const tmp = path.join(this.root, 'tmp')
    for (const directory of [this.repo, home, tmp]) fs.mkdirSync(directory, { mode: 0o700 })
    this.env = {
      HOME: home, TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Delivery Fixture', GIT_AUTHOR_EMAIL: 'delivery-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Delivery Fixture', GIT_COMMITTER_EMAIL: 'delivery-fixture@example.invalid',
      TZ: 'UTC',
    }
    this.git('init', '-q', '--object-format=sha1', '-b', 'main')
    this.git('config', 'commit.gpgsign', 'false')
  }

  git(...args: string[]): string {
    // runGit applies cleanGitEnv before these explicit fixture overrides.
    const result = runGit(args, { cwd: this.repo, env: this.env })
    if (!result.ok) throw new Error(`fixture git ${args[0]}: ${result.exitCode}: ${result.stderr}`)
    return result.stdout
  }

  write(relative: string, contents = 'Synthetic delivery fixture\n'): void {
    const file = path.join(this.repo, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents)
  }

  commit(title: string, seconds: number): string {
    const date = new Date(FIXTURE_EPOCH + seconds * 1000).toISOString()
    this.env.GIT_AUTHOR_DATE = date
    this.env.GIT_COMMITTER_DATE = date
    this.git('add', '--all')
    this.git('commit', '-q', '--allow-empty', '-m', title)
    return this.git('rev-parse', 'HEAD').trim()
  }

  merge(branch: string, seconds: number): string {
    const date = new Date(FIXTURE_EPOCH + seconds * 1000).toISOString()
    this.env.GIT_AUTHOR_DATE = date
    this.env.GIT_COMMITTER_DATE = date
    this.git('merge', '-q', '--no-ff', branch, '-m', `Fixture merge ${branch}`)
    return this.git('rev-parse', 'HEAD').trim()
  }

  snapshot(head: string): { graph: CommitGraph; archives: string } {
    const prefix = ['--no-replace-objects', '-c', 'log.showSignature=false']
    const graph = new Map<string, HistoryCommit>()
    // Fixture-only decoding: completeness and runner validation belong to1.2.
    for (const line of this.git(...prefix, 'log', '--format=%H %ct %P', head).trim().split('\n')) {
      const [sha, seconds, ...parents] = line.trimEnd().split(' ')
      graph.set(sha!, { committedAt: commitTimeMs(Number(seconds)), parents })
    }
    const archives = this.git(...prefix, 'log', '--first-parent', '--no-renames', '--diff-filter=A',
      '--name-only', '--format=@%H', head, '--', 'openspec/changes/archive/*/proposal.md')
    return { graph, archives }
  }

  dispose(): void {
    fs.rmSync(this.root, { recursive: true, force: true })
  }
}

export function mergeArchiveFixture(): {
  repo: DeliveryRepo; root: string; feature: string; offgraph: string; merge: string; head: string
} {
  const repo = new DeliveryRepo()
  const root = repo.commit('Fixture root', 100)
  repo.git('switch', '-q', '-c', 'feature')
  repo.write('openspec/changes/archive/2026-10-02-example/proposal.md')
  const feature = repo.commit('Fixture feature archive', 70)
  repo.git('switch', '-q', '-c', 'unmerged', root)
  const offgraph = repo.commit('Fixture unmerged result', 125)
  repo.git('switch', '-q', 'main')
  const merge = repo.merge('feature', 50)
  const head = repo.commit('Fixture tip', 200)
  return { repo, root, feature, offgraph, merge, head }
}
