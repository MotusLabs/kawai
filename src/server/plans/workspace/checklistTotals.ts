// The §2 checklist projection's totals, remembered for the workspace's
// runtime rows (plan-workspace 3.1, design N3). The checklist composition
// reads files and is async, while the runtime projection composes
// synchronously from already-held facts (INVARIANT P) — so every composed
// checklist leaves its {total, checked} here, and the workspace snapshot
// reads the last composed value without touching a file. A change with no
// composed checklist (never subscribed, or unavailable) reads null: a
// missing fact, never a fabricated zero.
//
// The cache is advisory memory beside the subscriptions: a restart empties
// it until each open checklist composes again, and an unsubscribe keeps the
// last totals (stale facts are re-derived on the next open, which composes
// before it answers). Checklist and document refreshes never push the
// workspace projection (CP1): the next source event composes whatever the
// new totals made different, and the diff keeps an unchanged view quiet.
import type { WorkspaceChecklist } from '../../../shared/planWorkspace'

export interface ChecklistTotals {
  total: number
  checked: number
}

export class PlanChecklistTotals {
  private readonly totals = new Map<string, ChecklistTotals>()

  private static key(teamId: string, planId: string, changeName: string): string {
    return `${teamId}\0${planId}\0${changeName}`
  }

  /** Remember one composed checklist's totals; null (unavailable) drops the entry. */
  record(teamId: string, planId: string, changeName: string, checklist: WorkspaceChecklist | null): void {
    const key = PlanChecklistTotals.key(teamId, planId, changeName)
    if (checklist === null) {
      this.totals.delete(key)
      return
    }
    let total = 0
    let checked = 0
    for (const section of checklist.sections) {
      for (const item of section.items) {
        total += 1
        if (item.checked) checked += 1
      }
    }
    this.totals.set(key, { total, checked })
  }

  /** The last composed totals, or null when this change's checklist never composed (or is unavailable). */
  of(teamId: string, planId: string, changeName: string): ChecklistTotals | null {
    return this.totals.get(PlanChecklistTotals.key(teamId, planId, changeName)) ?? null
  }
}
