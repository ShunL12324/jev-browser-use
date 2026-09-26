// Real extension + browser_task loop, scripted Jev. This measures mechanical
// correctness only, never model accuracy. Oracle state is held by this server
// and is read by assertions after the run, never by the decision function.
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { runTask } from '../../packages/bridge/dist/agent/loop.mjs'
import { prepareTask } from '../../packages/bridge/dist/agent/task.mjs'
const observations = new Map()
const fixture = variant => `<!doctype html><meta charset="utf-8"><style>input,button{margin:8px} [role=option]{padding:12px;cursor:pointer} [hidden]{display:none!important}</style>
<div id="host"></div><script>
const root = ${variant === 'shadow' ? "document.querySelector('#host').attachShadow({mode:'open'})" : "document.querySelector('#host')"};
root.innerHTML = '<label>Country <select id="country"><option value="">Choose</option><option value="CA">Canada</option><option value="US">United States</option></select></label><label>School <input id="school" role="combobox" aria-autocomplete="list" aria-controls="schools" aria-expanded="false"></label><label>Address <input id="address" role="combobox" aria-autocomplete="list" aria-controls="addresses" aria-expanded="false"></label><div id="unrelated" role="listbox" aria-label="Unrelated suggestions"><button role="option" type="button">Example University</button></div><section><ul id="schools" role="listbox" aria-label="Schools" hidden></ul><ul id="addresses" role="listbox" aria-label="Addresses" hidden></ul></section><label>Appointment date <input id="date" readonly></label><button type="button" id="open">Choose appointment date</button><div id="calendar" role="dialog" aria-label="Appointment calendar" hidden><button type="button" id="next">Next month</button><table role="grid" aria-label="October 2026"><tbody><tr><td><button type="button" id="day" aria-label="October 15, 2026">15</button></td><td><button type="button" disabled aria-label="October 16, 2026">16</button></td></tr></tbody></table><button type="button" id="apply">Apply</button></div><p id="status"></p>';
${variant === 'custom' ? `root.querySelector('#country').outerHTML='<button type="button" id="country" role="combobox" aria-label="Country" aria-controls="countries" aria-expanded="false">Choose country</button><ul id="countries" role="listbox" hidden><li role="option">Canada</li><li role="option">United States</li></ul>';root.append(root.querySelector('#countries'));` : ''}
const get = id => root.querySelector('#'+id), report = (kind,value) => fetch('/record?variant=${variant}',{method:'POST',body:JSON.stringify({kind,value})});
get('country').onchange = () => {get('school').value='';get('address').value=''; report('country', get('country').value)};
${variant === 'custom' ? `get('country').onclick=()=>{get('country').setAttribute('aria-expanded','true');get('countries').hidden=false};for(const o of get('countries').children)o.onmousedown=e=>{e.preventDefault();get('country').textContent=o.textContent;get('country').setAttribute('aria-expanded','false');get('countries').hidden=true;get('school').value='';get('address').value='';report('country',o.textContent==='Canada'?'CA':'US')};` : ''}
root.querySelector('#unrelated button').onclick=()=>report('wrong','unrelated');
function setup(id,list,label,delay){let seq=0;get(id).oninput=()=>{const mine=++seq;get(id).setAttribute('aria-expanded','true');get(id).setAttribute('aria-busy','true');get(list).hidden=false;get(list).innerHTML='<li role="option">Stale result</li>';setTimeout(()=>{if(mine!==seq)return;get(list).innerHTML='<li role="option">'+label+'</li>';get(id).setAttribute('aria-busy','false');get(list).firstChild.onmousedown=e=>{e.preventDefault();get(id).value=label;get(id).setAttribute('aria-expanded','false');get(list).hidden=true;report(id,label)}},delay)}}
setup('school','schools','Example University',${variant === 'shadow' ? 120 : 1200}); setup('address','addresses','10 Example Road, Ottawa',${variant === 'shadow' ? 1100 : 150});
let month=10,pending='';get('open').onclick=()=>get('calendar').hidden=false;get('next').onclick=()=>{month++;root.querySelector('table').setAttribute('aria-label', 'November 2026');get('day').setAttribute('aria-label','November 15, 2026')};get('day').onclick=()=>{pending=month===11?'2026-11-15':'2026-10-15';get('day').setAttribute('aria-pressed','true')};get('apply').onclick=()=>{get('date').value=pending;get('calendar').hidden=true;get('status').textContent='Selection saved';report('date',pending)};
</script>`
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost'), variant = url.searchParams.get('variant') ?? 'portal'
  if (url.pathname === '/record') { let body=''; for await (const chunk of req) body+=chunk; observations.get(variant).push(JSON.parse(body)); res.end('ok'); return }
  res.setHeader('Content-Type','text/html');res.end(fixture(variant))
}).listen(0,'127.0.0.1'); await once(server,'listening')
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await launchIsolated()
  for (const variant of (process.env.SELECTION_VARIANTS ?? 'portal,shadow,custom').split(',')) {
    observations.set(variant,[])
    const task = prepareTask({ startUrl:`${origin}/?variant=${variant}`, allowedOrigins:[origin], goal:'Select Canada, school Example University, address 10 Example Road, Ottawa, and appointment November 15, 2026. Apply the appointment date.',
      inputs:{country:{value:'Canada',purpose:'country'},school:{value:'Example University',purpose:'school'},address:{value:'10 Example Road, Ottawa',purpose:'address'}}, llm:'none', irreversible:'deny', budgets:{maxSteps:30,maxJevRequests:20,timeoutMs:30000} })
    const events=[]
    const ask=async ({state,questions})=>{
      const choice=(q,id)=>({type:'choice',choice:id,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===id?1:0]))}), answers={}
      for(const [id,q] of Object.entries(questions)) {
        if(id.startsWith('bind_')) {const name=['country','school','address'].find(n=>q.instructions.includes('"purpose":"'+n+'"'));const field=state.elements.find(e=>e.name.toLowerCase()===name);answers[id]=choice(q,field&&field.id in q.criteria?field.id:state.elements.find(e=>e.role==='option'&&e.name===({country:'Canada',school:'Example University',address:'10 Example Road, Ottawa'}[name])&&e.id in q.criteria)?.id??'not_now')}
        else if(id.startsWith('field_')) answers[id]=choice(q,'keep')
        else if(id==='text_value') answers[id]=choice(q,'caller')
      }
      const pending=state.pendingSelections?.[0]
      const date=state.elements.find(e=>e.name==='Appointment date')
      let op='WAIT', target
      if(!pending&&variant==='custom'&&state.inputs.country.status!=='applied') target=state.elements.find(e=>e.name==='Country')
      else if(pending?.ready) target=state.elements.find(e=>pending.optionRefs.includes(e.id)&&e.name!=='Stale result')
      else if(!pending&&state.inputs.country.status==='applied'&&state.inputs.school.status==='applied'&&state.inputs.address.status==='applied') {
        if(date?.value==='2026-11-15') op='DONE'
        else {const actions=state.recentActions; const dayClicked=actions.some(a=>a.op==='click'&&a.target==='November 15, 2026');target=state.elements.find(e=>e.name===(dayClicked?'Apply':state.elements.some(e=>e.name==='November 15, 2026')?'November 15, 2026':state.elements.some(e=>e.name==='Next month')?'Next month':'Choose appointment date'))}
      }
      if(target) op='CLICK'
      answers.operation=choice(questions.operation,op)
      for(const [id,q] of Object.entries(questions)) if(id.startsWith('target_')) answers[id]=choice(q,id==='target_CLICK'&&target&&target.id in q.criteria?target.id:Object.keys(q.criteria)[0])
      return {answers,usage:{input_tokens:0}}
    }
    const result=await runTask(task,{call:browser.call,ask,handoff:async()=>({}),emit:e=>events.push(e)})
    if(process.env.SELECTION_OUT) {await mkdir(process.env.SELECTION_OUT,{recursive:true});await writeFile(`${process.env.SELECTION_OUT}/${variant}.json`,JSON.stringify({result,events,oracle:observations.get(variant)},null,2))}
    assert.equal(result.status,'done',JSON.stringify({variant,result,tail:events.slice(-10)}))
    const observed=observations.get(variant)
    assert.equal(observed.some(e=>e.kind==='wrong'),false)
    const countryIndex=observed.findIndex(e=>e.kind==='country'); assert.ok(countryIndex>=0)
    assert.equal(observed.filter(e=>e.kind==='country').length,1)
    for(const [kind,value] of [['country','CA'],['school','Example University'],['address','10 Example Road, Ottawa'],['date','2026-11-15']]) assert.equal(observed.slice(countryIndex).filter(e=>e.kind===kind&&e.value===value).length,1,JSON.stringify(observed))
    assert.ok(events.filter(e=>e.event==='selection_committed').length>=2)
    console.log(JSON.stringify({variant,passed:true,liveJev:false,oracle:observed,steps:result.metrics.steps}))
  }
} finally { if(browser) await browser.close(); await new Promise(r=>server.close(r)) }
