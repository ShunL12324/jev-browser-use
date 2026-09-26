// Generic controlled-grid wrappers, not site-specific classes or click handlers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { targets } from '../../packages/bridge/src/agent/space.mjs'
import { runTask } from '../../packages/bridge/dist/agent/loop.mjs'
import { prepareTask } from '../../packages/bridge/dist/agent/task.mjs'
const counts = new Map(), records = []
const fixture = kind => `<!doctype html><style>input,[tabindex]{padding:12px;margin:8px}[role=gridcell]{padding:12px}</style><div id=host></div><script>
const root=${['shadow','intermediate-shadow','aggregate-shadow'].includes(kind) ? "document.querySelector('#host').attachShadow({mode:'open'})" : "document.querySelector('#host')"};
root.innerHTML='<div><label for=field>Address</label><input id=field role=combobox aria-controls=grid aria-haspopup=grid aria-expanded=false><span id=display></span></div><div id=grid role=grid hidden><div id=wrapper tabindex=0 aria-label="Candidate wrapper"><div><div role=row><div role=gridcell><span aria-hidden=true>★</span><span aria-label="350 Fifth Avenue"><span aria-hidden=true>350 Fifth Avenue</span></span><span aria-label="Manhattan"><span aria-hidden=true>Manhattan</span></span></div></div></div></div></div>';
const get=id=>root.querySelector('#'+id), field=get('field'), grid=get('grid'), item=grid.firstChild;
${kind.startsWith('intermediate') ? "const shell=document.createElement('div');grid.replaceChild(shell,item);shell.append(item);" : ''}
${kind.startsWith('aggregate') && kind!=='aggregate-slot' ? "const all=document.createElement('div');all.tabIndex=0;all.setAttribute('aria-label','All suggestions');(root instanceof ShadowRoot?root.host:root).parentNode.insertBefore(all,root instanceof ShadowRoot?root.host:root);all.append(root instanceof ShadowRoot?root.host:root);all.onmousedown=()=>fetch('/picked?kind="+kind+"');" : ''}
${kind==='aggregate-slot' ? "const mount=document.createElement('div');root.parentNode.insertBefore(mount,root);mount.attachShadow({mode:'open'}).innerHTML='<div tabindex=0 aria-label=\"All suggestions\"><slot></slot></div>';mount.append(root);mount.shadowRoot.firstChild.onmousedown=()=>fetch('/picked?kind=aggregate-slot');" : ''}
${kind==='owned-container' ? "field.removeAttribute('aria-controls');const owner=document.createElement('div');owner.tabIndex=0;owner.setAttribute('role','combobox');owner.setAttribute('aria-controls','grid');owner.setAttribute('aria-label','Container owner');grid.replaceWith(owner);owner.append(grid);owner.onmousedown=()=>fetch('/picked?kind=owned-container');" : ''}
${kind==='duplicate-owner' ? "root.insertAdjacentHTML('beforeend','<input aria-label=Other aria-controls=grid>');" : ''}
${kind==='wrong-popup' ? "field.setAttribute('aria-controls','other');root.insertAdjacentHTML('beforeend','<div id=other role=grid></div>');" : ''}
${['multi-row','intermediate-multi-row'].includes(kind) ? "item.firstChild.append(item.querySelector('[role=row]').cloneNode(true));" : ''}
${kind==='multi-cell' ? "item.querySelector('[role=row]').append(item.querySelector('[role=gridcell]').cloneNode(true));" : ''}
${kind==='disabled-cell' ? "item.querySelector('[role=gridcell]').setAttribute('aria-disabled','true');" : ''}
${kind==='disabled-row' ? "item.querySelector('[role=row]').setAttribute('aria-disabled','true');" : ''}
${kind==='busy' ? "field.setAttribute('aria-busy','true');" : ''}
${['rogue','intermediate-rogue'].includes(kind) ? "item.querySelector('[role=gridcell]').insertAdjacentHTML('beforeend','<span tabindex=0 aria-label=Rogue>Rogue</span>');" : ''}
${['nested','nested-busy','nested-wrong-owner','nested-shadow','nested-checkbox'].includes(kind) ? `const nest=document.createElement('div');item.append(nest);const nestedRoot=${kind==='nested-shadow'?"nest.attachShadow({mode:'open'})":"nest"};nestedRoot.innerHTML='<div role=grid><div role=row><div role=gridcell>${kind==='nested-checkbox'?'<span role=checkbox tabindex=0>Nested action</span>':'<button type=button>Nested action</button>'}</div></div></div>';` : ''}
${kind==='nested-busy' ? "field.setAttribute('aria-busy','true');" : ''}
${kind==='nested-wrong-owner' ? "field.setAttribute('aria-controls','missing');" : ''}
${kind.startsWith('standalone') ? "field.removeAttribute('aria-controls');grid.innerHTML='<div role=row><div role=gridcell><button type=button>Calendar day</button></div></div>';if ('"+kind+"'!=='standalone')grid.innerHTML='<table role=grid><tbody><tr><td role=gridcell><span role=checkbox aria-checked=false tabindex=-1 aria-label=\"Calendar day\">20</span></td></tr></tbody></table>';if ('"+kind+"'!=='standalone')grid.removeAttribute('role');if ('"+kind+"'==='standalone-disabled')grid.querySelector('table').setAttribute('aria-disabled','true');grid.querySelector('button,[role=checkbox]').onmousedown=e=>{e.currentTarget.setAttribute('aria-checked','true');fetch('/picked?kind="+kind+"')};" : ''}
field.oninput=()=>{grid.hidden=false;field.setAttribute('aria-expanded','true')};
item.onmousedown=e=>{e.preventDefault();fetch('/picked?kind=${kind}');
${kind==='cross-document' ? "location.href='/result';" : `setTimeout(()=>{history.pushState({},'', '/selected');grid.hidden=true;field.setAttribute('aria-expanded','false');${kind==='url-only'?'':"get('display').textContent='350 Fifth Avenue Manhattan';"}},600);`}
};</script>`
const server=createServer((req,res)=>{const url=new URL(req.url,'http://x');if(url.pathname==='/picked'){const k=url.searchParams.get('kind');counts.set(k,(counts.get(k)??0)+1);res.end('ok');return}res.setHeader('Content-Type','text/html');res.end(url.pathname==='/result'?'<main>350 Fifth Avenue Manhattan</main>':fixture(url.searchParams.get('kind')??'light'))}).listen(0,'127.0.0.1');await once(server,'listening')
const origin=`http://127.0.0.1:${server.address().port}`
let browser
try {
 browser=await launchIsolated()
 for(const kind of ['duplicate-owner','wrong-popup','multi-row','multi-cell','disabled-cell','disabled-row','busy','rogue','hidden','late-disabled-cell','late-disabled-row','lost-role','rebound','nested','nested-busy','nested-wrong-owner','nested-shadow','late-inner','removed-root-child','standalone','standalone-checkbox','standalone-disabled','nested-checkbox','aggregate','aggregate-shadow','aggregate-slot','intermediate-multi-row','intermediate-rogue','owned-container']){
  const {tabId}=await browser.call('tabs',{action:'new',url:`${origin}/?kind=${kind}`})
  let p
  for(let i=0;i<30;i++){p=await browser.call('s1',{tabId,action:'agent_observe'});if(p.elements.some(e=>e.name==='Address'))break;await new Promise(r=>setTimeout(r,50))}
  const field=p.elements.find(e=>e.name==='Address');assert.ok(field)
  await browser.call('s1',{tabId,action:'agent_execute',op:'type',ref:field.ref,guard:field.guard,documentId:p.documentId,url:p.url,text:'350 Fifth Avenue Manhattan'})
  let after=await browser.call('s1',{tabId,action:'agent_observe'})
  let target=after.elements.find(e=>kind==='owned-container'?e.name==='Container owner':kind.startsWith('standalone')?e.name==='Calendar day':kind.startsWith('aggregate')?e.name==='All suggestions':kind.startsWith('nested')?e.name==='Nested action':kind.endsWith('rogue')?e.name==='Rogue':e.candidate||e.name==='Candidate wrapper');assert.ok(target,kind)
  const execute=t=>browser.call('s1',{tabId,action:'agent_execute',op:'click',ref:t.ref,guard:t.guard,documentId:after.documentId,url:after.url})
  let stale
  if(['hidden','late-disabled-cell','late-disabled-row','lost-role','rebound','late-inner','removed-root-child'].includes(kind)){
   const fixturePage=browser.context.pages().find(p=>p.url()===`${origin}/?kind=${kind}`);assert.ok(fixturePage)
   await fixturePage.evaluate(kind=>{
    if(kind==='hidden')document.querySelector('#grid').style.opacity='0'
    if(kind==='late-disabled-cell')document.querySelector('[role=gridcell]').setAttribute('aria-disabled','true')
    if(kind==='late-disabled-row')document.querySelector('[role=row]').setAttribute('aria-disabled','true')
    if(kind==='lost-role')document.querySelector('#grid').removeAttribute('role')
    if(kind==='rebound')document.querySelector('#field').setAttribute('aria-controls','missing')
    if(kind==='late-inner')document.querySelector('#wrapper').insertAdjacentHTML('beforeend','<div role=grid><button type=button>Nested action</button></div>')
    if(kind==='removed-root-child'){
      const grid=document.querySelector('#grid');grid.removeAttribute('role');grid.innerHTML='<button type=button>New descendant</button>'
      grid.querySelector('button').onmousedown=()=>fetch('/picked?kind=removed-root-child')
    }
   },kind)
   stale=await execute(target);assert.equal(stale.execution,'not_sent',kind+' old observation')
   after=await browser.call('s1',{tabId,action:'agent_observe'});target=after.elements.find(e=>kind==='late-inner'?e.name==='Nested action':kind==='removed-root-child'?e.name==='New descendant':e.ref===target.ref)
  }
  let rejected
  if(['standalone','standalone-checkbox','owned-container'].includes(kind)){
   assert.equal(target.popupMember,null);assert.equal(target.ref in targets(after).CLICK,true)
   const result=await execute(target);assert.equal(result.execution,'returned')
   await new Promise(r=>setTimeout(r,50));assert.equal(counts.get(kind),1)
   if(kind==='standalone-checkbox'){const checked=await browser.call('s1',{tabId,action:'agent_observe'});assert.equal(checked.elements.find(e=>e.ref===target.ref).checked,true)}
   records.push({kind,passed:true,clicks:1});await browser.call('tabs',{action:'close',tabId});continue
  }
  if(target){
   assert.equal(target.popupMember?.status,'rejected',kind)
   assert.equal(target.ref in targets(after).CLICK,false,kind+' must not be routed as ordinary click')
   rejected=await execute(target);assert.equal(rejected.execution,'not_sent',kind+' fresh observation')
  }else assert.equal(kind,'hidden')
  assert.equal(counts.get(kind)??0,0,kind+' zero side effects')
  records.push({kind,passed:true,stale,rejected,clicks:counts.get(kind)??0});await browser.call('tabs',{action:'close',tabId})
 }
 for(const kind of ['light','shadow','intermediate','intermediate-shadow','url-only','cross-document']){
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
  assert.equal(result.status,['light','shadow','intermediate','intermediate-shadow'].includes(kind)?'done':'blocked',JSON.stringify({kind,result}))
  if(!['light','shadow','intermediate','intermediate-shadow'].includes(kind))assert.equal(result.reason,'selection_unconfirmed')
 }
 console.log(JSON.stringify({passed:true,cases:records.length,liveJev:false}))
}finally{
 if(process.env.SELECTION_OUT){await mkdir(process.env.SELECTION_OUT,{recursive:true});await writeFile(`${process.env.SELECTION_OUT}/grid-cases.json`,JSON.stringify(records,null,2))}
 if(browser)await browser.close();await new Promise(r=>server.close(r))
}
