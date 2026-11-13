import { createCodexDriver, hasCodexLogin } from '@motuslabs/agent-runtime/codex'
import type { CodexAgentDriver, LaunchConfiguration, Logger, ResumeCheckpoint } from '@motuslabs/agent-runtime'

/** The host's own durable store for the thread id. */
export interface CheckpointStore {
  load(): ResumeCheckpoint | null
  save(checkpoint: ResumeCheckpoint): Promise<void>
}

// Ownership transfers to the caller: always await shutdown() in an outside
// finally after construction, including when start(), send() or output fails.
// A headless Codex host. It builds a driver only when the retained Codex home
// (the launch's homeDir, also its CODEX_HOME) holds a login, and nothing ever
// waits for a UI: approvals, user input and elicitation are off. A fresh
// thread's id is saved before start() resolves, so a later host process with
// the same homes resumes the same thread under this host's own policy. A host
// running several drivers on one login passes claimRateLimitsRead, so only
// the generation its own state picks sends the one account rate-limit read.
export function headlessCodex(launch: LaunchConfiguration, logger: Logger, store: CheckpointStore, claimRateLimitsRead?: () => boolean): CodexAgentDriver | null {
  if (!hasCodexLogin(launch.homeDir)) return null
  const saved = store.load()
  return createCodexDriver({
    launch,
    logger,
    permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' },
    ...(saved ? { resume: saved } : {}),
    ...(claimRateLimitsRead ? { claimRateLimitsRead } : {}),
    callbacks: {
      onEvent: (event) => logger.debug({ type: event.type }, 'agent event'),
      onCheckpoint: (checkpoint) => store.save(checkpoint),
    },
  })
}
