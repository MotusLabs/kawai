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

export const WORKFLOW_ORACLES = {
  W01: "| W01 | Registered request/read on an execution task. Deliver task-bound mail for an unrelated task to the non-spawned Lead, observe the changed `taskId`, then bind and confirm through the real owner connection. | The card and review use the handoff's exact task and plan, with its diff and both plan pins. Task and plan reads agree on ids, base and published revision. Holder receives real direct notice, requester receives task-less wakeup, task draft stays untouched. Explicit ACK advances only after separate tool call. |",
  W02: "| W02 | A well-formed echoed handoff id or hash differs on the same base, the handoff is closed, stale, superseded, declined, withdrawn or published, or task content changes with an unchanged contract | Refuse as stale with Ø and inline reason. Stable review cannot silently reopen or use the replacement. |",
  W03: "| W03 | Move one scope/context fact after review including current approval, execution pin/ownership, attempt, change generation, or runtime Stop/Retry | Refuse with Ø even if the task base still matches. Binding with unrelated task focus and a manual task without competing execution are positive controls. |",
  W04: "| W04 | Insert an affected undecided draining or paused target after review preparation, then resolve it with Continue. Separately publish with shipped Adapt. | Both undecided and newly resolved histories refuse a fresh combined write. Adapt wins through its existing path and publishes no decision receipt. Unrelated change/execution pauses and ordinary holds permit eligible approval, with existing hold waits preserved. |",
  W05: "| W05 | Claimant forwarded/replaced before commit, or assignment unclaimed | Notice targets only the resolved successor. An unclaimed assignment gets no notice. The receipt keeps original ids when a new holder later takes over. Old result/message pins and new-holder ACK behavior stay intact. |",
  W06: "| W06 | Notice is delivered, dead-lettered or uncertain, then owner retries through existing operations | Original publication and receipt stand. Delivery, failure management, retry and ACK have existing effects and write no additional revision or combined decision. |",
  W07: "| W07 | Race same-key and different-key approvals with each other, with Answer, and with standalone prepared, linked-draft or ordinary human publication based on the same revision. Exercise both winner orders. | Only the serialized winner's effects exist. An exact combined retry replays. Competing publication can leave an open card with no receipt. Competing Answer can leave an open handoff. A task-only replay of a combined prepared revision carries no new effects. Later eligible ordinary publication from the new base is still possible. |",
  W08: "| W08 | Interrupt before binding or approval commit and boot. Separately lose the response after each commit and boot. Before retrying the ask, deliver unrelated task-bound mail that moves the Lead's task focus. | Before commit no partial rows or provisional mailbox/task/plan pushes. After commit the exact authorized ask returns the original card despite the focus change, and the exact approval returns its receipt. Neither replay adds rows. Startup reuses persisted notice/wakeup and does not synthesize an approval. |",
  W09: "| W09 | Exercise unbound Lead/owner ask, answer, answer replay, override, diagnosis and dispute. Try a bound Answer with approval-like text and a bound override after publication. | Ordinary mail, recorded decision, fix behavior and existing gates hold. Bound Answer makes no publication and cannot attach the requester to target work. Bound override leaves the historical receipt and revision intact. |",
  W10: "| W10 | Stale form, delayed review from another team/card, disconnect, and approval response lost in the Plans view | Complete review only for the selected card, no enabled confirmation without a ready review and connection, no automatic write. An exact retransmission has stable intent. Later plan detail can recover its receipt. |",
} as const

export function oracleOutput(line: string): string {
  return line.slice(2, -2).split(' | ').at(-1)!
}
