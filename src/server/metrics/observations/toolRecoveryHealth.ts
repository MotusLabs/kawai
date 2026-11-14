// Process-local recovery verification; stable healthy counts keep their timestamp.
import type { ObservationStore } from './store'
export type RecoveryStatus = {
  status: 'unknown' | 'ok' | 'pending' | 'quarantined'
  quarantinedCount: number | null
  pendingCount: number | null
  checkedAt: string | null
}
const unknown = (): RecoveryStatus => ({ status:'unknown',quarantinedCount:null,pendingCount:null,checkedAt:null })
type StoredRecovery = {version:1;status:'ok'|'pending'|'quarantined';quarantinedCount:number;pendingCount:number;checkedAt:string}
export class ToolRecoveryHealth {
  private gate: 'unverified' | 'verified' | 'failed' = 'unverified'
  constructor(private readonly store: ObservationStore, private readonly onChange:()=>void = ()=>{}) {}
  private stored(): StoredRecovery | null {
    let v: StoredRecovery
    try { v=JSON.parse(this.store.checkpoint('tool-recovery-quarantine') ?? 'null') } catch { return null }
    if (!v || v.version!==1 || Object.keys(v).some(k=>!['version','status','quarantinedCount','pendingCount','checkedAt'].includes(k)) || !Number.isSafeInteger(v.quarantinedCount) || v.quarantinedCount<0 ||
      !Number.isSafeInteger(v.pendingCount) || v.pendingCount<0 ||
      v.status!==(v.quarantinedCount?'quarantined':v.pendingCount?'pending':'ok') ||
      typeof v.checkedAt!=='string' || !Number.isFinite(Date.parse(v.checkedAt))) return null
    return {version:1,status:v.status,quarantinedCount:v.quarantinedCount,pendingCount:v.pendingCount,checkedAt:v.checkedAt}
  }
  write(ready: boolean, quarantinedCount: number, pendingCount: number): boolean | undefined {
    if (!ready) { this.gate='failed';this.onChange();return }
    try {
      this.store.db.transaction(()=>{
        const previous=this.stored()
        const same=previous?.quarantinedCount===quarantinedCount && previous.pendingCount===pendingCount
        // A failed/unverified gate must perform a real write, even for identical bytes.
        if(same && this.gate==='verified')return
        const value=same?previous:{version:1,quarantinedCount,pendingCount,
          status:quarantinedCount?'quarantined':pendingCount?'pending':'ok',
          checkedAt:new Date(this.store.now()).toISOString()}
        this.store.setCheckpoint('tool-recovery-quarantine',same?this.store.checkpoint('tool-recovery-quarantine')!:JSON.stringify(value))
      })()
      this.gate='verified'
      return true
    } catch { this.gate='failed';return false }
    finally { this.onChange() }
  }
  read(): RecoveryStatus {
    if(this.gate!=='verified')return unknown()
    try {
      const v=this.stored()
      return v?{status:v.status,quarantinedCount:v.quarantinedCount,pendingCount:v.pendingCount,checkedAt:v.checkedAt}:unknown()
    } catch { return unknown() }
  }
}
