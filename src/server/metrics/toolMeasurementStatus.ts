// One bounded committed view over both process gates; no raw marker is public.
import type { Database } from 'bun:sqlite'
import { unknownToolMeasurement, type ToolMeasurementStatus } from '../../shared/processMetrics'
const owners=new WeakMap<Database,()=>ToolMeasurementStatus>()
export function bindToolMeasurementStatus(db:Database,read:()=>ToolMeasurementStatus):void {owners.set(db,read)}
export function readToolMeasurementStatus(db:Database):ToolMeasurementStatus {
  try {return db.transaction(()=>owners.get(db)?.()??unknownToolMeasurement())()}
  catch {return unknownToolMeasurement()}
}
export function canonicalToolMeasurement(v:ToolMeasurementStatus):string {
  return JSON.stringify([v.export.state,v.export.reason,v.export.availableSince,
    v.recovery.status,v.recovery.quarantinedCount,v.recovery.pendingCount,v.recovery.checkedAt])
}
