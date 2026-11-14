// Process-local recovery verification; a failed write masks even unchanged stored bytes.
import type { ObservationStore } from './store'
export type RecoveryStatus = {
  status: 'unknown' | 'ok' | 'pending' | 'quarantined'
  quarantinedCount: number | null
  pendingCount: number | null
  checkedAt: string | null
}
const unknown = (): RecoveryStatus => ({ status:'unknown',quarantinedCount:null,pendingCount:null,checkedAt:null })
export class ToolRecoveryHealth {
  private gate: 'unverified' | 'verified' | 'failed' = 'unverified'
  constructor(private readonly store: ObservationStore) {}
  write(ready: boolean, quarantinedCount: number, pendingCount: number): boolean | undefined {
    if (!ready) { this.gate='failed'; return }
    try {
      const value={version:1,quarantinedCount,pendingCount,
        status: quarantinedCount ? 'quarantined' : pendingCount ? 'pending' : 'ok',
        checkedAt:new Date(this.store.now()).toISOString()}
      this.store.db.transaction(() => this.store.setCheckpoint('tool-recovery-quarantine',JSON.stringify(value)))()
      this.gate='verified'
      return true
    } catch { this.gate='failed'; return false }
  }
  read(): RecoveryStatus {
    if (this.gate !== 'verified') return unknown()
    try {
      const v=JSON.parse(this.store.checkpoint('tool-recovery-quarantine') ?? 'null')
      if (!v || v.version!==1 || !['ok','pending','quarantined'].includes(v.status) ||
        !Number.isSafeInteger(v.quarantinedCount) || v.quarantinedCount<0 ||
        !Number.isSafeInteger(v.pendingCount) || v.pendingCount<0 ||
        typeof v.checkedAt!=='string' || !Number.isFinite(Date.parse(v.checkedAt))) return unknown()
      return {status:v.status,quarantinedCount:v.quarantinedCount,pendingCount:v.pendingCount,checkedAt:v.checkedAt}
    } catch { return unknown() }
  }
}
