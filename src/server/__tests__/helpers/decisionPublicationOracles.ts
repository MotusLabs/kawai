// The bound design's decision tables. Keep the literal rows when expanding the fixtures.
export const BINDING_ORACLES = {
  B00: "| B00 | ordinary | * | * | existing ask result, routing and mail |",
  B01: "| B01 | invalid | * | * | invalid, Ø and no ordinary fallback |",
  B02: "| B02 | not found | * | * | not found, Ø, identical for missing and foreign resolved records |",
  B03: "| B03 | forbidden | * | * | forbidden, Ø, including a same-team task without persisted plan/change scope, a borrowed handoff, a mismatched nonblank `plan_id` without lookup of the supplied plan, and missing, unreadable or ineligible current owner routing |",
  B04: "| B04 | allowed | exact | * | original card and link, replayed, Ø, including after delivery changes task focus |",
  B05: "| B05 | allowed | different | * | replay mismatch naming the differing field, Ø |",
  B06: "| B06 | allowed | absent | unavailable | fresh D2 base, context or handoff reason after current authorization, Ø |",
  B07: "| B07 | allowed | absent | ready | one owner card and link for the persisted handoff target, zero mail, publications or notices |",
} as const

export const APPROVAL_ORACLES = {
  A01: "| A01 | invalid | * | * | * | * | invalid, including malformed echoes, Ø |",
  A02: "| A02 | forbidden | * | * | * | * | forbidden, Ø |",
  A03: "| A03 | not found | * | * | * | * | not found, Ø, no receipt disclosure |",
  A04: "| A04 | allowed | different | * | * | * | replay mismatch naming the differing action or field, Ø |",
  A05: "| A05 | allowed | inconsistent | * | * | * | state, inconsistent receipt evidence, Ø |",
  A06: "| A06 | allowed | exact | settled | * | * | original decision and receipt, replayed, Ø |",
  A07: "| A07 | allowed | unused | plain | * | * | state, missing publication binding, Ø |",
  A08: "| A08 | allowed | unused | settled | * | * | state, already decided, Ø |",
  A09: "| A09 | allowed | unused | open | stale | * | stale reason for a well-formed mismatched echo or moved binding facts, Ø |",
  A10: "| A10 | allowed | unused | open | current | refused | state, write failure, Ø and key unused; retry guidance for transient failure |",
  A11: "| A11 | allowed | unused | open | current | successful | one human decision and receipt, one exact prepared revision, fulfillment and existing notices/wakeup |",
} as const

export function oracleOutput(line: string): string {
  return line.slice(2, -2).split(' | ').at(-1)!
}
