// A fake Codex app-server for the transport regressions: newline-delimited
// JSON-RPC on stdio, every inbound line appended to $FAKE_TRANSCRIPT. Methods:
//   initialize            -> { env, cwd, pid } (the child's actual environment and cwd)
//   echo {value}          -> value
//   delay {ms, value}     -> value after ms (out-of-order replies)
//   fail                  -> error { code: -32000, message: 'boom', data: { raw: true } }
//   never                 -> no reply
//   notify {count}        -> `count` notifications `tick {n}`, then { sent }
//   ask {method, params, id} -> a server request with that id; replies with the client's reply
//   garbage               -> malformed, stray, null-id and string-id lines naming
//                            the pending `never` request ids, then { ok }
//   late {ms}             -> replies twice, the first after ms
//   exit {code, stderr}   -> writes stderr and exits (pending requests stay unanswered)
//   helper {file}         -> starts helper.ts in this process group holding stdout; { helper }
//   ignoreTerm            -> ignores SIGTERM; { ok }
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const transcript = process.env.FAKE_TRANSCRIPT
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })
const asked = new Map<unknown, (message: Record<string, any>) => void>()
const seen: number[] = []

function handle(message: Record<string, any>) {
  const { id, method, params = {} } = message
  if (method === undefined) {
    asked.get(id)?.(message)
    return
  }
  if (typeof id === 'number') seen.push(id)
  switch (method) {
    case 'initialize':
      return reply(id, { env: process.env, cwd: process.cwd(), pid: process.pid, params })
    case 'echo':
      return reply(id, params.value)
    case 'delay':
      return void setTimeout(() => reply(id, params.value), params.ms)
    case 'fail':
      return send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'boom', data: { raw: true } } })
    case 'never':
      return
    case 'notify':
      for (let n = 0; n < params.count; n++) send({ jsonrpc: '2.0', method: 'tick', params: { n } })
      return reply(id, { sent: params.count })
    case 'ask':
      asked.set(params.id, (answer) => reply(id, answer))
      return send({ jsonrpc: '2.0', id: params.id, method: params.method, params: params.params })
    case 'garbage': {
      process.stdout.write('not json\n')
      process.stdout.write('[1,2]\n')
      for (const other of seen.filter((n) => n !== id)) {
        send({ jsonrpc: '2.0', id: String(other), result: 'string-id' })
        send({ jsonrpc: '2.0', id: other + 1000, result: 'unknown-id' })
        send({ jsonrpc: '2.0', id: other })
      }
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      send({ jsonrpc: '2.0', method: 42 })
      return reply(id, { ok: true })
    }
    case 'late':
      return void setTimeout(() => {
        reply(id, 'first')
        reply(id, 'second')
      }, params.ms)
    case 'exit':
      if (params.stderr) process.stderr.write(`${params.stderr}\n`)
      return void setTimeout(() => process.exit(params.code), 20)
    case 'helper': {
      const helper = spawn(process.execPath, [join(import.meta.dir, 'helper.ts'), params.file], { stdio: ['ignore', 'inherit', 'ignore'] })
      helper.unref()
      return reply(id, { helper: helper.pid })
    }
    case 'ignoreTerm':
      process.on('SIGTERM', () => {})
      return reply(id, { ok: true })
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown ${method}` } })
  }
}

let buffer = ''
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (transcript) appendFileSync(transcript, `${line}\n`)
    handle(JSON.parse(line))
    newline = buffer.indexOf('\n')
  }
})
process.stdout.on('error', () => {})
