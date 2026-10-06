// Per-session slash-command state (add-chat-slash-commands design D2):
// normalization of the raw command lists Claude Code reports — the initialize
// response, `system/commands_changed`, and `system/init`'s terminal-bound set
// — into the ChatCommandState clients receive, plus the
// loading/ready/unavailable transitions. The driver forwards raw inputs;
// every rule about sources, hiding, and de-duplication lives here so the
// driver does not grow with it.
import type { ChatCommand, ChatCommandState } from '../../shared/chat'

/**
 * A raw command row exactly as the SDK reports it (SlashCommand): `builtin`
 * marks Claude Code's own commands, everything else is user/project/plugin
 * defined.
 */
export interface RawChatCommand {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
  builtin?: boolean
}

/**
 * Terminal-bound commands hidden while `system/init` has not reported the
 * real set. Observed from a real process (Claude Code bundled with SDK
 * 0.3.289); replaced by `init.terminal_slash_commands` on the first prompt
 * (verified 2026-10-06: init only arrives once a turn starts).
 */
export const FALLBACK_TERMINAL_COMMANDS: readonly string[] = [
  'doctor',
  'color',
  'focus',
  'reload-plugins',
]

/** Display suffix marking a project-defined command's description. */
const PROJECT_SUFFIX = ' (project)'

/** Normalize one raw row: source from the builtin marker / project suffix. */
function normalizeCommand(raw: RawChatCommand): ChatCommand {
  const isProject = raw.description.endsWith(PROJECT_SUFFIX)
  return {
    name: raw.name,
    description: isProject
      ? raw.description.slice(0, -PROJECT_SUFFIX.length)
      : raw.description,
    ...(raw.argumentHint ? { argumentHint: raw.argumentHint } : {}),
    aliases: raw.aliases ?? [],
    source: raw.builtin ? 'builtin' : isProject ? 'project' : 'user',
  }
}

/**
 * Normalize a raw list into the client-facing one: internal (`__`-prefixed)
 * and terminal-bound commands are hidden; on a name collision the builtin row
 * wins (the SDK rule: /name runs the marked row when one carries the name).
 */
export function normalizeChatCommands(
  raw: RawChatCommand[],
  terminal: ReadonlySet<string>
): ChatCommand[] {
  const byName = new Map<string, ChatCommand>()
  for (const row of raw) {
    if (!row.name || row.name.startsWith('__')) continue
    if (terminal.has(row.name)) continue
    const command = normalizeCommand(row)
    const existing = byName.get(row.name)
    if (
      !existing ||
      (command.source === 'builtin' && existing.source !== 'builtin')
    ) {
      byName.set(row.name, command)
    }
  }
  return [...byName.values()]
}

function commandsEqual(a: ChatCommand[], b: ChatCommand[]): boolean {
  if (a.length !== b.length) return false
  return a.every((command, index) => {
    const other = b[index]
    return (
      command.name === other.name &&
      command.description === other.description &&
      command.argumentHint === other.argumentHint &&
      command.source === other.source &&
      command.aliases.length === other.aliases.length &&
      command.aliases.every((alias, i) => alias === other.aliases[i])
    )
  })
}

/** Notified with the fresh state whenever it meaningfully changed. */
export type ChatCommandListener = (state: ChatCommandState) => void

/**
 * One session's command list state machine. The driver feeds raw inputs from
 * the three protocol sources; `onChange` fires only when the published state
 * (status or list contents) actually changed, so identical pushes stay silent.
 */
export class ChatCommandTracker {
  private status: ChatCommandState['status'] = 'loading'
  private commands: ChatCommand[] = []
  private terminal = new Set<string>(FALLBACK_TERMINAL_COMMANDS)
  /** Last raw rows, re-normalized when init replaces the terminal set. */
  private lastRaw: RawChatCommand[] | null = null

  constructor(private readonly onChange?: ChatCommandListener) {}

  get state(): ChatCommandState {
    return { status: this.status, commands: this.commands }
  }

  /** A spawn happened: its initialize response is on the way. Idempotent. */
  beginLoading(): void {
    this.publishIfChanged('loading', this.commands)
  }

  /**
   * The full list from the initialize response or a `commands_changed` push
   * (both replace everything; `commands_changed` is documented to carry the
   * complete list).
   */
  applyCommands(raw: RawChatCommand[]): void {
    this.lastRaw = raw
    this.publishIfChanged('ready', normalizeChatCommands(raw, this.terminal))
  }

  /**
   * `system/init`: the authoritative terminal-bound set. Falls back silently
   * when the CLI predates the field; re-normalizes and re-publishes when the
   * real set differs from the fallback.
   */
  applyTerminalCommands(names: string[] | undefined): void {
    if (!names) return
    this.terminal = new Set(names)
    if (this.lastRaw) {
      this.publishIfChanged(this.status, normalizeChatCommands(this.lastRaw, this.terminal))
    }
  }

  /** No process to ask: never started, blocked, dead, or archived. */
  markUnavailable(): void {
    this.publishIfChanged('unavailable', this.commands)
  }

  private publishIfChanged(
    status: ChatCommandState['status'],
    commands: ChatCommand[]
  ): void {
    const changed =
      status !== this.status || !commandsEqual(commands, this.commands)
    this.status = status
    this.commands = commands
    if (changed) this.onChange?.(this.state)
  }
}
