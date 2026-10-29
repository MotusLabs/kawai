// Chunked line reading for JSONL histories (bounded-history-capture D2): the
// file is read 1 MiB at a time and handed out one line at a time, so no
// whole-file string or line array is ever held, and the event loop gets a
// turn at every read. The lines are exactly the pieces `content.split('\n')`
// gives for the decoded file — a trailing `\r` kept, the empty piece after a
// final newline included — and their indexes match, so a parser fed from
// here behaves exactly as one fed from a string. Splitting on the 0x0a byte
// before decoding is safe: in UTF-8 that byte never occurs inside a
// multibyte character.
import fsp from 'node:fs/promises'

export const LINE_CHUNK_BYTES = 1 << 20
const NEWLINE = 0x0a

/**
 * Hand every line of an open file to `onLine` as bytes, with its byte offset
 * and its index. The buffer is only valid during the call.
 */
export async function scanLines(
  handle: fsp.FileHandle,
  onLine: (line: Buffer, start: number, index: number) => void,
  chunkBytes = LINE_CHUNK_BYTES,
): Promise<void> {
  const chunk = Buffer.allocUnsafe(chunkBytes)
  // The partial line, kept as copied pieces and joined once its newline
  // arrives, so a line many chunks long costs one copy, not one per read.
  let pieces: Buffer[] = []
  let lineOffset = 0
  let position = 0
  let index = 0
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunkBytes, position)
    if (bytesRead === 0) break
    const data = chunk.subarray(0, bytesRead)
    let lineStart = 0
    for (let nl = data.indexOf(NEWLINE); nl !== -1; nl = data.indexOf(NEWLINE, lineStart)) {
      const tail = data.subarray(lineStart, nl)
      const line = pieces.length > 0 ? Buffer.concat([...pieces, tail]) : tail
      onLine(line, lineOffset, index++)
      pieces = []
      lineOffset = position + nl + 1
      lineStart = nl + 1
    }
    // Copy the rest: `chunk` is reused by the next read.
    if (lineStart < bytesRead) pieces.push(Buffer.from(data.subarray(lineStart)))
    position += bytesRead
  }
  onLine(Buffer.concat(pieces), lineOffset, index)
}

/**
 * Hand every line of `filePath` to `onLine` decoded as UTF-8, with its
 * index. Open and read errors reject, carrying their `code`.
 */
export async function readLines(
  filePath: string,
  onLine: (line: string, index: number) => void,
  chunkBytes = LINE_CHUNK_BYTES,
): Promise<void> {
  const handle = await fsp.open(filePath, 'r')
  try {
    await scanLines(handle, (line, _start, index) => onLine(line.toString('utf8'), index), chunkBytes)
  } finally {
    await handle.close().catch(() => {})
  }
}
