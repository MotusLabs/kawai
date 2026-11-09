// @reads: packages/agent-runtime/README.md, packages/agent-runtime/examples/**, packages/agent-runtime/__tests__/fixtures/**
// The README's inline request example (task 4.3 Claude portion, V2): the
// README block is byte-for-byte examples/inline-requests.ts, which the
// package typecheck compiles, and this test runs that file unchanged through
// the real SDK, the owned spawner and the fake CLI. The fake asks the SDK's
// can_use_tool after the deny-only policy hook, so the answers below reach
// the actual SDK boundary. Safe sample data only; no credentials.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClaudeAgentDriver } from '../src/contract.js'
import { headlessClaude } from '../examples/inline-requests.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const PACKAGE_DIR = join(import.meta.dir, '..')
const QUESTION = { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] }
const OTHER = { questions: [{ question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'S' }] }] }

let driver: ClaudeAgentDriver | null = null
afterEach(async () => {
  await driver?.shutdown()
  driver = null
})

function readmeBlock(file: string): string {
  const readme = readFileSync(join(PACKAGE_DIR, 'README.md'), 'utf8')
  const marker = `<!-- example: ${file} -->\n\`\`\`ts\n`
  const start = readme.indexOf(marker)
  if (start < 0) throw new Error(`README has no block for ${file}`)
  const body = start + marker.length
  return readme.slice(body, readme.indexOf('\n```\n', body) + 1)
}

describe('README: answering requests inline', () => {
  test('the README block is exactly examples/inline-requests.ts', () => {
    expect(readmeBlock('examples/inline-requests.ts')).toBe(readFileSync(join(PACKAGE_DIR, 'examples/inline-requests.ts'), 'utf8'))
  })

  // @covers: agent-runtime › Requests can be answered immediately › Inline response
  test('the example answers each request inside onRequest through the real SDK and the fake CLI', async () => {
    const home = fakeClaudeHome()
    const warnings: unknown[] = []
    const logger = { debug: () => {}, info: () => {}, error: () => {}, warn: (obj: object) => void warnings.push(obj) }
    driver = headlessClaude(home.launch(), logger, { 'Which colour?': 'Blue' })
    await driver.start()
    const say = async (text: string) => (await (await driver!.send(text)).result).finalText
    expect(await say(`ask Read ${JSON.stringify({ file_path: '/tmp/notes.txt' })}`)).toBe(`allowed Read ${JSON.stringify({ file_path: '/tmp/notes.txt' })}`)
    expect(await say(`ask Bash ${JSON.stringify({ command: 'ls' })}`)).toBe('denied Bash (The tool use was denied)')
    expect(await say(`ask AskUserQuestion ${JSON.stringify(QUESTION)}`)).toBe(`allowed AskUserQuestion ${JSON.stringify({ ...QUESTION, answers: { 'Which colour?': 'Blue' }, response: 'Blue' })}`)
    // No prepared answer: the driver refuses the empty answer and the default denial applies.
    expect(await say(`ask AskUserQuestion ${JSON.stringify(OTHER)}`)).toBe('denied AskUserQuestion (No answer was given; the request is denied)')
    expect(warnings).toEqual([{ reason: 'invalid' }])
    // The policy hook decides first: an unlisted tool never reaches onRequest.
    expect(await say(`ask Write ${JSON.stringify({ file_path: '/tmp/x' })}`)).toMatch(/^denied Write \(/)
    expect(driver.pendingRequests()).toEqual([])
  })
})
