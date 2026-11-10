// Linear newline splitter for process streams (extracted from Kawai's
// src/server/chat/wireTap.ts; Kawai switches to this copy in task 6).

import { StringDecoder } from 'node:string_decoder'

export interface LineSplitter {
  write(chunk: Buffer | string): void
  /** Flush a trailing line that had no terminating newline. */
  end(): void
}

/**
 * Split a byte stream into lines on `\n`. Multi-byte UTF-8 characters split
 * across chunks are reassembled; line content (including any `\r`) is kept
 * verbatim so a recorded line is exactly what was exchanged.
 *
 * Linear in the stream's size: each chunk is scanned once, and the pieces of
 * an unfinished line are held apart and joined only when its newline
 * arrives (re-scanning one growing buffer was quadratic on huge lines).
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  const decoder = new StringDecoder('utf8')
  let pending: string[] = []
  const drain = (text: string) => {
    let start = 0
    let newline = text.indexOf('\n')
    while (newline !== -1) {
      const tail = text.slice(start, newline)
      if (pending.length === 0) {
        onLine(tail)
      } else {
        pending.push(tail)
        const line = pending.join('')
        pending = []
        onLine(line)
      }
      start = newline + 1
      newline = text.indexOf('\n', start)
    }
    if (start < text.length) pending.push(text.slice(start))
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
      if (pending.length > 0) onLine(pending.join(''))
      pending = []
    },
  }
}
