// Pure string extraction from terminal captures and message text: user
// prompts (Claude/Codex/Pi), trace lines, tool-notification filtering, paste
// placeholders, and slash-command/user_action decoding.
import { MIN_EXACT_MATCH_LENGTH } from './common'
import {
  cleanTmuxLine,
  isMetadataLine,
  stripAnsi,
  TMUX_METADATA_STATUS_PATTERNS,
  TMUX_PROMPT_PREFIX,
  TMUX_UI_GLYPH_PATTERN,
} from '../terminal/tmuxText'

const MAX_RECENT_USER_MESSAGES = 25
const MAX_RECENT_TRACE_LINES = 12
const TRACE_EXCLUDE_PREFIXES = [
  /^explored\b/i,
  /^ran\b/i,
  /^search\b/i,
  /^read\b/i,
  /^use\b/i,
] as const
const TRACE_STATUS_TRAILER = /\s*\(([^)]*)\)\s*$/
const TRACE_STATUS_HINTS = [
  /esc to interrupt/i,
  /context left/i,
  /for shortcuts/i,
  /background terminal running/i,
  /\b\d+\s*(?:ms|s|m|h|d)\b/i,
] as const

const TOOL_NOTIFICATION_MARKERS = [
  '<task-notification>',
  '<task-id>',
  '<output-file>',
  '<status>',
  '<summary>',
  'read the output file to retrieve the result',
  // Codex system messages
  '<instructions>',
  '# agents.md instructions',
  '<environment_context>',
  // Claude Code slash-command / auto-compact stdout/stderr (e.g. `<local-command-stdout>\x1b[2mCompacted...\x1b[22m</local-command-stdout>`)
  '<local-command-stdout>',
  '<local-command-stderr>',
  // Raw slash-command invocations. Live extraction prefers the "/cmd args"
  // form via extractCommandInvocation; this marker exists so the cache-refresh
  // path in logPoller treats any pre-fix cached `<command-message>...` payload
  // as stale and re-runs extraction.
  '<command-message>',
] as const



/**
 * Pattern for Codex CLI tool-use warnings injected as user messages.
 * Example: "Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead."
 */
const CODEX_TOOL_WARNING_PATTERN = /^warning:\s+\w+\s+was\s+requested\s+via\s+exec_command/i

export function isToolNotificationText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const normalized = trimmed.toLowerCase()
  if (normalized.startsWith('<task-notification>')) {
    return true
  }
  // Filter Codex CLI tool-use warnings (e.g., "Warning: apply_patch was requested via exec_command")
  if (CODEX_TOOL_WARNING_PATTERN.test(trimmed)) {
    return true
  }
  return TOOL_NOTIFICATION_MARKERS.some((marker) => normalized.includes(marker))
}

/**
 * Agent TUIs collapse a large paste into a bracketed placeholder — Claude
 * Code renders "[Pasted text #1 +263 lines]" — so a terminal capture of such
 * a prompt is lossy: only the JSONL log has the real content. Strips every
 * placeholder and collapses the surrounding whitespace. The pattern demands
 * a counter token (#N, +N lines, or N chars/lines) so legitimate bracketed
 * prose like "[pasted from docs]" is left alone. Returns the input string
 * unchanged (same reference) when no placeholder is present, so callers can
 * detect placeholders via `stripPastePlaceholders(t) !== t`.
 */
const PASTE_PLACEHOLDER_PATTERN =
  /\[\s*pasted(?:\s+text)?[^\]]*?(?:#\d+|\+\d+\s*lines?|\d+\s*(?:characters|chars?|lines?))[^\]]*\]/gi

export function stripPastePlaceholders(text: string): string {
  const stripped = text.replace(PASTE_PLACEHOLDER_PATTERN, ' ')
  if (stripped === text) return text
  return stripped.replace(/\s+/g, ' ').trim()
}

/**
 * Extract the action name from a <user_action> XML block.
 * Returns the action (e.g., "review") or null if not a user_action block.
 */
export function extractActionFromUserAction(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.toLowerCase().startsWith('<user_action>')) {
    return null
  }
  const actionMatch = trimmed.match(/<action>\s*([^<]+)\s*<\/action>/i)
  if (actionMatch?.[1]) {
    return actionMatch[1].trim()
  }
  return null
}

