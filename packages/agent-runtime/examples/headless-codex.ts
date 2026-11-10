import { createCodexDriver, hasCodexLogin } from '@motuslabs/agent-runtime/codex'
import type { CodexAgentDriver, LaunchConfiguration, Logger, ResumeCheckpoint } from '@motuslabs/agent-runtime'

/** The host's own durable store for the thread id. */
export interface CheckpointStore {
  load(): ResumeCheckpoint | null
  save(checkpoint: ResumeCheckpoint): Promise<void>
}

// A headless Codex host. It builds a driver only when the retained Codex home
// (the launch's homeDir, also its CODEX_HOME) holds a login, and nothing ever
// waits for a UI: approvals, user input and elicitation are off. A fresh
// thread's id is saved before start() resolves, so a later host process with
// the same homes resumes the same thread under this host's own policy.
export function headlessCodex(launch: LaunchConfiguration, logger: Logger, store: CheckpointStore): CodexAgentDriver | null {
  if (!hasCodexLogin(launch.homeDir)) return null
  const saved = store.load()
  return createCodexDriver({
    launch,
    logger,
    permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' },
    ...(saved ? { resume: saved } : {}),
    callbacks: {
      onEvent: (event) => logger.debug({ type: event.type }, 'agent event'),
      onCheckpoint: (checkpoint) => store.save(checkpoint),
    },
  })
}
