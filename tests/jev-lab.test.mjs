import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGate, executeRun } from '../packages/bridge/dist/jev/service.mjs'
import { reserveRequest, requireBudget } from '../packages/bridge/dist/jev/budget.mjs'
import { askJev } from '../packages/bridge/dist/jev/core.mjs'
import { makeScenario, oracle, createLab } from '../scripts/jev/lab.mjs'

async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-offline-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const task = { goal: 'Save River', startUrl: 'http://127.0.0.1:17430/session/test', values: { name: 'River' }, expectedText: 'Saved River', maxSteps: 4, scenario: 'B', seed: 'test' }
function response(payload, done = false) {
  const picks = { action: 'type', type_target: 'e1', type_value: 'name', click_target: 'none' }
  return { model: 'offline-fixture', usage: { input_tokens: 123 }, answers: Object.fromEntries(Object.entries(payload.questions).map(([key,q]) => [key,q.type === 'noul' ? { type:'noul',noul:key === 'goal_met' && done ? 0.99 : 0.01 } : { type:'choice',choice:picks[key],probabilities:Object.fromEntries(Object.keys(q.criteria).map(k => [k,k === picks[key] ? 1 : 0])) }])) }
}
function fakeHost(onTool = () => {}) {
  let value = ''
  return { async invoke(name, params, tabId) {
    await onTool(name,params,tabId)
    if (name === 'tabs') return { tabId: 42 }
    assert.equal(tabId,42)
    if (name === 'view') return { url:task.startUrl,title:'Synthetic',content:value ? 'Saved River' : 'Pending',truncated:false }
    if (name === 'snapshot') return { url:task.startUrl,interactables:[{ref:'e1',tag:'input',role:'textbox',name:'Name',value}] }
    if (name === 'inspect') return { values:{disabled:'false',readonly:null,type:'text',tag:'input',href:null,target:null} }
    if (name === 'type') { assert.equal(params.target.ref,'e1'); value=params.text }
    return {ok:true}
  } }
}

test('shared budget counts failed reservations, rejects exhausted, corrupt and locked ledgers', async () => temporary(async dir => {
  const path=join(dir,'budget.json')
  assert.equal(requireBudget(path,12),100)
  for (let i=1;i<=100;i++) assert.equal(reserveRequest(path,{runId:'test'}),i)
  assert.throws(() => reserveRequest(path,{}),{code:'BUDGET_LIMIT'})
  assert.throws(() => requireBudget(path,1),{code:'BUDGET_LIMIT'})
  await mkdir(path+'.lock')
  assert.throws(() => reserveRequest(path,{}),{code:'BUDGET_LOCKED'})
  assert.equal(JSON.parse(await readFile(path,'utf8')).requests.length,100)
  const broken=join(dir,'broken.json');await writeFile(broken,'{broken')
  assert.throws(()=>requireBudget(broken,1),{code:'BUDGET_INVALID'})
}))

test('gate rejects overlapping low/high operations and holds until pending work actually drains', async () => {
  const gate=createGate(); let release
  const pending=gate.exclusive(() => new Promise(r => {release=r}))
  await assert.rejects(gate.exclusive(async () => {}),{code:'BUSY'})
  release(); await pending
  await gate.exclusive(async () => {})
  await gate.exclusive(async () => {gate.poison()})
  await assert.rejects(gate.exclusive(async () => {}),{code:'BUSY'})
})

