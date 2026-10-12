// Window→log exact matching: capture a pane, extract its messages, search
// candidates, and resolve the best log with tie-breaking. Serves the match
// worker and the startup verifier.
import { performance } from 'node:perf_hooks'
import type { AgentType, TerminalSession } from '../../shared/types'
import { agentFamily } from '../agentDetection'
import {
  extractProjectPath,
  inferAgentTypeFromPath,
  isCodexSubagent,
  normalizeProjectPath,
} from '../logDiscovery'
import {
  DEFAULT_SCROLLBACK_LINES,
  MIN_EXACT_MATCH_LENGTH,
  type ExactMatchSearchOptions,
} from './common'
import {
  compareOrderedScores,
  findLogsWithExactMessageAsync,
  scoreOrderedMessageMatchesAsync,
  scoreOrderedMessageMatchesWithRgAsync,
  type OrderedMatchScore,
} from './candidateSearch'
import {
  extractPiUserMessagesFromAnsi,
  extractRecentTraceLinesFromTmux,
  extractRecentUserMessagesFromTmux,
} from './promptExtract'
import {
  captureTerminalScrollbackAsync,
  getTerminalScrollbackWithAnsiAsync,
} from './scrollback'

/** Default injectable wait for paced async matching. */
const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function normalizePath(value: string): string {
  if (!value) return ''
  return normalizeProjectPath(value)
}

