import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askJev } from '../packages/bridge/dist/jev/core.mjs'
import { safeApiDiagnostic } from '../packages/bridge/dist/jev/diagnostics.mjs'
import { executeRun } from '../packages/bridge/dist/jev/service.mjs'
const sensitive='DO_NOT_LOG_TEST_MESSAGE_URL_HEADERS_BODY'
const payload={state:{},questions:{ready:{type:'noul',instructions:'Is ready?'}}}
async function temporary(fn){const dir=await mkdtemp(join(tmpdir(),'jev-diagnostic-offline-'));try{await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}}

test('diagnostic metadata is categorical and unknown strings are not reflected',()=>{
  const error=Object.assign(new Error(sensitive),{name:sensitive,cause:{code:sensitive,message:sensitive,headers:{authorization:sensitive}}})
  const result=safeApiDiagnostic(error,{stage:sensitive,httpStatus:999,signal:{aborted:false}})
  assert.deepEqual(result,{stage:'other',httpStatus:null,aborted:false,callerAborted:false,errorName:'other',causeCode:'other'})
  assert.ok(!JSON.stringify(result).includes(sensitive))
})

test('offline API failures retain stages/status/abort and one durable slot without retries or sensitive text',async()=>temporary(async dir=>{
  const original=globalThis.fetch
  const cases=[
    {name:'connect',stage:'fetch',httpStatus:null,errorName:'TypeError',causeCode:'UND_ERR_CONNECT_TIMEOUT',code:'TypeError',fetch:async()=>{throw new TypeError(sensitive,{cause:{code:'UND_ERR_CONNECT_TIMEOUT',message:sensitive}})}},
    {name:'dns',stage:'fetch',httpStatus:null,errorName:'TypeError',causeCode:'ENOTFOUND',code:'TypeError',fetch:async()=>{throw new TypeError(sensitive,{cause:{code:'ENOTFOUND',hostname:sensitive}})}},
    {name:'status',stage:'fetch',httpStatus:503,errorName:'Error',causeCode:'other',code:'API_ERROR',fetch:async()=>new Response(sensitive,{status:503})},
    {name:'body',stage:'response_json',httpStatus:200,errorName:'TypeError',causeCode:'UND_ERR_SOCKET',code:'TypeError',fetch:async()=>({ok:true,status:200,json:async()=>{throw new TypeError(sensitive,{cause:{code:'UND_ERR_SOCKET',socket:{remoteAddress:sensitive}}})}})},
    {name:'json',stage:'response_json',httpStatus:200,errorName:'SyntaxError',causeCode:'other',code:'SyntaxError',fetch:async()=>new Response(sensitive,{status:200})},
    {name:'null',stage:'validate',httpStatus:200,errorName:'TypeError',causeCode:'other',code:'TypeError',fetch:async()=>new Response('null',{status:200})},
    {name:'answer',stage:'validate',httpStatus:200,errorName:'Error',causeCode:'other',code:'BAD_ANSWER',fetch:async()=>new Response(JSON.stringify({answers:{ready:{type:'noul',noul:sensitive}}}),{status:200})}
  ]
  try{
    for(const c of cases){
      let sent=0;const ledgerPath=join(dir,c.name+'.json')
      globalThis.fetch=async(...args)=>{sent++;return c.fetch(...args)}
      await assert.rejects(askJev(payload,{apiKey:'offline-placeholder',ledgerPath}),error=>{
        assert.equal(error.code,c.code)
        assert.deepEqual(error.diagnostic,{stage:c.stage,httpStatus:c.httpStatus,aborted:false,callerAborted:false,errorName:c.errorName,causeCode:c.causeCode})
        assert.ok(!JSON.stringify(error).includes(sensitive));assert.ok(!error.message.includes(sensitive));assert.equal(error.cause,undefined)
        return true
      })
      assert.equal(sent,1);assert.equal(JSON.parse(await readFile(ledgerPath,'utf8')).requests.length,1)
    }
    const controller=new AbortController(),ledgerPath=join(dir,'abort.json');let sent=0
    globalThis.fetch=async()=>{sent++;controller.abort();throw new DOMException(sensitive,'AbortError')}
    await assert.rejects(askJev(payload,{apiKey:'offline-placeholder',ledgerPath,signal:controller.signal}),error=>{
      assert.equal(error.diagnostic.stage,'fetch');assert.equal(error.diagnostic.aborted,true);assert.equal(error.diagnostic.callerAborted,true);assert.equal(error.code,'AbortError');return true
    })
    assert.equal(sent,1);assert.equal(JSON.parse(await readFile(ledgerPath,'utf8')).requests.length,1)
  }finally{globalThis.fetch=original}
}))

test('native-tool result and JSONL retain safe API diagnostics with unknown usage and no raw error',async()=>temporary(async dir=>{
  const originalFetch=globalThis.fetch,originalKey=process.env.TYPESAFE_API_KEY
  const startUrl='http://127.0.0.1:17430/session/diagnostic-fixture'
  const host={async invoke(name){
    if(name==='tabs')return{tabId:42}
    if(name==='view')return{url:startUrl,title:'Fixture',content:'Pending',truncated:false}
    if(name==='snapshot')return{url:startUrl,interactables:[{ref:'e1',role:'button',name:'Open',tag:'button'}]}
    return{ok:true}
  }}
  try{
    process.env.TYPESAFE_API_KEY='offline-placeholder'
    globalThis.fetch=async()=>{throw new TypeError(sensitive,{cause:{code:'ECONNRESET',message:sensitive}})}
    const result=await executeRun({goal:'Open record',startUrl,scenario:'A',seed:'offline',mode:'J1',maxSteps:4},{host,ledgerPath:join(dir,'ledger.json'),traceDirectory:dir})
    assert.equal(result.status,'error');assert.equal(result.code,'TypeError');assert.equal(result.requests,1);assert.equal(result.unknownUsageRequests,1)
    assert.equal(result.diagnostic.stage,'fetch');assert.equal(result.diagnostic.causeCode,'ECONNRESET');assert.equal(result.tabId,42)
    const text=await readFile(result.tracePath,'utf8'),trace=text.trim().split('\n').map(JSON.parse)
    assert.deepEqual(trace.find(e=>e.event==='api_error').diagnostic,result.diagnostic)
    assert.deepEqual(trace.at(-1).diagnostic,result.diagnostic)
    assert.ok(!text.includes(sensitive));assert.ok(!JSON.stringify(result).includes(sensitive));assert.ok(!text.includes('offline-placeholder'))
  }finally{
    globalThis.fetch=originalFetch
    if(originalKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=originalKey
  }
}))
