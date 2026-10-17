// Live Claude Code contract probes (docs/claude-cli-contract.md): run by hand
// whenever the CLI floor rises, never in CI (they spend a real model turn).
// Writes masked frames as JSONL: identity and ordering fields only, prompt
// uuids as labels (A, B, C) — no content, ids, paths, or account data.
// usage: bun probe.ts <prompt|task|cancel> <claude executable> <out.jsonl>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const [scenario = 'prompt', executable, out] = process.argv.slice(2)
if (!executable || !out) throw new Error('usage: probe.ts <scenario> <claude> <out.jsonl>')
const rows: Record<string, unknown>[] = []
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cli-probe-'))
const ids: Record<string, string> = {}
const label = (u?: unknown) => typeof u === 'string' ? Object.entries(ids).find(([, v]) => v === u)?.[0] ?? 'unknown' : undefined
const pending: SDKUserMessage[] = []
let wake: (() => void) | null = null
const push = (name: string, text: string) => {
  ids[name] = crypto.randomUUID()
  rows.push({ action: 'send', prompt: name })
  pending.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: ids[name] } as unknown as SDKUserMessage)
  wake?.(); wake = null
}
async function* prompts() {
  while (true) {
    if (!pending.length) await new Promise<void>(r => { wake = r })
    yield pending.shift()!
  }
}
const q = query({
  prompt: prompts(),
  options: {
    cwd, model: 'haiku', pathToClaudeCodeExecutable: executable,
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [],
  } as never,
})
const interrupt = (cancelQueued: boolean) => {
  rows.push({ action: 'interrupt', cancelQueued })
  void (q.interrupt as unknown as (o?: object) => Promise<any>).call(q, cancelQueued ? { cancelQueued: true } : undefined).then(receipt => {
    rows.push({ action: 'receipt', still_queued: receipt?.still_queued?.map(label), cancelled: receipt?.cancelled?.map(label) })
  })
}
const LONG = 'Write the numbers from 1 to 400, one per line, with no other text.'
const OK = 'Reply with the single word OK.'
if (scenario === 'task') push('A', 'Use the Bash tool with run_in_background=true to run: sleep 4 && echo done. Then reply with the single word STARTED and end your turn. When the background task finishes, write the numbers 1 to 400 one per line.')
else push('A', LONG)
let phase = 0
const done = (ms = 4000) => setTimeout(() => { fs.writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); process.exit(0) }, ms)
const timer = setTimeout(() => { rows.push({ action: 'timeout' }); done(0) }, 120_000)
for await (const m of q as AsyncIterable<any>) {
  if (m.type === 'stream_event') continue
  if (m.type === 'system' && !['init', 'task_notification', 'task_started'].includes(m.subtype)) continue
  const row: Record<string, unknown> = { type: m.type }
  if (m.subtype) row.subtype = m.subtype
  if (m.type === 'system' && m.subtype === 'init') row.capabilities = (m.capabilities ?? []).filter((c: string) => /interrupt/.test(c))
  if (m.type === 'result') Object.assign(row, {
    is_error: m.is_error, terminal_reason: m.terminal_reason, result_index: m.result_index, queued_turn_count: m.queued_turn_count,
    user_message_uuid: label(m.user_message_uuid), user_message_uuids: m.user_message_uuids?.map(label),
  })
  if (m.type === 'command_lifecycle') Object.assign(row, { command_uuid: label(m.command_uuid), state: m.state })
  if (m.type === 'assistant') Object.assign(row, { content: m.message?.content?.map((b: any) => b.type), user_message_uuid: label(m.user_message_uuid) })
  if (m.type === 'user') {
    const c = m.message?.content
    Object.assign(row, { content: typeof c === 'string' ? (c.startsWith('[Request interrupted') ? c : 'text') : c?.map((b: any) => b.type === 'text' && b.text.startsWith('[Request interrupted') ? b.text : b.type), isReplay: m.isReplay ?? false, uuid: label(m.uuid) })
  }
  rows.push(row)
  if (scenario === 'prompt' && phase === 0 && m.type === 'assistant') { phase = 1; interrupt(true); push('B', OK) }
  if (scenario === 'cancel' && phase === 0 && m.type === 'assistant') { phase = 1; push('B', OK); setTimeout(() => interrupt(true), 300) }
  if (scenario === 'cancel' && phase === 1 && m.type === 'result') { phase = 2; push('C', OK) }
  if (scenario === 'task') {
    if (phase === 0 && m.type === 'result') phase = 1
    else if (phase === 1 && m.type === 'system' && m.subtype === 'init') { phase = 2; interrupt(true); push('B', OK) }
  }
  const last = scenario === 'cancel' ? 'C' : 'B'
  if (m.type === 'result' && label(m.user_message_uuid) === last) { clearTimeout(timer); done() }
}
