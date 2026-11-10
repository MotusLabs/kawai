// The public Codex driver factory (design §2, task 4.2). It maps the frozen
// CodexDriverOptions onto the session core and returns an inert driver:
// nothing spawns until start(). Options are validated here, so an
// unenforceable permission set (P08), an invalid tool set, a foreign resume
// checkpoint or a missing logger refuses construction with category
// `configuration`. The returned value exposes only the public contract.
import type { CodexAgentDriver } from '../contract.js'
import { AgentRuntimeError } from '../errors.js'
import type { CodexDriverOptions } from '../options.js'
import { CodexSession } from './session.js'

function configurationError(message: string): AgentRuntimeError {
  return new AgentRuntimeError({ category: 'configuration', message })
}

const LOGGER_METHODS = ['debug', 'info', 'warn', 'error'] as const

export function createCodexDriver(options: CodexDriverOptions): CodexAgentDriver {
  if (!options || typeof options !== 'object') throw configurationError('driver options are required')
  const logger = options.logger as unknown as Record<string, unknown> | undefined
  if (!logger || LOGGER_METHODS.some((method) => typeof logger[method] !== 'function')) throw configurationError('logger must have debug, info, warn and error methods')
  if (!options.callbacks || typeof options.callbacks.onEvent !== 'function') throw configurationError('callbacks.onEvent is required')
  if (options.permissions === undefined) throw configurationError('permissions are required')
  if (options.resume !== undefined && (options.resume?.runtime !== 'codex' || typeof options.resume.runtimeSessionId !== 'string' || !options.resume.runtimeSessionId)) {
    throw configurationError('resume must be a Codex checkpoint with a runtimeSessionId')
  }
  if (options.unansweredRequests !== undefined && options.unansweredRequests !== 'deny' && options.unansweredRequests !== 'wait') {
    throw configurationError('unansweredRequests must be deny or wait')
  }
  return new CodexSession({
    launch: options.launch,
    callbacks: options.callbacks,
    logger: options.logger,
    permissions: options.permissions,
    ...(options.wire ? { wire: options.wire } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.systemPromptAppend ? { systemPromptAppend: options.systemPromptAppend } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.beforeSubmit ? { beforeSubmit: options.beforeSubmit } : {}),
    ...(options.onToolObservation ? { onToolObservation: options.onToolObservation } : {}),
    ...(options.auditHooks ? { auditHooks: options.auditHooks } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.unansweredRequests ? { unansweredRequests: options.unansweredRequests } : {}),
  })
}
