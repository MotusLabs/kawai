// The timings record (design D4): per-file durations from a full run,
// published atomically to <git-common-dir>/kawai-checks/timings.json and fed
// back to `bun test --timings` so --parallel starts the slowest files first.
// The record is scheduling input only: a missing, malformed, or lost record
// changes ordering, never which tests run or what they assert. The snapshot
// bun writes lives in the run root; the runner copies it into the shared
// directory through a unique temporary file and renames it into place, so a
// concurrent suite always reads one whole record or finds none.

import fs from 'node:fs'
import path from 'node:path'

export const TIMINGS_FILE_NAME = 'timings.json'

export interface TimingsRecord {
  version: number
  files: Record<string, number>
}

// Bun's format: { "version": 1, "files": { "<path>": <milliseconds> } }
// (probed on 1.4.3; bun itself refuses any other shape). Null for anything
// unreadable, malformed, or wrongly shaped — the caller runs unordered.
export function parseTimingsRecord(text: string): TimingsRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return null
  if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)) {
    return null
  }
  const files: Record<string, number> = {}
  for (const [file, ms] of Object.entries(record.files)) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
    files[file] = ms
  }
  return { version: 1, files }
}

// The previous record's text, or null when there is none usable. A missing
// or malformed record never fails the run (D4).
export function readTimingsSeed(recordsDir: string): string | null {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(recordsDir, TIMINGS_FILE_NAME), 'utf8')
  } catch {
    return null
  }
  return parseTimingsRecord(raw) === null ? null : raw
}

// The per-run snapshot bun reads and, with --update-timings, rewrites at the
// end of the main batch. The seed — when there is one — is copied in, so bun
// never touches the shared record directly and never sees a malformed file.
export function seedTimingsSnapshot(runRoot: string, seedText: string | null): string {
  const snapshot = path.join(runRoot, TIMINGS_FILE_NAME)
  if (seedText !== null) fs.writeFileSync(snapshot, seedText)
  return snapshot
}

