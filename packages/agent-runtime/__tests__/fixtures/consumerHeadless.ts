// Copied into a packed consumer; only this relative example import relocates.
import { readFileSync, writeFileSync } from 'node:fs'
import { AgentRuntimeError, type LaunchConfiguration, type ResumeCheckpoint } from '@motuslabs/agent-runtime'
import { runHeadless, type HeadlessProvider } from '../../examples/headless.js'

const config = JSON.parse(process.argv[2]!) as { claude: LaunchConfiguration; codex: LaunchConfiguration; store: string; mode: string }
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const providers: HeadlessProvider[] = [
  { runtime: 'claude', options: { launch: config.claude, logger, permissions: { mode: 'default', enabledTools: ['Bash', 'AskUserQuestion'], disallowedTools: [] } } },
  { runtime: 'codex', options: { launch: config.codex, logger, permissions: { approvalPolicy: 'on-request', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'enabled', elicitation: 'enabled' } } },
]
const primary = new Error('primary output failed')
const observer = new Error('observer output failed')
const prints: object[] = []
const raw = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(raw) : error instanceof AgentRuntimeError && error.causes.length ? error.causes.flatMap(raw) : [error]
const load = () => JSON.parse(readFileSync(config.store, 'utf8')) as Record<string, ResumeCheckpoint>
const question = { questions: [{ question: 'Colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Red' }] }] }
try {
  const result = await runHeadless(providers, {
    load: (runtime) => load()[runtime],
    save: async (checkpoint) => { writeFileSync(config.store, JSON.stringify({ ...load(), [checkpoint.runtime]: checkpoint })) },
    answers: { 'Colour?': 'Blue' },
    prompts: {
      claude: { turns: [`ask Bash {"command":"PRIVATE-INPUT"}`, `ask AskUserQuestion ${JSON.stringify(question)}`, 'script {"frames":[],"usage":null}'], interrupt: 'hang', resume: 'history' },
      codex: { turns: ['/facts', '/ask item/commandExecution/requestApproval {}', '/ask item/tool/requestUserInput {"questions":[{"id":"colour","question":"Colour?","header":"Colour","options":[{"label":"Blue"},{"label":"Red"}]}]}'], interrupt: '/hold', resume: 'after-resume' },
    },
    print(facts) {
      const emit = () => {
        if (config.mode === 'print-failure' || config.mode === 'async-print-failure') {
          if ('interrupt' in facts) throw primary
          if ('outcome' in facts) throw observer
        }
        prints.push(facts)
      }
      return config.mode === 'async-print-failure' ? Promise.resolve().then(emit) : emit()
    },
  })
  console.log(JSON.stringify({ turns: result.turns, stops: result.stops, prints, saved: load() }))
} catch (error) {
  const causes = raw(error)
  // Filtering an expected failure is permitted only after this exact raw
  // identity/order/count assertion. Every other failure stays a failed child.
  // Three completed prompts and the interrupted turn each throw the same
  // observer object once. Every throw is retained, rather than deduplicated.
  if (!['print-failure', 'async-print-failure'].includes(config.mode) || causes.length !== 5 || causes[0] !== primary || causes.slice(1).some((cause) => cause !== observer)) throw error
  console.log(JSON.stringify({ expected: ['primary', 'observer', 'observer', 'observer', 'observer'], prints, saved: load() }))
}
