// Detailed window↔log association verification with a tri-state result,
// used to validate stored associations before trusting them.
import { logger } from '../logger'
import { DEFAULT_SCROLLBACK_LINES } from './common'
import {
  tryExactMatchWindowToLogAsync,
  type ExactMatchContext,
  type ExactMatchResult,
} from './exactMatch'

interface VerifyWindowLogOptions {
  context?: ExactMatchContext
  scrollbackLines?: number
  /** Log paths to exclude from consideration (e.g., logs belonging to other active windows) */
  excludeLogPaths?: string[]
}

// Tri-state verification types for hybrid session matching
type WindowLogVerificationStatus = 'verified' | 'mismatch' | 'inconclusive'

export interface WindowLogVerificationResult {
  status: WindowLogVerificationStatus
  /** The best match found, if any */
  bestMatch: ExactMatchResult | null
  /** Why inconclusive (for debugging) */
  reason?: 'no_match' | 'error'
}

export async function verifyWindowLogAssociationDetailedAsync(
  tmuxWindow: string,
  logPath: string,
  logDirs: string[],
  options: VerifyWindowLogOptions = {}
): Promise<WindowLogVerificationResult> {
  const {
    context = {},
    scrollbackLines = DEFAULT_SCROLLBACK_LINES,
    excludeLogPaths = [],
  } = options

  const excludeSet = new Set(excludeLogPaths)
  excludeSet.delete(logPath)

  try {
    const bestMatch = await tryExactMatchWindowToLogAsync(
      tmuxWindow,
      logDirs,
      scrollbackLines,
      context,
      { excludeLogPaths: excludeSet.size > 0 ? [...excludeSet] : undefined }
    )

    if (bestMatch === null) {
      return { status: 'inconclusive', bestMatch: null, reason: 'no_match' }
    }

    if (bestMatch.logPath === logPath) {
      return { status: 'verified', bestMatch }
    }

    return { status: 'mismatch', bestMatch }
  } catch (error) {
    logger.warn('verify_window_log_error', {
      tmuxWindow,
      logPath,
      error: String(error),
    })
    return { status: 'inconclusive', bestMatch: null, reason: 'error' }
  }
}
