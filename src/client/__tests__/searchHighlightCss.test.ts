// Guards the chat search highlight in index.css: matched text stays readable
// and the highlight stays distinguishable from the surface in every theme the
// results or the revealed transcript row render in.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')

function declarations(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing rule: ${selector}`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]))
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

const THEMES = [
  { name: 'dark', selector: ':root,\n[data-theme="dark"]', surfaces: ['--bg-base', '--bg-elevated'], own: true },
  { name: 'light', selector: '[data-theme="light"]', surfaces: ['--bg-base', '--bg-elevated'], own: true },
  { name: 'chat palette', selector: ':root:not([data-theme="light"]) .chat-palette', surfaces: ['--bg-base', '--bg-elevated'], own: true },
]

describe('chat search highlight colors', () => {
  for (const theme of THEMES) {
    const tokens = declarations(theme.selector)

    test(`${theme.name}: matched text reaches 4.5:1 on the highlight`, () => {
      expect(contrast(tokens['--search-match-fg']!, tokens['--search-match-bg']!)).toBeGreaterThanOrEqual(4.5)
    })

    test(`${theme.name}: the highlight is distinguishable from each surface`, () => {
      for (const surface of theme.surfaces) {
        expect(contrast(tokens['--search-match-bg']!, tokens[surface]!)).toBeGreaterThanOrEqual(1.3)
      }
    })
  }

  test('defines the classes the results and transcript use', () => {
    for (const selector of ['.search-match {', '.search-active {', '.chat-reveal {', '@keyframes chat-reveal-fade']) {
      expect(css).toContain(selector)
    }
  })

  test('reduced motion holds the reveal highlight instead of animating it', () => {
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce) {\n  .chat-reveal'))
    expect(reduced).toContain('animation: none')
    expect(reduced).toContain('background-color: var(--search-match-bg)')
  })

  test('uses no opacity-suffixed variable colors', () => {
    const searchCss = css.slice(css.indexOf('/* Chat search (chat-session-search D6)'))
    expect(searchCss).not.toMatch(/\/\d+/)
  })
})