test('runner uses same host, reserves before each ask and returns real execution/terminal evidence', async () => temporary(async dir => {
  const ledgerPath=join(dir,'budget.json'), calls=[]
  const result=await executeRun(task,{host:fakeHost(name => calls.push(name)),ledgerPath,traceDirectory:dir,ask:async p => {
    assert.equal(JSON.parse(await readFile(ledgerPath,'utf8')).requests.length,calls.filter(x=>x==='view').length)
    return response(p)
  }})
  assert.equal(result.status,'done'); assert.equal(result.tabId,42); assert.equal(result.requests,2); assert.equal(result.inputTokens,246)
  assert.equal(result.verification,'not_independently_verified')
  assert.equal(result.events.filter(e=>e.event==='tool_finished' && e.tool==='type').length,1)
  const trace=(await readFile(result.tracePath,'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(trace.some(e=>e.event==='observation'))
  assert.ok(trace.some(e=>e.event==='api_started' && e.questionsHash && e.payload))
  assert.equal(trace.at(-1).event,'terminal')
}))

test('failed API is counted once without retry; terminal retains tab, unknown usage and error', async () => temporary(async dir => {
  let asked=0
  const result=await executeRun(task,{host:fakeHost(),ledgerPath:join(dir,'budget.json'),traceDirectory:dir,ask:async () => {asked++; throw Object.assign(new Error('private upstream body'),{code:'API_ERROR'})}})
  assert.equal(asked,1); assert.equal(result.tabId,42); assert.equal(result.requests,1); assert.equal(result.unknownUsageRequests,1); assert.equal(result.code,'API_ERROR')
  assert.ok(!JSON.stringify(result).includes('private upstream body'))
}))

test('abort during extension action returns only after the action settles, then no subsequent action', async () => temporary(async dir => {
  const controller=new AbortController(), gate=createGate(); let release, began
  const started=new Promise(r=>{began=r})
  const host=fakeHost(async name=>{ if(name==='type'){ began(); await new Promise(r=>{release=r}) } })
  let finished=false
  const pending=gate.exclusive(()=>executeRun(task,{host,signal:controller.signal,ledgerPath:join(dir,'budget.json'),traceDirectory:dir,ask:async p=>response(p)})).then(r=>{finished=true;return r})
  await started; controller.abort(); await new Promise(r=>setTimeout(r,10)); assert.equal(finished,false)
  await assert.rejects(gate.exclusive(async()=>{}),{code:'BUSY'})
  release(); const result=await pending
  assert.equal(result.status,'error'); assert.equal(result.tabId,42); assert.equal(result.requests,1)
  await gate.exclusive(async()=>{})
}))

test('bridge timeout latches takeover closed and terminal records uncertainty', async () => temporary(async dir => {
  const gate=createGate()
  const result=await gate.exclusive(()=>executeRun(task,{host:fakeHost(name=>{if(name==='type')throw Object.assign(new Error('unknown state'),{code:'TIMEOUT'})}),ledgerPath:join(dir,'budget.json'),traceDirectory:dir,ask:async p=>response(p),onUncertain:()=>gate.poison()}))
  assert.equal(result.code,'TIMEOUT')
  await assert.rejects(gate.exclusive(async()=>{}),{code:'BUSY'})
}))

test('fixture seed/reset isolation and independent oracle reject initial, unsaved and wrong-record results', async () => {
  assert.deepEqual(makeScenario({seed:'same',density:64}),makeScenario({seed:'same',density:64}))
  const s={...makeScenario({scenario:'B'}),runId:'a',openedId:null,saved:null,closedAfterSave:false}
  assert.equal(oracle(s).passed,false)
  s.openedId=s.targetId; assert.equal(oracle(s).passed,false)
  s.saved={recordId:'wrong',displayName:'River',reviewerName:'Riley'};s.closedAfterSave=true;assert.equal(oracle(s).passed,false)
  s.saved.recordId=s.targetId;assert.equal(oracle(s).passed,true)
  const server=await createLab({port:0}), base=`http://127.0.0.1:${server.address().port}`
  try {
    const reset=async()=> (await fetch(base+'/reset',{method:'POST',body:JSON.stringify({scenario:'B',seed:'same',density:8})})).json()
    const a=await reset(),b=await reset(); assert.notEqual(a.runId,b.runId)
    const initial=await (await fetch(base+'/api/'+a.runId)).json();assert.ok(!('targetId' in initial));assert.ok(!('passed' in initial))
    const gold=await (await fetch(base+'/oracle/'+a.runId)).json()
    const begin=performance.now()
    await fetch(base+'/api/'+a.runId+'/save',{method:'POST',body:JSON.stringify({recordId:gold.targetId,displayName:'River',reviewerName:'Riley'})})
    assert.ok(performance.now()-begin>=290)
    assert.equal((await (await fetch(base+'/oracle/'+a.runId)).json()).passed,false)
    await fetch(base+'/api/'+a.runId+'/close',{method:'POST',body:'{}'})
    assert.equal((await (await fetch(base+'/oracle/'+a.runId)).json()).passed,true)
    assert.equal((await (await fetch(base+'/oracle/'+b.runId)).json()).passed,false)
    assert.ok(!(await (await fetch(a.task.startUrl)).text()).includes(a.task.expectedText))
  } finally { await new Promise(r=>server.close(r)) }
})


test('standalone API provider reserves before fetch and never retries failed requests', async () => temporary(async dir => {
  const ledgerPath=join(dir,'api-budget.json'), original=globalThis.fetch
  let sent=0
  try {
    globalThis.fetch=async()=>{sent++;assert.equal(JSON.parse(await readFile(ledgerPath,'utf8')).requests.length,sent);return new Response('',{status:503})}
    await assert.rejects(askJev({state:{},questions:{}},{apiKey:'offline-test-placeholder',ledgerPath}),{code:'API_ERROR'})
    assert.equal(sent,1)
    for(let i=1;i<100;i++) reserveRequest(ledgerPath,{source:'offline-limit-test'})
    await assert.rejects(askJev({state:{},questions:{}},{apiKey:'offline-test-placeholder',ledgerPath}),{code:'BUDGET_LIMIT'})
    assert.equal(sent,1)
  } finally {globalThis.fetch=original}
}))


test('ledger survives process restarts and concurrent senders never allocate beyond 100', async () => temporary(async dir => {
  const ledgerPath=join(dir,'shared.json')
  for(let i=0;i<98;i++) reserveRequest(ledgerPath,{source:'setup'})
  const moduleUrl=new URL('../packages/bridge/dist/jev/budget.mjs',import.meta.url).href
  const child=()=>new Promise((resolve,reject)=>{
    const code=`import {reserveRequest} from ${JSON.stringify(moduleUrl)}; try { console.log(reserveRequest(process.argv[1],{source:'child'})) } catch(e) {console.log(e.code)}`
    const p=spawn(process.execPath,['--input-type=module','-e',code,ledgerPath]);let out='';p.stdout.on('data',b=>out+=b);p.once('error',reject);p.once('exit',status=>status===0?resolve(out.trim()):reject(new Error('Child failed')))
  })
  const outputs=await Promise.all(Array.from({length:8},child))
  const numbers=outputs.filter(x=>/^\d+$/.test(x)).map(Number)
  assert.equal(numbers.length,new Set(numbers).size)
  assert.ok(numbers.every(x=>x===99||x===100))
  const ledger=JSON.parse(await readFile(ledgerPath,'utf8'));assert.ok(ledger.requests.length<=100);assert.ok(ledger.requests.length>=99)
  assert.ok(outputs.every(x=>/^\d+$/.test(x)||['BUDGET_LIMIT','BUDGET_LOCKED'].includes(x)))
  const after=await child();assert.ok(after==='100'||after==='BUDGET_LIMIT')
}))
