// iOS text-presentation workaround: iOS Safari renders certain characters
// (Claude's \u23FA bullet) as emoji; inserting a text presentation selector
// after them forces text glyphs instead.

// Text presentation selector - forces text rendering instead of emoji
const TEXT_VS = '\uFE0E'

// Characters that iOS Safari renders as emoji but should be text
// Only add characters here that are verified to cause issues
const EMOJI_TO_TEXT_CHARS = [
  '\u23FA', // \u23FA Black Circle for Record (Claude's bullet)
] as const
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const EMOJI_TO_TEXT_REGEX = new RegExp(
  EMOJI_TO_TEXT_CHARS.map(escapeRegExp).join('|'),
  'g'
)

/**
 * Add text presentation selector after characters that iOS renders as emoji.
 * This forces the browser to render them as text glyphs instead.
 */
export function forceTextPresentation(data: string): string {
  // Hot path: most terminal output doesn't contain emoji-like glyphs.
  // Avoid per-character concatenation (expensive) and skip work when not needed.
  for (const char of EMOJI_TO_TEXT_CHARS) {
    if (data.indexOf(char) === -1) {
      continue
    }
    return data.replace(EMOJI_TO_TEXT_REGEX, `$&${TEXT_VS}`)
  }
  return data
}
