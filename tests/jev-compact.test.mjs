import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { prepare, validateTask, decide } from '../packages/bridge/dist/jev/core.mjs'
const fixture=JSON.parse(await readFile(new URL('./fixtures/compact-observation.json',import.meta.url),'utf8'))
const golden=JSON.parse(await readFile(new URL('./fixtures/j0-payload.json',import.meta.url),'utf8'))
const json=value=>JSON.parse(JSON.stringify(value))
const build=mode=>prepare(validateTask({...fixture.task,...(mode?{mode}:{})}),fixture.view,fixture.snapshot,fixture.history)
const decode=p=>p.state.page.elements.map(e=>Object.fromEntries(Object.entries(e).map(([key,value])=>[p.state.page.element_fields[key],value])))

test('default and explicit J0 remain byte-equivalent to frozen T105 prepared payload',()=>{
  // Golden generated from T105 4fb12cf; includes question wording/order and page fingerprint.
  assert.deepEqual(json(build()),golden)
  assert.deepEqual(json(build('J0')),golden)
  assert.equal(JSON.stringify(build('J0')),JSON.stringify(golden))
  assert.throws(()=>validateTask({...fixture.task,mode:'unknown'}),{code:'TASK'})
})

test('J1 round-trips all observed fields and candidate order without changing other questions or fingerprint',()=>{
  const j0=build('J0'),j1=build('J1')
  assert.deepEqual(json(decode(j1)),json(j0.state.page.elements))
  assert.deepEqual(j1.elements,j0.elements)
  assert.equal(j1.fingerprint,j0.fingerprint)
  for(const key of ['goal','supplied_values','recent_actions'])assert.deepEqual(j1.state[key],j0.state[key])
  for(const key of ['url','title','content'])assert.equal(j1.state.page[key],j0.state.page[key])
  for(const key of ['action','goal_met','blocked','type_value'])assert.deepEqual(j1.questions[key],j0.questions[key])
  for(const key of ['click_target','type_target']){
    assert.deepEqual(Object.keys(j1.questions[key].criteria),Object.keys(j0.questions[key].criteria))
    assert.equal(j1.questions[key].criteria.none,j0.questions[key].criteria.none)
    for(const ref of Object.keys(j1.questions[key].criteria).filter(k=>k!=='none')){
      assert.equal(j1.questions[key].criteria[ref],ref)
      const element=decode(j1).find(e=>e.ref===ref)
      assert.deepEqual({role:element.role??'',name:element.name??'',tag:element.tag??'',value:element.value??''},j0.questions[key].criteria[ref])
    }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(j1))<Buffer.byteLength(JSON.stringify(j0)))
})

function answer(p,picks){return {answers:Object.fromEntries(Object.entries(p.questions).map(([key,q])=>[key,q.type==='noul'?{type:'noul',noul:0.01}:{type:'choice',choice:picks[key],probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===picks[key]?1:0]))}]))}}
test('identical model picks produce identical checked actions and completion under both encodings',()=>{
  const j0=build('J0'),j1=build('J1'),task=validateTask(fixture.task)
  for(const action of ['click','type','wait','scroll_down','stop']){
    const picks={action,click_target:'e3',type_target:'f2:e9',type_value:'reviewer'}
    assert.deepEqual(decide(task,j1,answer(j1,picks),42),decide(task,j0,answer(j0,picks),42))
  }
  const view={...fixture.view,content:task.expectedText}
  for(const mode of ['J0','J1']){
    const p=prepare(validateTask({...fixture.task,mode}),view,fixture.snapshot)
    assert.equal(decide(task,p,answer(p,{action:'wait',click_target:'none',type_target:'none',type_value:'none'}),42).status,'done')
  }
})

test('J1 retains truncation, candidate count, and 48KB stops instead of dropping evidence',()=>{
  const task=validateTask({...fixture.task,mode:'J1'})
  assert.throws(()=>prepare(task,{...fixture.view,truncated:true},fixture.snapshot),{code:'PAGE_TOO_LARGE'})
  const snapshot={...fixture.snapshot,interactables:Array.from({length:255},(_,i)=>({ref:`e${i}`,role:'button',name:'Open',tag:'button'}))}
  assert.throws(()=>prepare(task,fixture.view,snapshot),{code:'PAGE_TOO_LARGE'})
  const boundary=prepare(task,fixture.view,{...snapshot,interactables:snapshot.interactables.slice(0,254)})
  assert.equal(Object.keys(boundary.questions.click_target.criteria).length,255)
  assert.throws(()=>prepare(task,{...fixture.view,content:'x'.repeat(48000)},fixture.snapshot),{code:'PAGE_TOO_LARGE'})
})
