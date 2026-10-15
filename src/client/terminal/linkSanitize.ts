// Link-text sanitizing for terminal hyperlinks: trims wrapping punctuation
// and unbalanced bracket pairs that URL matching picks up from prose.

const TRAILING_PUNCTUATION_REGEX = /[.,;:!?]+$/
const BRACKET_PAIRS: Array<[string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]

const countOccurrences = (text: string, char: string) => text.split(char).length - 1

export function sanitizeLink(text: string): string {
  let result = text.trim()
  if (!result) return result

  const stripTrailingPunctuation = () => {
    result = result.replace(TRAILING_PUNCTUATION_REGEX, '')
  }

  stripTrailingPunctuation()

  let trimmed = true
  while (trimmed) {
    trimmed = false
    for (const [open, close] of BRACKET_PAIRS) {
      if (!result.endsWith(close)) continue
      const openCount = countOccurrences(result, open)
      const closeCount = countOccurrences(result, close)
      if (closeCount > openCount) {
        result = result.slice(0, -1)
        trimmed = true
      }
    }
  }

  stripTrailingPunctuation()
  return result
}
