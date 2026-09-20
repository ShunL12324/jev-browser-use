import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateAnswers } from '../packages/bridge/dist/jev/core.mjs'
import { executeRun } from '../packages/bridge/dist/jev/service.mjs'
import { safeApiUsage } from '../packages/bridge/dist/jev/diagnostics.mjs'
const questions={action:{type:'choice',instructions:'Pick',criteria:{click:'Click',wait:'Wait'}}}
const valid={action:{type:'choice',choice:'click',probabilities:{click:0.7,wait:0.3}}}
const privateText='DO_NOT_EMIT_UNKNOWN_KEYS_OR_BODY'
function capture(q,a){try{validateAnswers(q,a);return null}catch(e){return e}}

// Frozen pre-diagnostic predicate from 8b2a9cc. This checks acceptance, not error text.
function previousAccepts(questions,answers){
  try{
    const own=(o,k)=>Object.hasOwn(o,k),probability=n=>Number.isFinite(n)&&n>=0&&n<=1
    if(!answers||typeof answers!=='object')return false
    for(const[key,q]of Object.entries(questions)){
      const a=answers[key];if(!a||a.type!==q.type)return false
      if(q.type==='noul'){if(!probability(a.noul))return false}else{
        const keys=Object.keys(q.criteria)
        if(!own(q.criteria,a.choice)||!a.probabilities||Object.keys(a.probabilities).length!==keys.length||!keys.every(k=>probability(a.probabilities[k])))return false
        const sum=keys.reduce((n,k)=>n+a.probabilities[k],0)
        if(Math.abs(sum-1)>0.05||a.probabilities[a.choice]<Math.max(...Object.values(a.probabilities)))return false
      }
    }
    return true
  }catch{return false}
}

test('validation diagnostics explain every unchanged rejection class without arbitrary strings',()=>{
  const cases=[
    ['missing',{}],
    ['type',{action:{...valid.action,type:privateText}}],
    ['choice',{action:{...valid.action,choice:privateText}}],
    ['missing',{action:{...valid.action,probabilities:null}}],
    ['prob_keys',{action:{...valid.action,probabilities:{click:1}}}],
    ['prob_keys',{action:{...valid.action,probabilities:{click:0.7,[privateText]:0.3}}}],
    ['prob_range',{action:{...valid.action,probabilities:{click:1.1,wait:-0.1}}}],
    ['prob_range',{action:{...valid.action,probabilities:{click:privateText,wait:0.3}}}],
    ['sum',{action:{...valid.action,probabilities:{click:0.2,wait:0.1}}}],
    ['not_argmax',{action:{...valid.action,probabilities:{click:0.4,wait:0.6}}}]
  ]
  for(const[reason,answers]of cases){
    const error=capture(questions,answers)
    assert.equal(error.code,'BAD_ANSWER');assert.equal(error.validation.reason,reason);assert.equal(error.validation.questionId,'action')
    assert.ok(!JSON.stringify(error).includes(privateText));assert.equal(previousAccepts(questions,answers),false)
  }
  const sum=capture(questions,cases.at(-2)[1]).validation
  assert.equal(sum.expectedKeyCount,2);assert.equal(sum.actualKeyCount,2);assert.equal(sum.keySetMatches,true);assert.equal(sum.selectedInCriteria,true);assert.ok(Math.abs(sum.sum-0.3)<1e-10);assert.equal(sum.selectedProbability,0.2);assert.equal(sum.maxProbability,0.2)
  const noul=capture({goal_met:{type:'noul'}},{goal_met:{type:'noul',noul:2}})
  assert.equal(noul.validation.reason,'prob_range');assert.equal(noul.validation.selectedProbability,2)
  const unknown=capture({[privateText]:questions.action},{[privateText]:cases.at(-1)[1].action})
  assert.equal(unknown.validation.questionId,'other');assert.ok(!JSON.stringify(unknown).includes(privateText))
})

test('diagnostic split retains the exact preexisting sum tolerance, argmax and malformed-answer acceptance',()=>{
  const choices=['click','wait','none',null]
  const values=[undefined,null,false,'0.5',NaN,Infinity,-0.1,0,0.01,0.49,0.5,0.51,0.54,0.55,0.6,1,1.05]
  for(const choice of choices)for(const a of values)for(const b of values){
    const answer={action:{type:'choice',choice,probabilities:{click:a,wait:b}}}
    assert.equal(capture(questions,answer)===null,previousAccepts(questions,answer))
  }
  for(const a of [null,undefined,[],{},true,1,'text'])assert.equal(capture(questions,a)===null,previousAccepts(questions,a))
  assert.equal(capture(questions,valid),null)
})

test('invalid answers preserve only known numeric usage in API trace and terminal, while still failing validation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'jev-validation-offline-')),oldFetch=globalThis.fetch,oldKey=process.env.TYPESAFE_API_KEY
  const startUrl='http://127.0.0.1:17430/session/invalid-answer'
  const host={async invoke(name){
    if(name==='tabs')return{tabId:42}
    if(name==='view')return{url:startUrl,title:'Synthetic',content:'Already saved',truncated:false}
    if(name==='snapshot')return{url:startUrl,interactables:[{ref:'e1',role:'button',name:'Open',tag:'button'}]}
    return{ok:true}
  }}
  try{
    process.env.TYPESAFE_API_KEY='offline-placeholder'
    for(const[input,expected,unknown]of[[123,123,0],[0,0,0],[-1,0,1],[privateText,0,1]]){
      let sent=0
      globalThis.fetch=async()=>{sent++;return new Response(JSON.stringify({model:privateText,answers:{action:{type:'choice',choice:'click',probabilities:{click:1}}},usage:{input_tokens:input,output_tokens:17,private:privateText}}),{status:200})}
      const result=await executeRun({goal:'Inspect saved state',startUrl,expectedText:'Already saved',scenario:'B',seed:'offline',mode:'J1',maxSteps:1},{host,ledgerPath:join(dir,`${unknown}-${expected}.json`),traceDirectory:dir})
      assert.equal(sent,1);assert.equal(result.status,'error');assert.equal(result.code,'BAD_ANSWER')
      assert.equal(result.validation.questionId,'action');assert.equal(result.validation.reason,'prob_keys')
      assert.equal(result.diagnostic.stage,'validate');assert.equal(result.diagnostic.httpStatus,200)
      assert.equal(result.inputTokens,expected);assert.equal(result.unknownUsageRequests,unknown);assert.equal(result.requests,1)
      assert.equal(result.events.filter(e=>e.event==='decision').length,0)
      const text=await readFile(result.tracePath,'utf8'),trace=text.trim().split('\n').map(JSON.parse)
      const failed=trace.find(e=>e.event==='api_error')
      assert.deepEqual(failed.validation,result.validation)
      if(!unknown){assert.deepEqual(failed.usage,{input_tokens:expected,output_tokens:17});assert.deepEqual(result.usage,failed.usage)}else{assert.equal(failed.usage,undefined)}
      assert.ok(!text.includes(privateText));assert.ok(!JSON.stringify(result).includes(privateText))
    }
    assert.deepEqual(safeApiUsage({input_tokens:7,output_tokens:-1,extra:privateText}),{input_tokens:7})
  }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=oldKey;await rm(dir,{recursive:true,force:true})}
})
