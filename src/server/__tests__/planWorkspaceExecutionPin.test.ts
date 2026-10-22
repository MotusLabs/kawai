// The executionMatch oracle's decision table (B1+O1, the fix brief E1–E8):
// one row per case. The manifest hashes git show's UTF-8-decoded stdout cut
// at GIT_MAX_OUTPUT_BYTES; the reader hashes raw bytes, so only a BOM-free,
// fatally valid, within-bound markdown compares. Mutants each row kills:
// E3 drops the kind check, E4 the size check, E5 the BOM check (E6 covers
// the fatal decode); E9, the plan-wide-attempt mutant, is a connection-level
// test in planWorkspaceDocuments.test.ts. E9's worktree scoping is also
// exercised there, against a real ExecutionStore.
import { describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import type { WorkspaceExecutionMatch } from '../../shared/planWorkspace'
import { GIT_MAX_OUTPUT_BYTES } from '../git/gitCommand'
import { executionMatchFor, type CurrentDocument, type ExecutionPin } from '../plans/workspace/executionPin'

describe('the executionMatch oracle (table E1–E8)', () => {
  const PATH = 'notes/design.md'
  const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)
  const hashOf = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex')
  const pinAt = (hash: string, executionId = 'exec-e'): ExecutionPin => ({ executionId, artifacts: { [PATH]: hash } })
  const markdown = (text: string): CurrentDocument => {
    const bytes = bytesOf(text)
    return { kind: 'markdown', hash: hashOf(bytes), size: bytes.length, bytes }
  }
  const unchanged = hashOf(bytesOf('alpha content\n'))

  const rows: Array<{ id: string; pin: ExecutionPin | null; current: CurrentDocument | null; match: WorkspaceExecutionMatch; executionId: string | null }> = [
    { id: 'E1: no pin reads unknown and names no execution', pin: null, current: markdown('alpha content\n'), match: 'unknown', executionId: null },
    { id: 'E2: a path absent from the pin map reads unknown, naming the execution', pin: { executionId: 'exec-2', artifacts: { 'other/file.md': unchanged } }, current: markdown('alpha content\n'), match: 'unknown', executionId: 'exec-2' },
    // An image is never comparable, whatever its bytes decode to: the
    // manifest has no identity for it. The bytes are valid BOM-free UTF-8 so
    // this row isolates the kind check.
    { id: 'E3: an image reads unknown even when its bytes are unchanged', pin: pinAt(unchanged), current: { kind: 'image', hash: unchanged, size: bytesOf('alpha content\n').length, bytes: bytesOf('alpha content\n') }, match: 'unknown', executionId: 'exec-e' },
    { id: 'E4: markdown one byte past the git output bound reads unknown', pin: pinAt(hashOf(bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES + 1)))), current: { kind: 'markdown', hash: hashOf(bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES + 1))), size: GIT_MAX_OUTPUT_BYTES + 1, bytes: bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES + 1)) }, match: 'unknown', executionId: 'exec-e' },
    { id: 'E5: markdown starting with a UTF-8 BOM reads unknown', pin: pinAt(hashOf(bytesOf('﻿alpha content\n'))), current: markdown('﻿alpha content\n'), match: 'unknown', executionId: 'exec-e' },
    { id: 'E6: invalid UTF-8 reads unknown', pin: pinAt(hashOf(Uint8Array.from([0xff, 0xfe, 0x61]))), current: { kind: 'markdown', hash: hashOf(Uint8Array.from([0xff, 0xfe, 0x61])), size: 3, bytes: Uint8Array.from([0xff, 0xfe, 0x61]) }, match: 'unknown', executionId: 'exec-e' },
    { id: 'E7: comparable and equal reads match', pin: pinAt(unchanged), current: markdown('alpha content\n'), match: 'match', executionId: 'exec-e' },
    { id: 'E7: the largest comparable size (exactly the bound) reads match', pin: pinAt(hashOf(bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES)))), current: { kind: 'markdown', hash: hashOf(bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES))), size: GIT_MAX_OUTPUT_BYTES, bytes: bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES)) }, match: 'match', executionId: 'exec-e' },
    { id: 'E8: comparable and different reads mismatch', pin: pinAt(hashOf(bytesOf('other\n'))), current: markdown('alpha content\n'), match: 'mismatch', executionId: 'exec-e' },
    { id: 'no current content never compares, naming the pin when one exists', pin: pinAt(unchanged), current: null, match: 'unknown', executionId: 'exec-e' },
  ]

  test.each(rows)('$id', ({ pin, current, match, executionId }) => {
    expect(executionMatchFor(pin, PATH, current)).toEqual({ match, executionId })
  })
})
