// Barrel for the logmatch modules. Re-exports exactly the surface consumed
// by index.ts, logPoller.ts, logMatchWorker.ts, logMatchWorkerTypes.ts,
// sessionRefreshWorker.ts, and logPollData.ts — nothing more.
export {
  createExactMatchProfiler,
  DEFAULT_SCROLLBACK_LINES,
  type ExactMatchProfiler,
} from './common'
export {
  extractLastEntryTimestamp,
  extractLastUserMessageFromLog,
} from './logText'
export { readLogTokenEvidence } from './tokenReader'
export { extractRecentUserMessagesFromTmux } from './promptExtract'
export { isToolNotificationText, stripPastePlaceholders } from './promptExtract'
export { isSameOrChildPath, matchWindowsToLogsByExactRgAsync } from './exactMatch'
export {
  verifyWindowLogAssociationDetailedAsync,
  type WindowLogVerificationResult,
} from './verify'
