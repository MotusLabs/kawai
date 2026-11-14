// Bounded parsing of the fixed export marker; malformed bytes never escape.
import { DEFINITION_VERSION } from './registry'
import type { ToolExportMeasurement } from '../../../shared/processMetrics'
export interface ToolExportMarker extends ToolExportMeasurement {
  version:1
  definitionVersion:number
  changedAt:string
}
export const unknownExport=():ToolExportMeasurement=>({state:'unknown',reason:null,availableSince:null})
export function parseToolExportMarker(raw:string|null):ToolExportMarker|null {
  let v:ToolExportMarker
  try {v=JSON.parse(raw??'null')}catch{return null}
  if(!v||v.version!==1||v.definitionVersion!==DEFINITION_VERSION||
    !['active','budget-unavailable','unknown'].includes(v.state)||
    ![null,'series-budget','family-budget','missing-reservation','invalid-checkpoint'].includes(v.reason)||
    typeof v.changedAt!=='string'||!Number.isFinite(Date.parse(v.changedAt)))return null
  if(v.state==='active'&&(v.reason!==null||typeof v.availableSince!=='string'||!Number.isFinite(Date.parse(v.availableSince))))return null
  if(v.state!=='active'&&v.availableSince!==null)return null
  if(v.state==='budget-unavailable'&&!['series-budget','family-budget'].includes(v.reason??''))return null
  return {version:1,definitionVersion:DEFINITION_VERSION,state:v.state,reason:v.reason,availableSince:v.availableSince,changedAt:v.changedAt}
}
