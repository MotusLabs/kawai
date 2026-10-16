// The classify tests' shared harness (execution-safety-recovery D4): the
// destination classes, repository facts, and the judged/verdictOf readers
// over them. Split out when the suite outgrew one file, so every
// `outboundClassify*.test.ts` judges against the same world. Reserved
// example names throughout.
import { judge, strongest, type JudgedCandidate } from '../outbound/classify'
import { parseSends } from '../outbound/rules'

const INTERNAL = new Set([
  'example.internal', 'npm.example.internal', 'registry.example.internal', 'build.example.internal',
  'git.example.internal', 'pypi.example.internal', 'charts.example.internal', 'host.example.internal',
  'hook.example.internal',
])
const MODEL_PROVIDER = new Set(['llm.example.com', 'api.anthropic.com'])
const MCP_ALLOWED = new Set(['docs-search'])

export const facts = {
  destinations: {
    isInternal: (host: string) => INTERNAL.has(host),
    isModelProvider: (host: string) => MODEL_PROVIDER.has(host),
    isAllowedMcpServer: (server: string) => MCP_ALLOWED.has(server),
  },
  repos: new Map([
    ['/repo', {
      root: '/repo',
      originUrl: 'https://github.com/acme/kawai.git',
      remotes: new Map([
        ['origin', 'https://github.com/acme/kawai.git'],
        ['fork', 'https://github.com/other/fork.git'],
        ['mirror', 'https://git.example.internal/kawai.git'],
      ]),
      pushRemote: null,
    }],
  ]),
}

/** The judged candidates of a command, newest rule first as parsed. */
export function judged(command: string, cwd = '/repo'): JudgedCandidate[] {
  return parseSends(command, cwd).map(candidate => judge(candidate, facts))
}

/** The single strongest judgement of a command, with its rule and destination. */
export function verdictOf(command: string, cwd = '/repo') {
  const best = strongest(judged(command, cwd))
  return best === null ? null : { rule: best.rule, verdict: best.verdict, destination: best.destination }
}
