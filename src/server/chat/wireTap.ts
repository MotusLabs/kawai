// Wire tap for chat sessions' Claude Code processes. Passed to the SDK as
// `spawnClaudeCodeProcess`, it spawns the CLI exactly as asked and records
// every newline-delimited line crossing the process boundary (stdin = `out`,
// stdout = `in`, stderr) plus spawn/exit/error lifecycle frames. The bytes
// the SDK and the CLI exchange are forwarded unchanged; the spawn environment
// (which can carry API keys and OAuth tokens) is never recorded.
import { spawn as nodeSpawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { Transform, Writable } from 'node:stream'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { ChatWireDirection } from '../../shared/chat'

/** Sink for captured frames; sequence and timestamp are assigned by the log. */
export interface ChatWireRecorder {
  record(dir: ChatWireDirection, raw: string): void
}

export interface LineSplitter {
  write(chunk: Buffer | string): void
  /** Flush a trailing line that had no terminating newline. */
  end(): void
}

/**
 * Split a byte stream into lines on `\n`. Multi-byte UTF-8 characters split
 * across chunks are reassembled; line content (including any `\r`) is kept
 * verbatim so a recorded line is exactly what was exchanged.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  const drain = (text: string) => {
    buffered += text
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      onLine(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
  let ended = false
  return {
    write(chunk) {
      if (ended) return
      drain(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    },
    end() {
      if (ended) return
      ended = true
      drain(decoder.end())
      if (buffered) onLine(buffered)
      buffered = ''
    },
  }
}

type SpawnImpl = typeof nodeSpawn

/** Build a `spawnClaudeCodeProcess` that records traffic into `recorder`. */
export function createWireTappedSpawn(
  recorder: ChatWireRecorder,
  spawnImpl: SpawnImpl = nodeSpawn
): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const lifecycle = (event: Record<string, unknown>) =>
      recorder.record('lifecycle', JSON.stringify(event))
    lifecycle({
      event: 'spawn',
      command: options.command,
      args: options.args,
      cwd: options.cwd ?? null,
    })
    const child = spawnImpl(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', (error) => lifecycle({ event: 'error', message: error.message }))
    child.on('exit', (code, signal) => lifecycle({ event: 'exit', code, signal }))

    const outLines = createLineSplitter((line) => recorder.record('out', line))
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        outLines.write(chunk)
        child.stdin.write(chunk, (error) => callback(error ?? null))
      },
      final(callback) {
        outLines.end()
        child.stdin.end()
        callback()
      },
      destroy(error, callback) {
        outLines.end()
        if (!child.stdin.destroyed) child.stdin.destroy(error ?? undefined)
        callback(error)
      },
    })
    child.stdin.on('error', (error) => stdin.destroy(error))

    const inLines = createLineSplitter((line) => recorder.record('in', line))
    const stdout = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        inLines.write(chunk)
        callback(null, chunk)
      },
      flush(callback) {
        inLines.end()
        callback()
      },
    })
    child.stdout.on('error', (error) => stdout.destroy(error))
    child.stdout.pipe(stdout)

    // With a custom spawner the SDK does not read stderr; drain it here so a
    // chatty process can never block on a full pipe.
    const errLines = createLineSplitter((line) => recorder.record('stderr', line))
    child.stderr.on('data', (chunk: Buffer) => errLines.write(chunk))
    child.stderr.on('end', () => errLines.end())
    child.stderr.on('error', () => errLines.end())

    return {
      stdin,
      stdout,
      get killed() {
        return child.killed
      },
      get exitCode() {
        return child.exitCode
      },
      get signalCode() {
        return child.signalCode
      },
      kill: (signal) => child.kill(signal),
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child),
    }
  }
}
