// Bounded default tool projection. Full reads retain every numeric drill row.
import type { ProcessMetrics } from '../../shared/processMetrics'
export const COMPACT_METRICS_BYTES=32000
export function compactMetrics(metrics:ProcessMetrics):ProcessMetrics {
  const out=structuredClone(metrics)
  const lists:{owner:Record<string,unknown>;key:string;items:unknown[]}[]=[]
  const visit=(value:unknown):void=>{
    if(!value||typeof value!=='object')return
    if(Array.isArray(value)){for(const child of value)visit(child);return}
    const owner=value as Record<string,unknown>
    for(const [key,child]of Object.entries(owner)){
      if(Array.isArray(child)&&['tasks','messages','breakdown','slices','entries'].includes(key))
        lists.push({owner,key,items:child})
      visit(child)
    }
  }
  visit(out)
  const mark=(list:typeof lists[number])=>{
    if(list.key!=='entries')list.owner[list.key+'Total']??=list.items.length
    out.projectionTruncated=true
  }
  for(const list of lists)if(list.items.length>50){mark(list);list.items.length=50}
  while(new TextEncoder().encode(JSON.stringify(out)).length>=COMPACT_METRICS_BYTES){
    const largest=lists.reduce<typeof lists[number]|undefined>((a,b)=>b.items.length>(a?.items.length??0)?b:a,undefined)
    if(!largest?.items.length)throw Error('Compact metrics metadata exceeds 32 KB; request detail full.')
    mark(largest);largest.items.pop()
  }
  return out
}
