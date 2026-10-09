// Pure filtering and ranking for the composer's slash-command menu
// (add-chat-slash-commands design D5). Spec order: name prefix first, alias
// prefix second, name substring third, description substring last; within a
// tier the server's list order is preserved.
import type { ChatCommand } from '@shared/chat'

/** Match the menu's open condition: a bare command being typed, no args. */
export const SLASH_MENU_QUERY = /^\/\S*$/

/** The typed command text ("/", "/re", ...) or null when the menu stays closed. */
export function slashMenuQuery(text: string): string | null {
  return SLASH_MENU_QUERY.test(text) ? text : null
}

/**
 * Rank the session's commands against the typed text (case-insensitive; the
 * leading slash is optional in the query). An empty query returns everything.
 */
export function filterChatCommands(
  commands: ChatCommand[],
  query: string
): ChatCommand[] {
  const typed = query.replace(/^\//, '').toLowerCase()
  if (!typed) return commands
  const tiers: ChatCommand[][] = [[], [], [], []]
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(typed)) tiers[0].push(command)
    else if (
      command.aliases.some((alias) => alias.toLowerCase().startsWith(typed))
    ) {
      tiers[1].push(command)
    } else if (name.includes(typed)) tiers[2].push(command)
    else if (command.description.toLowerCase().includes(typed)) {
      tiers[3].push(command)
    }
  }
  return tiers.flat()
}
