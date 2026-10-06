// Guards the chat view's dark palette in index.css: WCAG contrast bounds for
// the scoped tokens and primary button, and that the light theme stays unscoped.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')
const SCOPE = ':root:not([data-theme="light"]) .chat-palette'

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing rule: ${selector}`)
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
}

function declarations(selector: string): Record<string, string> {
  return Object.fromEntries([...ruleBody(selector).matchAll(/([\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]))
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

describe('chat dark palette', () => {
  const tokens = declarations(SCOPE)
  const token = (name: string) => {
    const value = tokens[`--${name}`]
    if (!value?.match(/^#[0-9a-f]{6}$/i)) throw new Error(`--${name} is not a 6-digit hex color: ${value}`)
    return value
  }

  test('primary text sits between 7:1 and 10:1 on the chat background', () => {
    const ratio = contrast(token('text-primary'), token('bg-base'))
    expect(ratio).toBeGreaterThanOrEqual(7)
    expect(ratio).toBeLessThanOrEqual(10)
  })

  test('primary and secondary text reach 4.5:1 on every chat surface', () => {
    for (const surface of ['bg-base', 'bg-elevated', 'bg-surface']) {
      for (const text of ['text-primary', 'text-secondary']) {
        expect(contrast(token(text), token(surface))).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('error, link and Debug direction colors reach 4.5:1 on the chat background', () => {
    for (const name of ['chat-danger', 'chat-wire-out', 'chat-wire-in', 'chat-wire-stderr', 'accent']) {
      expect(contrast(token(name), token('bg-base'))).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('primary button labels reach 4.5:1 at rest and on hover', () => {
    for (const selector of [`${SCOPE} .btn-primary`, `${SCOPE} .btn-primary:hover`]) {
      expect(contrast('#ffffff', declarations(selector).background!)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('the light theme keeps its existing chat colors and is never scoped', () => {
    expect(declarations('[data-theme="light"]')).toMatchObject({
      '--chat-danger': '#f87171', '--chat-wire-out': '#38bdf8', '--chat-wire-in': '#34d399', '--chat-wire-stderr': '#fbbf24',
    })
    expect(css).not.toContain('[data-theme="light"] .chat-palette')
  })
})
