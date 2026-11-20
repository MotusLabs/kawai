// Opt-in native image receipt/replay through the current public runtime package.
// KAWAI_IMAGE_SMOKE=1 bun tests/fixtures/chatImageRuntimeSmoke.ts claude|codex
import { createClaudeDriver } from '@motuslabs/agent-runtime/claude'
import { createCodexDriver } from '@motuslabs/agent-runtime/codex'
import type { ResumeCheckpoint } from '@motuslabs/agent-runtime'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { CHAT_IMAGE_RED_BASE64 } from './chatImage'
if (process.env.KAWAI_IMAGE_SMOKE !== '1') throw Error('Set KAWAI_IMAGE_SMOKE=1 to contact the model provider')
const runtime = process.argv[2]
if (runtime !== 'claude' && runtime !== 'codex') throw Error('Choose claude or codex')
const root = await mkdtemp('/tmp/kawai-image-smoke-')
for (const dir of ['project', 'cache', 'tmp']) await mkdir(`${root}/${dir}`)
const png = Buffer.from(CHAT_IMAGE_RED_BASE64, 'base64')
const digest = createHash('sha256').update(png).digest('hex')
await writeFile(root + '/red.png', png)
const summary = (value: unknown) => JSON.parse(JSON.stringify(value, (key, data) => {
  if (key === 'data' && typeof data === 'string') return { bytes: Buffer.from(data, 'base64').length, sha256: createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex') }
  if (typeof data === 'string' && data.startsWith('data:image/')) {
    const bytes = Buffer.from(data.split(',')[1] ?? '', 'base64')
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  return typeof data === 'string' ? data.replaceAll(root, '<smoke>') : data
}))
for (const mode of ['mixed', 'image-only']) {
  let checkpoint: ResumeCheckpoint | null = null
  const common = {
    launch: { cwd: root + '/project', homeDir: process.env.HOME!, cacheDir: root + '/cache', tempDir: root + '/tmp', childEnv: { ...process.env } as Record<string, string>, executablePath: Bun.which(runtime)! },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    callbacks: { onEvent() {}, onCheckpoint(value: ResumeCheckpoint) { checkpoint = value } },
  }
  const driver = runtime === 'claude'
    ? createClaudeDriver({ ...common, permissions: { mode: 'default', enabledTools: [], disallowedTools: [] } })
    : createCodexDriver({ ...common, permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: false, writableRoots: [], userInput: 'enabled', elicitation: 'enabled' } })
  try {
    await driver.start()
    const result = await (await driver.send(mode === 'mixed' ? 'Name this image color in one word. Do not use tools.' : '', {
      images: runtime === 'claude' ? [{ type: 'base64', mediaType: 'image/png', data: CHAT_IMAGE_RED_BASE64 }] : [{ type: 'localImage', path: root + '/red.png' }],
    })).result
    if (result.outcome !== 'success') throw Error(`Native ${runtime} image turn failed: ${result.error?.message}`)
    const saved = checkpoint as ResumeCheckpoint | null
    if (!saved) throw Error('No native checkpoint')
    const transcriptPath = runtime === 'claude'
      ? `${process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME + '/.claude'}/projects/${(root + '/project').replace(/[^a-zA-Z0-9]/g, '-')}/${saved.runtimeSessionId}.jsonl`
      : saved.transcriptPath!
    const rows = (await readFile(transcriptPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(row => runtime === 'claude' ? row.type === 'user' && row.message?.content?.some((b: { type: string }) => b.type === 'image')
        : row.type === 'response_item' && row.payload?.role === 'user' && row.payload.content?.some((b: { type: string }) => b.type === 'input_image'))
      .map(row => summary(runtime === 'claude' ? row.message : row.payload))
    if (rows.length !== 1 || !JSON.stringify(rows).includes(digest)) throw Error('Native image identity was lost')
    console.log(JSON.stringify({ runtime, mode, outcome: result.outcome, rows }))
  } finally { await driver.shutdown() }
}
