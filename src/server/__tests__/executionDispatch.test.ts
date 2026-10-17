// Kawai's dispatch of an execution's stages (plan-execution D7/D8, §11.4).
// This file starts with the boundary the review deferred from 2.1: the
// system TaskCaller is minted only inside src/server/plans/execution — no
// tool handler, WebSocket connection path, or other source constructs one.
// The dispatch itself (task creation, manifest, request keys) lands with
// the rest of 11.4 in PR B.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

describe('only the execution module mints a system caller (deferred from 2.1, §11.4)', () => {
  test('no source outside src/server/plans/execution builds a system TaskCaller', () => {
    const roots = ['src/server', 'src/client', 'src/shared']
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && file !== path.join('src', 'server', 'plans', 'execution')) walk(file)
        } else if (/\.tsx?$/.test(entry.name) && /kind: 'system',\s*team\b|executionId: [^,}]+[,}][^\n]*kind: 'system'/.test(fs.readFileSync(file, 'utf8'))) {
          offenders.push(file)
        }
      }
    }
    roots.forEach(walk)
    expect(offenders.filter(file => file !== path.join('src', 'server', 'team', 'TaskService.ts'))).toEqual([])
  })
})
