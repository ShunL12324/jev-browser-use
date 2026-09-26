// Generic controlled-grid wrappers, not site-specific classes or click handlers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { runTask } from '../../packages/bridge/dist/agent/loop.mjs'
import { prepareTask } from '../../packages/bridge/dist/agent/task.mjs'
const counts = new Map(), records = []
const fixture = kind => `<!doctype html><style>input,[tabindex]{padding:12px;margin:8px}[role=gridcell]{padding:12px}</style><div id=host></div><script>
const root=${kind==='shadow' ? "document.querySelector('#host').attachShadow({mode:'open'})" : "document.querySelector('#host')"};
root.innerHTML='<div><label for=field>Address</label><input id=field role=combobox aria-controls=grid aria-haspopup=grid aria-expanded=false><span id=display></span></div><div id=grid role=grid hidden><div tabindex=0><div><div role=row><div role=gridcell><span aria-hidden=true>★</span><span aria-label="350 Fifth Avenue"><span aria-hidden=true>350 Fifth Avenue</span></span><span aria-label="Manhattan"><span aria-hidden=true>Manhattan</span></span></div></div></div></div></div>';
const get=id=>root.querySelector('#'+id), field=get('field'), grid=get('grid'), item=grid.firstChild;
${kind==='duplicate-owner' ? "root.insertAdjacentHTML('beforeend','<input aria-label=Other aria-controls=grid>');" : ''}
${kind==='wrong-popup' ? "field.setAttribute('aria-controls','other');root.insertAdjacentHTML('beforeend','<div id=other role=grid></div>');" : ''}
${kind==='multi-row' ? "item.firstChild.append(item.querySelector('[role=row]').cloneNode(true));" : ''}
${kind==='multi-cell' ? "item.querySelector('[role=row]').append(item.querySelector('[role=gridcell]').cloneNode(true));" : ''}
${kind==='hidden' ? "grid.style.opacity='0';" : ''}
field.oninput=()=>{grid.hidden=false;field.setAttribute('aria-expanded','true')};
item.onmousedown=e=>{e.preventDefault();fetch('/picked?kind=${kind}');
${kind==='cross-document' ? "location.href='/result';" : `setTimeout(()=>{history.pushState({},'', '/selected');grid.hidden=true;field.setAttribute('aria-expanded','false');${kind==='url-only'?'':"get('display').textContent='350 Fifth Avenue Manhattan';"}},600);`}
};</script>`
const server=createServer((req,res)=>{const url=new URL(req.url,'http://x');if(url.pathname==='/picked'){const k=url.searchParams.get('kind');counts.set(k,(counts.get(k)??0)+1);res.end('ok');return}res.setHeader('Content-Type','text/html');res.end(url.pathname==='/result'?'<main>350 Fifth Avenue Manhattan</main>':fixture(url.searchParams.get('kind')??'light'))}).listen(0,'127.0.0.1');await once(server,'listening')
const origin=`http://127.0.0.1:${server.address().port}`
let browser
try {
 browser=await launchIsolated()
 for(const kind of ['duplicate-owner','wrong-popup','multi-row','multi-cell','hidden']){
  const {tabId}=await browser.call('tabs',{action:'new',url:`${origin}/?kind=${kind}`})
  let p
  for(let i=0;i<30;i++){p=await browser.call('s1',{tabId,action:'agent_observe'});if(p.elements.some(e=>e.name==='Address'))break;await new Promise(r=>setTimeout(r,50))}
  const field=p.elements.find(e=>e.name==='Address');assert.ok(field)
  await browser.call('s1',{tabId,action:'agent_execute',op:'type',ref:field.ref,guard:field.guard,documentId:p.documentId,url:p.url,text:'350 Fifth Avenue Manhattan'})
  const after=await browser.call('s1',{tabId,action:'agent_observe'});assert.equal(after.elements.some(e=>e.candidate),false,kind)
  records.push({kind,passed:true,candidates:[]});await browser.call('tabs',{action:'close',tabId})
 }
 for(const kind of ['light','shadow','url-only','cross-document']){
  const events=[]
  const ask=async({state,questions})=>{
   const pick=(q,id)=>({type:'choice',choice:id,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===id?1:0]))}), answers={}
   for(const[id,q]of Object.entries(questions)){
    const field=state.elements.find(e=>e.name==='Address')
    answers[id]=pick(q,id==='operation'?'DONE':id.startsWith('bind_')?(field&&field.id in q.criteria?field.id:'not_now'):Object.keys(q.criteria).includes('keep')?'keep':Object.keys(q.criteria)[0])
   }
   return{answers,usage:{input_tokens:0}}
  }
  const task=prepareTask({startUrl:`${origin}/?kind=${kind}`,allowedOrigins:[origin],goal:'Select the address and stop',inputs:{address:{value:'350 Fifth Avenue Manhattan',purpose:'address'}},llm:'none',irreversible:'deny',budgets:{maxSteps:10,maxJevRequests:10,timeoutMs:15000}})
  const result=await runTask(task,{call:browser.call,ask,handoff:async()=>({}),emit:e=>events.push(e)})
  records.push({kind,result,events,clicks:counts.get(kind)??0})
  assert.equal(counts.get(kind),1,kind+' must click exactly once')
  assert.equal(result.status,['light','shadow'].includes(kind)?'done':'blocked',JSON.stringify({kind,result}))
  if(!['light','shadow'].includes(kind))assert.equal(result.reason,'selection_unconfirmed')
 }
 console.log(JSON.stringify({passed:true,cases:records.length,liveJev:false}))
}finally{
 if(process.env.SELECTION_OUT){await mkdir(process.env.SELECTION_OUT,{recursive:true});await writeFile(`${process.env.SELECTION_OUT}/grid-cases.json`,JSON.stringify(records,null,2))}
 if(browser)await browser.close();await new Promise(r=>server.close(r))
}
