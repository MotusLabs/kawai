// Bounded aliases and weighted series admission. Tool reservations and their
// fixed marker commit together; an inactive tool export admits nothing new.
import type { Database } from 'bun:sqlite'
import { ENUMS, REGISTRY, TOOL_FAMILIES, seriesCost } from './registry'
import { parseToolExportMarker, type ToolExportMarker } from './toolExportState'

const CAPS:Record<string,number>={team:32,group:32,provider:32,model:64,account:64,window:16}
export type Labels=Record<string,string>
export interface ToolAdmission {
  exportActive?:()=>boolean
  toolValues?:readonly string[]
}
type Reservation={family:string;labels:Labels;diagnostic:boolean}
const catchAll=(family:string):Labels=>Object.fromEntries(REGISTRY[family]!.labels.map(k=>[k,'other']))
export class BoundedLabels {
  constructor(private readonly db:Database,readonly maxSeries=250000,private readonly maxFamily=10000,
    private readonly tools:ToolAdmission={}) {this.reserveOverflow()}
  expandedSeries():number {
    const rows=this.db.prepare("SELECT family,count(*) n FROM process_export_totals WHERE bucket='admitted' GROUP BY family").all() as {family:string;n:number}[]
    return rows.reduce((n,r)=>n+r.n*(REGISTRY[r.family]?seriesCost(REGISTRY[r.family]!):Infinity),0)
  }
  private admitted(family:string,labels:Labels):boolean {
    return !!this.db.prepare("SELECT 1 FROM process_export_totals WHERE family=? AND labels=? AND bucket='admitted'").get(family,JSON.stringify(labels))
  }
  private count(family:string):number {
    return (this.db.prepare("SELECT count(*) n FROM process_export_totals WHERE family=? AND bucket='admitted'").get(family) as {n:number}).n
  }
  private required():Reservation[] {
    return Object.keys(REGISTRY).flatMap(family=>[
      {family,labels:catchAll(family),diagnostic:false},
      {family:'export_label_overflow_total',labels:{family},diagnostic:true},
    ])
  }
  private missing():Reservation[] {return this.required().filter(r=>!this.admitted(r.family,r.labels))}
  reservationsValid():boolean {
    return !this.missing().length&&this.expandedSeries()<=this.maxSeries&&Object.keys(REGISTRY).every(f=>this.count(f)<=this.maxFamily)
  }
  ensureToolExport(now:number):ToolExportMarker {
    return this.db.transaction(()=>{
      const missing=this.missing(),counts=new Map(Object.keys(REGISTRY).map(f=>[f,this.count(f)]))
      let cost=0
      for(const r of missing){cost+=seriesCost(REGISTRY[r.family]!);counts.set(r.family,counts.get(r.family)!+1)}
      const reason=this.expandedSeries()+cost>this.maxSeries?'series-budget':
        [...counts.values()].some(n=>n>this.maxFamily)?'family-budget':null
      const raw=(this.db.prepare("SELECT value FROM process_collection_checkpoints WHERE source='tool-export-v2'").get() as {value:string}|null)?.value??null
      const previous=parseToolExportMarker(raw),at=new Date(now).toISOString()
      const keep=reason===null&&previous?.state==='active'&&!missing.length
      const value:ToolExportMarker={version:1,definitionVersion:2,state:reason?'budget-unavailable':'active',reason,
        availableSince:reason?null:keep?previous!.availableSince:at,changedAt:keep?previous!.changedAt:at}
      // Verification still writes in this transaction, including identical bytes.
      const unchanged=previous&&previous.state===value.state&&previous.reason===value.reason&&
        previous.availableSince===value.availableSince&&(keep||value.state==='budget-unavailable')
      this.db.prepare("INSERT INTO process_collection_checkpoints VALUES ('tool-export-v2',?) ON CONFLICT(source) DO UPDATE SET value=excluded.value")
        .run(unchanged?raw!:JSON.stringify(value))
      if(!reason)for(const r of missing)this.admit(r.family,r.labels)
      return unchanged?previous!:value
    })()
  }
  labels(family:string,values:Record<string,string|null|undefined>):Labels|null {
    this.reserveOverflow()
    const definition=REGISTRY[family]
    if(!definition)throw Error('Unknown metric family')
    const toolFamily=(TOOL_FAMILIES as readonly string[]).includes(family)
    let collapsed=false
    let labels:Labels={}
    const aliases:{dimension:string;original:string;alias:string}[]=[]
    for(const key of definition.labels){
      const value=values[key]
      if(!value){labels[key]='unknown';continue}
      if(!CAPS[key]){
        const allowed=key==='tool'?(this.tools.toolValues??ENUMS.tool):ENUMS[key]
        labels[key]=allowed?.includes(value)?value:'other'
        collapsed||=labels[key]==='other'
        continue
      }
      const dimension=key==='group'?'group:'+(values.team??'unknown'):key==='window'?'window:'+(values.account??'unknown'):key
      const existing=this.db.prepare('SELECT alias FROM process_export_aliases WHERE dimension=? AND original=?').get(dimension,value) as {alias:string}|null
      if(existing){labels[key]=existing.alias;continue}
      const count=(this.db.prepare('SELECT count(*) n FROM process_export_aliases WHERE dimension=?').get(dimension) as {n:number}).n
      const parentOverflow=(key==='group'&&labels.team==='other')||(key==='window'&&labels.account==='other')
      if(count>=CAPS[key]!||parentOverflow){labels[key]='other';collapsed=true;continue}
      labels[key]=key+'_'+(count+1);aliases.push({dimension,original:value,alias:labels[key]!})
    }
    const admitted=this.admitted(family,labels)
    const active=!toolFamily||this.tools.exportActive?.()===true
    if(toolFamily&&!active&&(!admitted||aliases.length))return null
    for(const a of aliases)this.db.prepare('INSERT INTO process_export_aliases VALUES (?,?,?)').run(a.dimension,a.original,a.alias)
    if(!admitted){
      const diagnostics=this.missing().filter(r=>r.diagnostic).length
      if(this.count(family)>=this.maxFamily||this.expandedSeries()+seriesCost(definition)+diagnostics>this.maxSeries){
        labels=catchAll(family);collapsed=true
        if(!this.admitted(family,labels))return null
      }else this.admit(family,labels)
    }
    if(collapsed&&active)this.overflow(family)
    return labels
  }
  private reserveOverflow():void {
    this.db.transaction(()=>{
      const missing=Object.keys(REGISTRY).filter(f=>!(TOOL_FAMILIES as readonly string[]).includes(f))
        .map(family=>({family,labels:catchAll(family)})).filter(r=>!this.admitted(r.family,r.labels))
      const cost=missing.reduce((n,r)=>n+seriesCost(REGISTRY[r.family]!),0)
      if(this.expandedSeries()+cost>this.maxSeries||missing.some(r=>this.count(r.family)+1>this.maxFamily))return
      for(const r of missing)this.admit(r.family,r.labels)
    })()
  }
  private admit(family:string,labels:Labels):void {
    this.db.prepare("INSERT OR IGNORE INTO process_export_totals VALUES (?,?,'admitted',0)").run(family,JSON.stringify(labels))
  }
  private overflow(family:string):void {
    const values={family}
    if(!this.admitted('export_label_overflow_total',values)){
      if(this.count('export_label_overflow_total')>=this.maxFamily||this.expandedSeries()+1>this.maxSeries)return
      this.admit('export_label_overflow_total',values)
    }
    this.db.prepare("INSERT INTO process_export_totals VALUES ('export_label_overflow_total',?,'value',1) ON CONFLICT(family,labels,bucket) DO UPDATE SET value=value+1")
      .run(JSON.stringify(values))
  }
}
