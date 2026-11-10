// One host process for the Codex cross-host recovery test: it builds the
// public driver over the shared retained Codex home given in argv, starts it
// (fresh or resuming the supplied thread), sends one message, then ends with
// an awaited kill or shutdown, and prints one JSON line with the checkpoint,
// the turn's text and the stop receipt. Nothing is shared with the test
// process except the home directory.
//   argv: <root> <home> <wrapper> <fresh|threadId> <kill|shutdown> <text>
import { createCodexDriver } from '../../src/codex/index.js'
import type { ResumeCheckpoint } from '../../src/contract.js'
import { join } from 'node:path'

const [root, home, wrapper, resume, stop, text] = process.argv.slice(2) as [string, string, string, string, 'kill' | 'shutdown', string]
const checkpoints: ResumeCheckpoint[] = []
const quiet = () => {}
const driver = createCodexDriver({
  logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
  launch: { cwd: join(root, 'work'), childEnv: { CODEX_HOME: home }, executablePath: wrapper, homeDir: home, cacheDir: join(root, 'cache'), tempDir: join(root, 'tmp') },
  permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' },
  callbacks: { onEvent: quiet, onCheckpoint: (checkpoint) => void checkpoints.push(checkpoint) },
  ...(resume === 'fresh' ? {} : { resume: { runtime: 'codex' as const, runtimeSessionId: resume } }),
})
await driver.start()
const result = await (await driver.send(text)).result
const receipt = await driver[stop]()
process.stdout.write(`${JSON.stringify({ pid: process.pid, checkpoints, finalText: result.finalText, receipt })}\n`)
