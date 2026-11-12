// Seeded contract generators (implementation-contract design, "Properties"):
// one PRNG and one valid-contract generator, shared by P1–P3 here and P4 in
// the server's revision-isolation test. Seed 0x1C0A7AC7, 500 cases.
import type { ImplementationContract } from '../implementationContract'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const SEED = 0x1c0a7ac7
export const CASES = 500
const WORDS = ['tasks', 'never', 'the', 'result', 'is', 'pinned', 'to', 'revision', 'twice', 'scope', 'a', 'büro', 'ok']

export function generate(rand: () => number): ImplementationContract {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]
  const text = () => Array.from({ length: 1 + Math.floor(rand() * 8) }, () => pick(WORDS)).join(rand() < 0.1 ? '  ' : ' ')
  const clauses = (letter: string, min: number) =>
    Array.from({ length: min + Math.floor(rand() * 4) }, (_, k) => ({ id: `${letter}${k + 1 + (rand() < 0.2 ? 10 : 0)}`, text: text() }))
      .filter((clause, index, all) => all.findIndex(other => other.id === clause.id) === index)
  const segments = ['src', 'server', 'team', '**', '*.ts', 'docs', 'a?c']
  return {
    version: 1,
    acceptance: clauses('A', 1),
    invariants: clauses('I', 0),
    scope: [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(segments)).join('/')))],
    verification: clauses('V', 1),
    excluded: clauses('X', 0),
  }
}
