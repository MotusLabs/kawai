import { createClaudeDriver } from '@motuslabs/agent-runtime/claude'
import type { ClaudeAgentDriver, LaunchConfiguration, Logger } from '@motuslabs/agent-runtime'

// A headless host that answers every request inside onRequest: Read is
// allowed, every other tool is denied, and a question gets the host's own
// prepared answer. Nothing waits for a UI or a timer. If the driver refuses
// an answer (an empty or unknown one, say), the default denial applies.
export function headlessClaude(launch: LaunchConfiguration, logger: Logger, prepared: Record<string, string>): ClaudeAgentDriver {
  const driver: ClaudeAgentDriver = createClaudeDriver({
    launch,
    logger,
    permissions: { mode: 'default', enabledTools: ['Read', 'Bash', 'AskUserQuestion'], disallowedTools: [] },
    callbacks: {
      onEvent: (event) => logger.debug({ type: event.type }, 'agent event'),
      onRequest: (request) => {
        if (request.kind === 'approval') {
          driver.resolveApproval(request.requestId, request.tool === 'Read' ? 'allow' : 'deny')
          return
        }
        const answers = Object.fromEntries(request.questions.map((q) => [q.question, { text: prepared[q.question] ?? '' }]))
        const outcome = driver.answerQuestion(request.requestId, answers)
        if (!outcome.ok) logger.warn({ reason: outcome.reason }, 'answer refused; the request is denied')
      },
    },
  })
  return driver
}