// Publish the finished snapshot: parse it, drop keys whose file no longer
// exists (a rename or deletion must not flag its ghost forever), then write
// it to the shared directory through a unique temporary file and rename it
// into place, so a concurrent suite reads one whole record or finds none —
// never a partial one. Throws on a filesystem failure; the runner logs that
// and keeps running (a lost update affects scheduling only). Returns the
// published record, or null when the snapshot is missing or malformed — a
// failed batch leaves no usable snapshot, and the previous record stands.
export function publishTimingsSnapshot(
  recordsDir: string,
  snapshotPath: string,
  fileExists: (file: string) => boolean = (file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  }
): TimingsRecord | null {
  let raw: string
  try {
    raw = fs.readFileSync(snapshotPath, 'utf8')
  } catch {
    return null
  }
  const parsed = parseTimingsRecord(raw)
  if (parsed === null) return null
  const files: Record<string, number> = {}
  for (const [file, ms] of Object.entries(parsed.files)) {
    // The predicate sees the normalized key: bun records paths as they were
    // spelled on the command line, with a leading './'.
    if (fileExists(file.startsWith('./') ? file.slice(2) : file)) files[file] = ms
  }
  fs.mkdirSync(recordsDir, { recursive: true })
  const final = path.join(recordsDir, TIMINGS_FILE_NAME)
  // Same shape checkRecords uses, so a crash between the write and the
  // rename leaves a recognizable temporary behind.
  const temporary = path.join(recordsDir, `.${TIMINGS_FILE_NAME}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, files }))
  fs.renameSync(temporary, final)
  return { version: 1, files }
}

// --- the misplaced-file report (design D7) ---

export const SLOW_TIER_THRESHOLD_MS = 5_000

// Files over the threshold that stay outside the slow tier on purpose. Each
// entry carries its reason; the report matches by basename, so a path's
// spelling never hides an exception.
export const SLOW_TIER_EXCEPTIONS: ReadonlyArray<{ file: string; reason: string }> = [
  // Measured 2026-10-21: the N=1 reference record (logs/ps-window/timings-n1.json)
  // against an exclusive N=4 full run. A file over 5 s at N=1 is durably slow and
  // belongs in the tier (renamed to *.integration.test.ts); the entries here read
  // under 5 s at N=1 and only cross it under N=4 worker contention, or are pinned
  // by work this change must not touch.
  { file: 'src/server/__tests__/chatSessionManager.test.ts', reason: '51.0 s at N=1, durably slow; B1 (chatSessionManager split) owns the file — renamed there, not here' },
  { file: 'src/server/__tests__/promotionSlot.test.ts', reason: '4.8 s at N=1; 17.4 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatNameSourceDb.test.ts', reason: '2.3 s at N=1; 15.8 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/decisionAsk.test.ts', reason: '2.9 s at N=1; 15.8 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/outboundService.test.ts', reason: '3.2 s at N=1; 13.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planValidationService.test.ts', reason: '2.4 s at N=1; 13.5 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planValidationRun.test.ts', reason: '2.4 s at N=1; 12.8 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/ownerDecisions.test.ts', reason: '2.3 s at N=1; 11.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/teamMessageEvents.test.ts', reason: '1.7 s at N=1; 11.6 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/executionLanding.test.ts', reason: '2.4 s at N=1; 11.6 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/taskResults.test.ts', reason: '2.0 s at N=1; 11.1 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/executionComposition.test.ts', reason: '2.8 s at N=1; 10.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/db.test.ts', reason: '1.7 s at N=1; 10.6 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatSessionGroups.test.ts', reason: '2.1 s at N=1; 10.5 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/databaseBackups.test.ts', reason: '2.4 s at N=1; 10.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/teamWorkspaceConnections.test.ts', reason: '2.1 s at N=1; 10.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planService.test.ts', reason: '2.5 s at N=1; 9.9 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatSessionWorkspaceHooks.test.ts', reason: '1.8 s at N=1; 9.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/outboundConnections.test.ts', reason: '1.7 s at N=1; 9.4 s only under N=4 worker contention' },
  { file: 'scripts/__tests__/runnerRoots.test.ts', reason: '3.7 s at N=1; 9.3 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/codexRolloutReplay.test.ts', reason: '9.1 s at N=4, no N=1 entry; touched by open branch feat/codex-chat-sessions-e — never renamed here' },
  { file: 'src/server/__tests__/systemActor.test.ts', reason: '1.6 s at N=1; 9.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planPreconditions.test.ts', reason: '1.5 s at N=1; 8.3 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planLifecycle.test.ts', reason: '2.4 s at N=1; 8.2 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/taskPublication.test.ts', reason: '1.5 s at N=1; 8.1 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planTaskLink.test.ts', reason: '1.4 s at N=1; 8.1 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/codexTeamPath.test.ts', reason: '8.1 s at N=4, no N=1 entry; touched by open branch feat/codex-chat-sessions-e — never renamed here' },
  { file: 'src/server/__tests__/teamTaskMessages.test.ts', reason: '1.4 s at N=1; 8.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planConnections.test.ts', reason: '1.9 s at N=1; 7.9 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/fixCompletion.test.ts', reason: '3.4 s at N=1; 7.9 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/effectRetryInspectionTable.test.ts', reason: '4.5 s at N=1; 7.8 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatSessionTasks.test.ts', reason: '1.4 s at N=1; 7.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/stallAlerts.test.ts', reason: '1.8 s at N=1; 7.6 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/correctionTasks.test.ts', reason: '1.5 s at N=1; 7.5 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/schemaMigrations.test.ts', reason: '1.4 s at N=1; 7.4 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatAsyncRestore.test.ts', reason: '1.3 s at N=1; 7.3 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/limitEvents.test.ts', reason: '2.3 s at N=1; 7.2 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/teamStaffing.test.ts', reason: '4.6 s at N=1; 7.2 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/teamMessageSchema.test.ts', reason: '0.9 s at N=1; 7.1 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planStore.test.ts', reason: '1.6 s at N=1; 7.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/executionOwnership.test.ts', reason: '2.7 s at N=1; 7.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/decisionTools.test.ts', reason: '1.4 s at N=1; 6.8 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/teamTaskConnections.test.ts', reason: '2.7 s at N=1; 6.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/outboundStore.test.ts', reason: '1.2 s at N=1; 6.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/supervisionRead.test.ts', reason: '3.1 s at N=1; 6.6 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatProviderEnvRoutes.test.ts', reason: '1.5 s at N=1; 6.4 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/systemCallerOrigins.test.ts', reason: '1.4 s at N=1; 6.4 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/integrationLifecycleTable.test.ts', reason: '2.1 s at N=1; 6.4 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/taskResultStore.test.ts', reason: '1.4 s at N=1; 6.3 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/teamTaskStore.test.ts', reason: '2.8 s at N=1; 6.2 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/effectResumeLanding.test.ts', reason: '2.0 s at N=1; 6.2 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/impactGate.test.ts', reason: '4.0 s at N=1; 6.2 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/effectInspectors.test.ts', reason: '0.9 s at N=1; 6.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/effectsRunner.test.ts', reason: '0.7 s at N=1; 6.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planApproval.test.ts', reason: '1.3 s at N=1; 6.0 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/mailboxManagement.test.ts', reason: '4.2 s at N=1; 5.9 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/taskRelease.test.ts', reason: '1.1 s at N=1; 5.8 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatGroupDb.test.ts', reason: '1.0 s at N=1; 5.8 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planExecutionStore.test.ts', reason: '1.0 s at N=1; 5.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/planTools.test.ts', reason: '1.1 s at N=1; 5.7 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/executionExecutor.test.ts', reason: '1.4 s at N=1; 5.6 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatContextExhaustedFlag.test.ts', reason: '1.2 s at N=1; 5.5 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/impactConnections.test.ts', reason: '2.1 s at N=1; 5.4 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/taskHandoffs.test.ts', reason: '3.6 s at N=1; 5.4 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/codexSessionGates.test.ts', reason: '1.6 s at N=1; 5.3 s at N=4; touched by open branch feat/codex-chat-sessions-e — never renamed here' },
  { file: 'src/server/__tests__/taskNotices.test.ts', reason: '3.9 s at N=1; 5.3 s only under N=4 worker contention' },
  { file: 'src/server/__tests__/chatContextDb.test.ts', reason: '1.0 s at N=1; 5.1 s only under N=4 worker contention' },  // A second full run (commit 3's hook, N=4 with concurrent suite slots) flagged
  // these over 5 s as well — all under 5 s at N=1 and under 5 s in the exclusive
  // run, so they stay outside the tier: shared-slot contention, listed here.
  { file: 'src/server/__tests__/teamMailboxParkedCancel.test.ts', reason: '2.3 s at N=1; 16.9 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/strategyStore.test.ts', reason: '2.4 s at N=1; 15.6 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/strategyService.test.ts', reason: '2.4 s at N=1; 14.1 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/supervisionMonitor.test.ts', reason: '2.2 s at N=1; 11.5 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/teamMailboxStore.test.ts', reason: '1.5 s at N=1; 10.5 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/chatSessionSearchSource.test.ts', reason: '1.1 s at N=1; 6.0 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/decisionReplyGuard.test.ts', reason: '1.2 s at N=1; 5.8 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/taskResultConnections.test.ts', reason: '1.0 s at N=1; 5.7 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/planSupervisionDetail.test.ts', reason: '1.0 s at N=1; 5.6 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/planValidationTools.test.ts', reason: '1.1 s at N=1; 5.5 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/chatModelDb.test.ts', reason: '0.7 s at N=1; 5.5 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/strategyConnections.test.ts', reason: '0.9 s at N=1; 5.3 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/integrationAgentSurface.test.ts', reason: '2.5 s at N=1; 5.3 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/chatApprovalPolicyDb.test.ts', reason: '1.2 s at N=1; 5.3 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/executionConnections.test.ts', reason: '2.2 s at N=1; 5.2 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/client/__tests__/terminalFocusSteal.test.tsx', reason: '4.7 s at N=1; 5.0 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/promotionConnections.test.ts', reason: '0.9 s at N=1; 5.1 s under a shared-slot N=4 run (not over 5 s exclusive)' },
  { file: 'src/server/__tests__/chatArchiveDb.test.ts', reason: '0.7 s at N=1; 5.0 s under a shared-slot N=4 run (not over 5 s exclusive)' },
]

export interface MisplacedFile {
  file: string
  ms: number
}

// Files over the threshold outside the slow tier that no exception lists.
// Keys are normalized (a leading './' stripped) and matched by basename.
export function misplacedFiles(options: {
  files: Record<string, number>
  isSlowTier: (file: string) => boolean
  exceptions?: ReadonlyArray<{ file: string; reason: string }>
  thresholdMs?: number
}): MisplacedFile[] {
  const thresholdMs = options.thresholdMs ?? SLOW_TIER_THRESHOLD_MS
  const listed = new Set(
    (options.exceptions ?? SLOW_TIER_EXCEPTIONS).map((exception) => path.basename(exception.file))
  )
  const misplaced: MisplacedFile[] = []
  for (const [key, ms] of Object.entries(options.files)) {
    const file = key.startsWith('./') ? key.slice(2) : key
    if (ms <= thresholdMs) continue
    if (options.isSlowTier(file)) continue
    if (listed.has(path.basename(file))) continue
    misplaced.push({ file, ms })
  }
  misplaced.sort((a, b) => b.ms - a.ms)
  return misplaced
}

// The lines the runner prints after a published full run: the dispositions
// when files need one, a quiet confirmation when the tier is honest.
export function formatMisplacedReport(misplaced: MisplacedFile[]): string[] {
  if (misplaced.length === 0) {
    return ['[test-runner] timings: no file over 5 s sits outside the slow tier']
  }
  return [
    `[test-runner] timings: ${misplaced.length} file(s) over 5 s outside the slow tier — rename to *.integration.test.ts or list in SLOW_TIER_EXCEPTIONS:`,
    ...misplaced.map((entry) => `  ${(entry.ms / 1000).toFixed(1)} s  ${entry.file}`),
  ]
}
