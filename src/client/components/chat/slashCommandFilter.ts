// Caret-aware helpers for the composer's slash-command menu plus its ranking.
// slashTokenAt (slash-command-autocomplete-anywhere design D1) finds the `/`
// word at the caret — the menu's open condition, its filter query, and the
// span a choice replaces — anywhere in the message; insertCommand (design D3)
// swaps that word for `/<name> `. Ranking (add-chat-slash-commands design D5)
// is unchanged: name prefix first, alias prefix second, name substring third,
// description substring last; within a tier the server's list order is kept.
import type { ChatCommand } from '@shared/chat'

/** A `/` word at the caret: what the menu filters by and a choice replaces. */
export interface SlashToken {
  /** Index of the `/` that opens the word. */
  start: number
  /** Index just past the word's last character; a choice replaces [start, end). */
  end: number
  /** The typed text from the `/` through the caret, e.g. "/re". */
  query: string
}

/**
 * The `/` word containing the caret, or null when the menu stays closed. The
 * word's `/` must sit at the start of the text or after whitespace, and no
 * second `/` may sit between it and the caret (so `a/b`, URLs, and paths like
 * /usr/bin stay closed). `end` runs past the caret over the rest of the word,
 * so choosing with the caret mid-word replaces the whole word.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  if (caret < 0 || caret > text.length) return null
  // Walk back over the whitespace-delimited word the caret sits in.
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--
  if (text[start] !== '/' || caret === start) return null
  if (text.slice(start + 1, caret).includes('/')) return null
  let end = caret
  while (end < text.length && !/\s/.test(text[end]!)) end++
  return { start, end, query: text.slice(start, caret) }
}

/**
 * Replace the token's word with `/<name> ` (design D3): the following run of
 * spaces/tabs collapses so inserting before an existing space leaves one, and
 * the returned caret sits just after the inserted space.
 */
export function insertCommand(
  text: string,
  token: SlashToken,
  name: string
): { text: string; caret: number } {
  const tail = text.slice(token.end).replace(/^[ \t]+/, '')
  return {
    text: `${text.slice(0, token.start)}/${name} ${tail}`,
    caret: token.start + name.length + 2,
  }
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
