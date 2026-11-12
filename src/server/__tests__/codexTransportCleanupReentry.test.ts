import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { transportCases } from './helpers/codexTransportHarness'

test('cleanup reentered by a handler abort listener shares the outside cleanup promise', async () => {
  const cases = transportCases('kd52-review-reentry-')
  const fake = path.join(cases.root, 'fake')
  fs.writeFileSync(fake, '#!/usr/bin/env bun\nlet p=""; for await (const chunk of process.stdin) { p+=chunk.toString(); let n; while((n=p.indexOf("\\n"))>=0){ const m=JSON.parse(p.slice(0,n)); p=p.slice(n+1); if(!m.method) continue; process.stdout.write(JSON.stringify({id:"server",method:"held",params:{}})+"\\n"+JSON.stringify({id:m.id,result:{}})+"\\n"); }}\n', {mode:0o755})
  let entered = false
  let release!: () => void
  const held = new Promise<void>(r => release=r)
  let nested: Promise<void> | undefined
  const c = cases.open({ executable: fake, env: {PATH: process.env.PATH ?? ''}, clientInfo: {name:'probe',version:'0'}, capabilities:{},
    onServerRequest: async (_method,_params,signal) => {
      signal.addEventListener('abort', () => { nested=cases.cleanup() }, {once:true})
      entered=true
      await held
      throw signal.reason
    },
  })
  let outside: Promise<void> | undefined
  try {
    await c.transport.request('x')
    const end=Date.now()+2000
    while(!entered) {if(Date.now()>end) throw new Error('handler not entered'); await Bun.sleep(5)}
    outside=cases.cleanup()
    expect(nested).toBeDefined()
    expect(nested).toBe(outside)
  } finally {
    release()
    await Promise.all([outside ?? cases.cleanup(), nested])
  }
})
