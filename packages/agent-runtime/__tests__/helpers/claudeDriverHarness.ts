// The production Claude session on a controlled query (task 4.1 tests): the
// driver, the queries it created, and everything its callbacks reported.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeSession } from '../../src/claude/session.js'
import type { DriverState, ProcessEndReport, TurnHandle, TurnResult } from '../../src/contract.js'
import type { AgentEvent } from '../../src/events.js'
import { controlledQueries, type ControlledQuery } from './controlledQuery.js'
import { fakeClaudeHome } from './fakeClaudeHome.js'

export interface Driver {
  d: ClaudeSession
  queries: ControlledQuery[]
  q(): ControlledQuery
  events: AgentEvent[]
  results: TurnResult[]
  ends: ProcessEndReport[]
  states: DriverState[]
  types(): string[]
  starting: Promise<void> | null
  handle: TurnHandle | null
  stop: Promise<unknown> | null
  warnings: [string, unknown][]
}

export interface DriverHooks {
  onTurnResult?(result: TurnResult): void
  onState?(state: DriverState): void
  sdkOptions?: Partial<Options>
}

export function driver(hooks: DriverHooks = {}): Driver {
  const { factory, queries, latest } = controlledQueries()
  const events: AgentEvent[] = []
  const results: TurnResult[] = []
  const ends: ProcessEndReport[] = []
  const states: DriverState[] = []
  const warnings: [string, unknown][] = []
  const d = new ClaudeSession({
    launch: fakeClaudeHome().launch(),
    callbacks: {
      onEvent: (e) => events.push(e),
      onTurnResult: (r) => {
        hooks.onTurnResult?.(r)
        results.push(r)
      },
      onProcessEnd: (r) => ends.push(r),
      onState: (s) => {
        states.push(s)
        hooks.onState?.(s)
      },
    },
    logger: { warn: (fields: unknown, message: string) => warnings.push([message, fields]), info: () => {}, error: () => {}, debug: () => {} } as never,
    ...(hooks.sdkOptions ? { sdkOptions: hooks.sdkOptions } : {}),
    resume: { runtime: 'claude', runtimeSessionId: 'sess-saved' },
    queryFactory: factory,
  })
  return { d, queries, q: latest, events, results, ends, states, types: () => events.map((e) => e.type), starting: null, handle: null, stop: null, warnings }
}

