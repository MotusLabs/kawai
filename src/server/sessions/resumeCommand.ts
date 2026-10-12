// Resume-command construction for session wake: the per-agent resume
// template, stored-launch-flag injection, and template validation. Pure over
// the stored agent-session record; lifted verbatim from index.ts.
import { config } from '../config'
import { shellQuote } from '../shellQuote'
import { normalizePaneStartCommand } from '../agentDetection'
import type { AgentSessionRecord } from '../db'
import type { AgentType, WakeError } from '../../shared/types'

/**
 * Build a resume command by injecting stored launch flags into the resume template.
 * e.g. stored "claude --dangerously-skip-permissions" + template "claude --resume {sessionId}"
 *   → "claude --dangerously-skip-permissions --resume <id>"
 * e.g. stored "codex --yolo --search" + template "codex resume {sessionId}"
 *   → "codex --yolo --search resume <id>"
 * e.g. stored "pi --fast" + template "pi --session {logFilePath}"
 *   → "pi --fast --session <log-file-path>"
 */
function getResumeCommandTemplate(agentType: AgentType): string {
  if (agentType === 'claude' || agentType === 'claude-rp') {
    return config.claudeResumeCmd
  }
  if (agentType === 'pi') {
    return config.piResumeCmd
  }
  return config.codexResumeCmd
}

function renderResumeCommandTemplate(
  resumeTemplate: string,
  record: AgentSessionRecord
): string {
  return resumeTemplate
    .replace(/\{sessionId\}/g, shellQuote(record.sessionId))
    .replace(/\{logFilePath\}/g, shellQuote(record.logFilePath))
}

export function buildResumeCommand(
  record: AgentSessionRecord
): string {
  const resumeTemplate = getResumeCommandTemplate(record.agentType)
  const baseResumeCmd = renderResumeCommandTemplate(resumeTemplate, record)

  if (!record.launchCommand) {
    return baseResumeCmd
  }

  // Extract flags from the stored command: strip the executable (first token)
  // and any existing resume subcommand/flag + its session ID argument.
  // Normalize first to handle tmux quoting and bash -lc wrappers.
  const resumableArg = /(?:"[^"]*"|'[^']*'|\S+)/
  // The composed first-prompt positional (a quoted `/opsx:apply <change>` or
  // `$openspec-apply-change <change>`, always last) must not re-run on wake —
  // strip it by pattern; unrelated quoted flag values stay untouched.
  const applyPromptArg = /(?:^|\s)'(?:\/opsx:apply|\$openspec-apply-change)\s+[^']*'/
  const flags = normalizePaneStartCommand(record.launchCommand)
    .replace(/^\S+\s*/, '')             // strip executable
    .replace(new RegExp(`--resume(?:\\s+|=)${resumableArg.source}`, 'g'), '') // strip --resume <id> / --resume=<id> (Claude)
    .replace(new RegExp(`\\bresume\\s+${resumableArg.source}`, 'g'), '') // strip resume <id> (Codex subcommand)
    .replace(new RegExp(`--session(?:\\s+|=)${resumableArg.source}`, 'g'), '') // strip --session <path> / --session=<path> (Pi)
    .replace(new RegExp(applyPromptArg.source, 'g'), '') // strip the auto-start apply prompt
    .replace(/\s+/g, ' ')
    .trim()

  if (!flags) {
    return baseResumeCmd
  }

  // Inject flags after the executable in the resume command
  const firstSpace = baseResumeCmd.indexOf(' ')
  if (firstSpace === -1) {
    return `${baseResumeCmd} ${flags}`
  }
  const exe = baseResumeCmd.slice(0, firstSpace)
  const rest = baseResumeCmd.slice(firstSpace + 1)
  return `${exe} ${flags} ${rest}`
}

export function validateWakeTemplate(record: AgentSessionRecord): WakeError | null {
  const resumeTemplate = getResumeCommandTemplate(record.agentType)
  if (
    resumeTemplate.includes('{sessionId}') ||
    resumeTemplate.includes('{logFilePath}')
  ) {
    return null
  }

  return {
    code: 'WAKE_FAILED',
    message: 'Wake command template missing {sessionId} or {logFilePath} placeholder',
  }
}