/**
 * Extract a human-readable slash command invocation from a Claude Code
 * `<command-message>...</command-message><command-name>/cmd</command-name><command-args>args</command-args>`
 * user message. Returns "/cmd args" (or "/cmd" with no args) or null if not a command invocation.
 *
 * To avoid false positives on user-authored prose containing `<command-name>` tags,
 * we require the full Claude block shape (both `<command-message>` and `<command-name>`)
 * and require the extracted name to be a slash command.
 */
export function extractCommandInvocation(text: string): string | null {
  if (!text.includes('<command-message>') || !text.includes('<command-name>')) return null
  const nameMatch = text.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/i)
  const name = nameMatch?.[1]?.trim()
  if (!name || !name.startsWith('/')) return null
  const argsMatch = text.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/i)
  const args = argsMatch?.[1]?.trim() ?? ''
  return args ? `${name} ${args}` : name
}

const TMUX_PROMPT_DETECT_PREFIX = /^[\s>*#$]+/

function stripPromptPrefixForDetection(line: string): string {
  return stripAnsi(line).trim().replace(TMUX_PROMPT_DETECT_PREFIX, '')
}

function isClaudePromptLine(line: string): boolean {
  const cleaned = stripPromptPrefixForDetection(line)
  if (!cleaned) return false
  return cleaned.startsWith('❯')
}

function isCodexPromptLine(line: string): boolean {
  const cleaned = stripPromptPrefixForDetection(line)
  if (!cleaned) return false
  return cleaned.startsWith('›')
}

function isPromptLine(line: string): boolean {
  return isClaudePromptLine(line) || isCodexPromptLine(line)
}

// Pi TUI uses a specific background color (RGB 52,53,65) for user messages.
// This color is defined in Pi's built-in "tokyo-night" theme (userMessageBg).
// See: https://github.com/anthropics/pi/blob/main/src/themes/tokyo-night.ts
// NOTE: If Pi changes this color or the user selects a different theme, detection will fail.
// Pattern: \x1b[48;2;52;53;65m...message...\x1b[49m (or end of content)
// eslint-disable-next-line no-control-regex
const PI_USER_MESSAGE_BG_START = /\x1b\[48;2;52;53;65m/g
// eslint-disable-next-line no-control-regex
const PI_USER_MESSAGE_BG_END = /\x1b\[49m/

/**
 * Extract user messages from Pi's TUI by detecting the background color pattern.
 * Pi uses RGB(52,53,65) background for user messages in the default tokyo-night theme.
 * Returns empty array if no Pi-style messages are detected (e.g., different theme).
 */
export function extractPiUserMessagesFromAnsi(
  ansiContent: string,
  maxMessages = MAX_RECENT_USER_MESSAGES
): string[] {
  const messages: string[] = []
  const matches = [...ansiContent.matchAll(PI_USER_MESSAGE_BG_START)]

  // Process from end (most recent) to beginning
  for (let i = matches.length - 1; i >= 0 && messages.length < maxMessages; i--) {
    const match = matches[i]
    if (!match || match.index === undefined) continue

    const startIdx = match.index + match[0].length
    const rest = ansiContent.slice(startIdx)
    const endMatch = rest.match(PI_USER_MESSAGE_BG_END)
    const endIdx = endMatch ? endMatch.index! : rest.length

    const rawMessage = rest.slice(0, endIdx)
    // Strip any remaining ANSI codes and clean up
    const cleaned = stripAnsi(rawMessage).trim()

    if (cleaned && cleaned.length > 0 && !messages.includes(cleaned)) {
      messages.push(cleaned)
    }
  }

  return messages
}

function extractUserFromPrompt(line: string): string {
  let cleaned = stripAnsi(line).trim()
  cleaned = cleaned.replace(TMUX_PROMPT_PREFIX, '').trim()
  cleaned = cleaned.replace(/^›\s*/, '').trim()
  cleaned = cleaned.replace(/\s*↵\s*send\s*$/i, '').trim()
  cleaned = cleaned.replace(TMUX_UI_GLYPH_PATTERN, ' ')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned
}

/**
 * Detect a box-drawing horizontal separator line (e.g. ─────────).
 * Claude Code draws these as the input field border using U+2500 (─),
 * sometimes mixed with U+2501 (━) or U+2550 (═). A line of 20+ such
 * characters is a reliable signal that we're inside the input box.
 */
const BOX_SEPARATOR_PATTERN = /^[─━═]{20,}$/

/**
 * Max distance from the bottom of the scrollback for the box separator
 * check. The input field is always at the very bottom of the terminal,
 * so we only trust the separator when the prompt is within this many
 * lines of the end — avoids false positives from ─── in pasted content
 * or markdown tables higher up in the scrollback.
 */
const BOX_SEPARATOR_BOTTOM_MARGIN = 8

function isCurrentInputField(rawLines: string[], promptIdx: number): boolean {
  const nearBottom = rawLines.length - promptIdx <= BOX_SEPARATOR_BOTTOM_MARGIN
  for (let i = promptIdx + 1; i < Math.min(promptIdx + 4, rawLines.length); i++) {
    const line = rawLines[i]?.trim() ?? ''
    // Assistant output (⏺) below the prompt means it was submitted, not idle
    if (/⏺/.test(line)) break
    if (/\d+%\s*(?:context\s*)?left/i.test(line)) return true
    if (/\[\d+%\]/.test(line)) return true
    if (/\?\s*for\s*shortcuts/i.test(line)) return true
    // Codex configurable status line: items joined by " · " (middle dot).
    // Default items: model-with-reasoning, context-remaining, current-dir.
    // context-remaining is caught by the "N% left" check above, but any
    // other combination may omit it. Two patterns cover the remaining cases:
    // 1. Any line with both ~/path and · (CurrentDir/ProjectRoot + anything)
    if (/~\//.test(line) && /·/.test(line)) return true
    // 2. Line starting with a known model prefix + · (ModelName + anything)
    if (/^(?:gpt|o[1-4]|codex|claude)\S*\s.*·/.test(line)) return true
    // Claude Code input box border — only trust near the bottom of scrollback
    if (nearBottom && BOX_SEPARATOR_PATTERN.test(line)) return true
  }
  return false
}

/**
 * Detect AskUserQuestion interactive selection lines.
 * Claude Code's AskUserQuestion UI uses ❯ to mark the selected option,
 * which collides with the ❯ prompt symbol for user messages.
 *
 * Detection requires TWO independent signals:
 * 1. The text after ❯ starts with "N. " (numbered option pattern)
 * 2. At least one corroborating indicator nearby:
 *    a. "Enter to select" navigation hint below, with no structural
 *       boundaries (⏺ assistant markers, other ❯ prompts) between
 *    b. Sibling numbered options within a bounded block AND no ⏺
 *       assistant output follows the block (distinguishes active
 *       AskUserQuestion from submitted multi-line user messages)
 */
function isAskUserQuestionOption(rawLines: string[], promptIdx: number): boolean {
  const line = rawLines[promptIdx] ?? ''
  // Strip the prompt prefix (❯/›) and check if what remains is a numbered item
  const afterPrompt = stripAnsi(line)
    .replace(TMUX_PROMPT_PREFIX, '')
    .replace(/^›\s*/, '')
    .trim()

  // Signal 1: the text after ❯/› starts with "N. ..."
  if (!/^\d+\.\s/.test(afterPrompt)) {
    return false
  }

  // Signal 2a: "Enter to select" navigation hint below, stopping at structural
  // boundaries (assistant output ⏺, another prompt ❯/›) to avoid false positives
  // from assistant text that happens to contain the phrase.
  for (let i = promptIdx + 1; i < Math.min(promptIdx + 20, rawLines.length); i++) {
    const below = rawLines[i] ?? ''
    const trimmed = below.trim()
    // Stop at structural boundaries — we've left the selector block
    if (/⏺/.test(below) || isPromptLine(below)) break
    // Claude: "Enter to select", Codex: "enter to submit answer"
    if (/enter\s+to\s+(select|submit\s+answer)/i.test(trimmed)) return true
  }

  // Signal 2b: sibling numbered options within a bounded block.
  // Scan both above and below, stopping at structural boundaries
  // (⏺ markers, ❯/› prompts).
  const hasSibling = (start: number, step: number, maxSteps: number): boolean => {
    for (let n = 1; n <= maxSteps; n++) {
      const idx = start + step * n
      if (idx < 0 || idx >= rawLines.length) break
      const raw = rawLines[idx] ?? ''
      // Stop at structural boundaries
      if (/⏺/.test(raw) || isPromptLine(raw)) break
      const sibling = stripAnsi(raw).trim()
      if (/^\d+\.\s/.test(sibling)) return true
    }
    return false
  }

  if (hasSibling(promptIdx, 1, 4) || hasSibling(promptIdx, -1, 4)) {
    // Distinguish active AskUserQuestion from submitted multi-line user messages:
    // a submitted message always has ⏺ assistant output after it, while an active
    // AskUserQuestion card does not (it's waiting for user selection).
    // Scan forward past the block to check.
    for (let i = promptIdx + 1; i < Math.min(promptIdx + 10, rawLines.length); i++) {
      const raw = rawLines[i] ?? ''
      if (/⏺/.test(raw)) return false // assistant responded → submitted user message
      if (isPromptLine(raw)) break // another prompt → stop
    }
    return true
  }

  return false
}

export function extractRecentUserMessagesFromTmux(
  content: string,
  maxMessages = MAX_RECENT_USER_MESSAGES
): string[] {
  const rawLines = stripAnsi(content).split('\n')
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]?.trim() === '') {
    rawLines.pop()
  }

  const messages: string[] = []
  for (let i = rawLines.length - 1; i >= 0 && messages.length < maxMessages; i--) {
    const line = rawLines[i] ?? ''
    if (!isPromptLine(line)) continue
    if (isCurrentInputField(rawLines, i)) continue
    if (isAskUserQuestionOption(rawLines, i)) continue
    if (line.includes('↵')) continue
    const message = extractUserFromPrompt(line)
    if (!message) continue
    if (!messages.includes(message)) {
      messages.push(message)
    }
  }

  return messages
}

function stripTraceStatusSuffix(line: string): string {
  const match = line.match(TRACE_STATUS_TRAILER)
  if (!match) return line
  const inner = match[1] ?? ''
  if (!TRACE_STATUS_HINTS.some((pattern) => pattern.test(inner))) {
    return line
  }
  return line.slice(0, match.index).trim()
}

export function extractRecentTraceLinesFromTmux(
  content: string,
  maxLines = MAX_RECENT_TRACE_LINES
): string[] {
  const rawLines = stripAnsi(content).split('\n')
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]?.trim() === '') {
    rawLines.pop()
  }

  const traces: string[] = []
  for (let i = rawLines.length - 1; i >= 0 && traces.length < maxLines; i--) {
    const raw = rawLines[i] ?? ''
    const trimmed = raw.trim()
    if (!trimmed.startsWith('•')) continue
    let cleaned = cleanTmuxLine(raw)
    if (!cleaned) continue
    cleaned = stripTraceStatusSuffix(cleaned)
    if (!cleaned) continue
    if (TRACE_EXCLUDE_PREFIXES.some((prefix) => prefix.test(cleaned))) continue
    if (isMetadataLine(cleaned, TMUX_METADATA_STATUS_PATTERNS)) continue
    if (cleaned.length < MIN_EXACT_MATCH_LENGTH) continue
    if (!traces.includes(cleaned)) {
      traces.push(cleaned)
    }
  }

  return traces
}
