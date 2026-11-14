// One export verification gate per observation-service process owner.
import type { ObservationStore } from '../observations/store'
import { BoundedLabels, type ToolAdmission } from './boundedLabels'
import { parseToolExportMarker, unknownExport } from './toolExportState'
import type { ToolExportMeasurement } from '../../../shared/processMetrics'
export class ToolExportStatus {
  private gate:'unverified'|'verified'|'failed'='unverified'
  readonly bounds:BoundedLabels
  constructor(private readonly store:ObservationStore,private readonly onChange:()=>void,
    options:ToolAdmission&{maxSeries?:number;maxFamily?:number}={}) {
    this.bounds=new BoundedLabels(store.db,options.maxSeries,options.maxFamily,options)
  }
  ensure():boolean {
    try {this.bounds.ensureToolExport(this.store.now());this.gate='verified';return true}
    catch {this.gate='failed';return false}
    finally {this.onChange()}
  }
  read():ToolExportMeasurement {
    if(this.gate!=='verified')return unknownExport()
    try {
      const marker=parseToolExportMarker(this.store.checkpoint('tool-export-v2'))
      if(!marker||(marker.state==='active'&&!this.bounds.reservationsValid()))return unknownExport()
      return {state:marker.state,reason:marker.reason,availableSince:marker.availableSince}
    }catch{return unknownExport()}
  }
}