export function isSameOrChildPath(left: string, right: string): boolean {
  if (!left || !right) return false
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function intersectCandidates(base: string[], next: string[]): string[] {
  if (base.length === 0) return next
  const nextSet = new Set(next)
  return base.filter((item) => nextSet.has(item))
}

export interface ExactMatchContext {
  agentType?: AgentType
  projectPath?: string
}

/**
 * Hard agent-type gate. When the window's agent type is known, a log of a
 * different type can never be the right match — even if it is the only log
 * containing the pane's text (e.g. the same prompt pasted into a claude and a
 * codex window seconds apart, where one log flushes first). Returning an empty
 * list defers the match until the right-typed log appears. Fails open when the
 * window type or a log's type is unknown.
 */
function filterCandidatesByAgentType(
  candidates: string[],
  agentType: AgentType | undefined
): string[] {
  const windowFamily = agentFamily(agentType)
  if (!windowFamily) return candidates
  return candidates.filter((candidate) => {
    const logType = inferAgentTypeFromPath(candidate)
    return logType === null || logType === windowFamily
  })
}

export interface ExactMatchResult {
  logPath: string
  userMessage: string
  matchedCount: number
  matchedLength: number
}

export async function tryExactMatchWindowToLogAsync(
  tmuxWindow: string,
  logDirs: string | string[],
  scrollbackLines = DEFAULT_SCROLLBACK_LINES,
  context: ExactMatchContext = {},
  search: ExactMatchSearchOptions = {},
  noMessageWindows?: Set<string>
): Promise<ExactMatchResult | null> {
  const profile = search.profile
  const tmuxStart = performance.now()
  const captureResult = await captureTerminalScrollbackAsync(tmuxWindow, scrollbackLines)
  const scrollback = captureResult.content
  if (profile) {
    profile.tmuxCaptures += 1
    profile.tmuxCaptureMs += performance.now() - tmuxStart
  }
  const extractStart = performance.now()
  let userMessages = extractRecentUserMessagesFromTmux(scrollback)

  if (userMessages.length === 0) {
    const ansiScrollback = await getTerminalScrollbackWithAnsiAsync(
      tmuxWindow,
      scrollbackLines
    )
    userMessages = extractPiUserMessagesFromAnsi(ansiScrollback)
  }

  if (profile) {
    profile.messageExtractRuns += 1
    profile.messageExtractMs += performance.now() - extractStart
  }

  let messages = userMessages
  let usingTraceFallback = false
  if (messages.length === 0) {
    const traces = extractRecentTraceLinesFromTmux(scrollback)
    if (traces.length === 0) {
      if (captureResult.ok) noMessageWindows?.add(tmuxWindow)
      return null
    }
    messages = traces
    usingTraceFallback = true
  }

  const hasDisambiguators = Boolean(context.agentType || context.projectPath)
  const longMessages = messages.filter(
    (message) => message.length >= MIN_EXACT_MATCH_LENGTH
  )
  const allowShortMessages = hasDisambiguators || usingTraceFallback
  const messagesToSearch =
    longMessages.length > 0 ? longMessages : allowShortMessages ? messages : []
  if (messagesToSearch.length === 0) return null

  const sortedMessages = messagesToSearch.toSorted((a, b) => b.length - a.length)
  let candidates: string[] = []

  for (const message of sortedMessages) {
    const minLength =
      message.length >= MIN_EXACT_MATCH_LENGTH ? MIN_EXACT_MATCH_LENGTH : 1
    const matches = await findLogsWithExactMessageAsync(message, logDirs, {
      minLength,
      logPaths: search.logPaths,
      tailBytes: search.tailBytes,
      rgThreads: search.rgThreads,
      profile: search.profile,
      userOnly: !usingTraceFallback,
    })
    if (matches.length === 0) continue
    candidates = intersectCandidates(candidates, matches)
    if (candidates.length <= 1) break
  }

  if (candidates.length === 0) {
    return null
  }

  if (usingTraceFallback) {
    const filtered = candidates.filter((candidate) => !isCodexSubagent(candidate))
    if (filtered.length === 0) {
      return null
    }
    candidates = filtered
  }

  candidates = filterCandidatesByAgentType(candidates, context.agentType)
  if (candidates.length === 0) {
    return null
  }

  if (context.projectPath) {
    const target = normalizePath(context.projectPath)
    const filtered = candidates.filter((candidate) => {
      const projectPath = extractProjectPath(candidate)
      if (!projectPath) return false
      const normalized = normalizePath(projectPath)
      return isSameOrChildPath(normalized, target)
    })
    if (filtered.length > 0) {
      candidates = filtered
    }
  }

  // Filter out explicitly excluded log paths (e.g., logs belonging to other active windows)
  if (search.excludeLogPaths && search.excludeLogPaths.length > 0) {
    const excludeSet = new Set(search.excludeLogPaths)
    const filtered = candidates.filter((candidate) => !excludeSet.has(candidate))
    if (filtered.length > 0) {
      candidates = filtered
    }
  }

  const orderedMessages = messages
    .filter((message: string) => message.length >= MIN_EXACT_MATCH_LENGTH)
    .toReversed()

  if (orderedMessages.length === 0) {
    return null
  }

  if (candidates.length === 1) {
    const score = await scoreOrderedMessageMatchesAsync(
      candidates[0],
      orderedMessages,
      search
    )
    if (score.matchedCount === 0) {
      return null
    }
    return {
      logPath: candidates[0],
      userMessage: messages[0] ?? '',
      matchedCount: score.matchedCount,
      matchedLength: score.matchedLength,
    }
  }

  let scored = await Promise.all(
    candidates.map(async (logPath) => ({
      logPath,
      score: await scoreOrderedMessageMatchesAsync(logPath, orderedMessages, search),
    }))
  )

  scored.sort((left, right) => compareOrderedScores(left.score, right.score))
  let best = scored[0]
  let second = scored[1]

  if (!best || best.score.matchedCount === 0) {
    return null
  }

  if (second) {
    const isTied =
      best.score.matchedCount === second.score.matchedCount &&
      best.score.matchedLength === second.score.matchedLength
    if (isTied) {
      const tied = scored.filter(
        (entry) => compareOrderedScores(entry.score, best.score) === 0
      )
      const needsFull = tied.some((entry) => entry.score.source === 'tail')
      if (needsFull) {
        const tieStart = performance.now()
        const updatedScores = new Map<string, OrderedMatchScore>(
          await Promise.all(
            tied.map(async (entry): Promise<[string, OrderedMatchScore]> => {
              const rgScore = await scoreOrderedMessageMatchesWithRgAsync(
                entry.logPath,
                orderedMessages,
                search
              )
              return [
                entry.logPath,
                {
                  ...rgScore,
                  source: 'rg' as const,
                },
              ]
            })
          )
        )
        if (profile) {
          profile.tieBreakRgRuns += tied.length
          profile.tieBreakRgMs += performance.now() - tieStart
        }
        scored = scored.map((entry) => {
          const updated = updatedScores.get(entry.logPath)
          if (!updated) return entry
          return { ...entry, score: updated }
        })
        scored.sort((left, right) => compareOrderedScores(left.score, right.score))
        best = scored[0]
        second = scored[1]
      }
    }
  }

  if (
    second &&
    best.score.matchedCount === second.score.matchedCount &&
    best.score.matchedLength === second.score.matchedLength
  ) {
    return null
  }

  return {
    logPath: best.logPath,
    userMessage: messages[0] ?? '',
    matchedCount: best.score.matchedCount,
    matchedLength: best.score.matchedLength,
  }
}

interface ExactMatchRgResult {
  matches: Map<string, TerminalSession>
  /** Windows where tryExactMatchWindowToLogAsync returned null due to no extractable messages */
  noMessageWindows: Set<string>
}

export async function matchWindowsToLogsByExactRgAsync(
  windows: TerminalSession[],
  logDirs: string | string[],
  scrollbackLines = DEFAULT_SCROLLBACK_LINES,
  search: ExactMatchSearchOptions = {}
): Promise<ExactMatchRgResult> {
  const matches = new Map<string, { window: TerminalSession; score: OrderedMatchScore }>()
  const blocked = new Set<string>()
  const noMessageWindows = new Set<string>()
  const profile = search.profile

  // Sequential captures with a paced yield between windows (design D4): the
  // previous Promise.all fan-out issued every scrollback capture at once,
  // monopolizing the single-threaded tmux server for the whole burst.
  // Aggregation below iterates in window order, so results are
  // order-equivalent with the sync variant.
  const wait = search.wait ?? sleepMs
  const yieldMs = search.interWindowYieldMs ?? 0

  for (let index = 0; index < windows.length; index += 1) {
    if (index > 0 && yieldMs > 0) {
      await wait(yieldMs)
    }
    const window = windows[index]
    const start = performance.now()
    const result = await tryExactMatchWindowToLogAsync(
      window.tmuxWindow,
      logDirs,
      scrollbackLines,
      { agentType: window.agentType, projectPath: window.projectPath },
      search,
      noMessageWindows
    )
    if (profile) {
      profile.windowMatchRuns += 1
      profile.windowMatchMs += performance.now() - start
    }
    if (!result) continue

    const score = {
      matchedCount: result.matchedCount,
      matchedLength: result.matchedLength,
    }
    const existing = matches.get(result.logPath)

    if (blocked.has(result.logPath)) {
      continue
    }
    if (!existing) {
      matches.set(result.logPath, { window, score })
      continue
    }

    const comparison = compareOrderedScores(score, existing.score)
    if (comparison === 0) {
      matches.delete(result.logPath)
      blocked.add(result.logPath)
      continue
    }
    if (comparison < 0) {
      matches.set(result.logPath, { window, score })
    }
  }

  const resolved = new Map<string, TerminalSession>()
  for (const [logPath, entry] of matches) {
    resolved.set(logPath, entry.window)
  }

  return { matches: resolved, noMessageWindows }
}
