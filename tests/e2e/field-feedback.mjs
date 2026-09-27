import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { InputFeedback } from '../../packages/bridge/src/agent/input-feedback.mjs'
const kinds = ['native-pattern','native-length','aria-invalid','described','errormessage','old-help','new-help','reveal','hidden','duplicate','wrong-field','wrong-root','shadow','slot-hidden','replace','shared','clear','not-sent','redirect','long-text','long-attribute']
const fixture = kind => `<!doctype html><style>input,textarea{padding:12px}#host{margin:20px}</style><div id=host></div><script>
const kind=${JSON.stringify(kind)},host=document.querySelector('#host'),root=kind==='shadow'?host.attachShadow({mode:'open'}):host;
root.innerHTML='<input aria-label="Address" role="combobox" id=f><div id=messages></div>';
const f=root.querySelector('#f'),messages=root.querySelector('#messages');window.f=f;window.inputs=0;window.invalids=0;f.addEventListener('invalid',()=>window.invalids++);
const source=kind==='errormessage'?'aria-errormessage':'aria-describedby';f.setAttribute(source,'hint');
const add=()=>{const p=document.createElement('p');p.id='hint';p.textContent=kind==='new-help'?'5 characters entered':'Input feedback';messages.append(p);return p;};
if(['old-help','reveal','replace','clear'].includes(kind)){const p=add();if(kind==='reveal')p.hidden=true;}
if(kind==='native-pattern'){f.pattern='[A-Z]{3}';f.required=true;}
if(kind==='native-length')f.maxLength=3;
if(kind==='wrong-root'){const h=document.createElement('div');root.append(h);h.attachShadow({mode:'open'}).innerHTML='<p id=hint>Other root feedback</p>';}
if(kind==='long-attribute')f.setAttribute('aria-describedby','x'.repeat(2100));
if(kind==='shared'){const other=document.createElement('input');other.setAttribute('aria-describedby','hint');root.append(other);}
if(kind==='redirect'){f.style.cssText='position:absolute;top:40px;left:40px;width:240px;height:30px';const overlay=document.createElement('textarea');overlay.setAttribute('aria-label','Actual');overlay.style.cssText=f.style.cssText+';z-index:2';root.append(overlay);overlay.oninput=()=>window.inputs++;}
f.addEventListener('input',()=>{window.inputs++;
 if(kind==='aria-invalid')f.setAttribute('aria-invalid','true');
 if(['described','errormessage','new-help','shadow','shared'].includes(kind))add();
 if(kind==='reveal')root.querySelector('#hint').hidden=false;
 if(kind==='hidden'){const p=add();p.hidden=true;}
 if(kind==='duplicate'){add();add();}
 if(kind==='wrong-field'){f.removeAttribute(source);add();}
 if(kind==='slot-hidden'){const h=document.createElement('div');root.append(h);h.attachShadow({mode:'open'}).innerHTML='<slot name=feedback style="display:none"></slot>';const p=add();p.slot='feedback';h.append(p);}
 if(kind==='replace'){root.querySelector('#hint').remove();add();}
 if(kind==='long-text'){const p=add();p.textContent='x'.repeat(1000);const b=document.createElement('span');b.textContent='remaining text';p.append(b);}
 if(kind==='clear')root.querySelector('#hint').textContent='Changed feedback';
});window.ready=true;</script>`
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture(new URL(req.url,'http://x').searchParams.get('kind')??'described'))}).listen(0,'127.0.0.1');await once(server,'listening')
const records=[];let browser
try {
 browser=await launchIsolated()
 for(const kind of kinds){
  const url=`http://127.0.0.1:${server.address().port}/?kind=${kind}`,{tabId}=await browser.call('tabs',{action:'new',url})
  let fixturePage
  for(let i=0;i<40;i++){fixturePage=browser.context.pages().find(p=>p.url()===url);if(fixturePage&&await fixturePage.evaluate(()=>window.ready))break;await new Promise(r=>setTimeout(r,25))}
  const before=await browser.call('s1',{tabId,action:'agent_observe'}),field=before.elements.find(e=>e.name==='Address')
  assert.ok(field,kind);assert.equal(before.agentProtocol,8)
  if(kind==='not-sent')await fixturePage.evaluate(()=>window.f.setAttribute('aria-describedby','changed'))
  const result=await browser.call('s1',{tabId,action:'agent_execute',documentId:before.documentId,url:before.url,ref:field.ref,guard:field.guard,op:'type',text:'ABCDE'})
  if(kind==='not-sent'){
   assert.equal(result.execution,'not_sent');assert.equal(result.inputReceipt,undefined);assert.equal(await fixturePage.evaluate(()=>window.inputs),0)
   records.push({kind,result,passed:true});await browser.call('tabs',{action:'close',tabId});continue
  }
  assert.equal(result.execution,'returned',kind);assert.ok(result.inputReceipt,kind)
  const after=await browser.call('s1',{tabId,action:'agent_observe'}),m=new InputFeedback();m.begin(result.inputReceipt,'address');m.observe(after,[])
  const rejected=['native-pattern','aria-invalid'].includes(kind)
  const unresolved=['described','errormessage','new-help','reveal','shadow','replace','shared','clear','redirect'].includes(kind)
  assert.equal(after.inputFeedback[0]?.status??null,rejected?'input_rejected':unresolved?'input_feedback_unresolved':null,kind)
  assert.equal(await fixturePage.evaluate(()=>window.inputs),1,kind);assert.equal(await fixturePage.evaluate(()=>window.invalids),0,kind)
  const observed=after.elements.find(e=>e.ref===result.inputReceipt.ref)
  if(kind==='native-length'){assert.equal(observed.fieldFeedback.constraints.maxLength,3);assert.equal(observed.value,'ABCDE');assert.equal(observed.fieldFeedback.native.validity.tooLong,false)}
  if(kind==='long-text')assert.equal(observed.fieldFeedback.descriptions[0].complete,false)
  if(kind==='long-attribute')assert.equal(observed.fieldFeedback.descriptions[0].status,'attribute_too_long')
  if(kind==='duplicate')assert.equal(observed.fieldFeedback.descriptions[0].status,'ambiguous')
  if(kind==='wrong-root')assert.equal(observed.fieldFeedback.descriptions[0].status,'missing')
  if(kind==='slot-hidden')assert.equal(observed.fieldFeedback.descriptions[0].status,'hidden')
  if(kind==='redirect'){assert.notEqual(result.inputReceipt.ref,field.ref);assert.equal(observed.name,'Actual')}
  let cleared
  if(kind==='clear'){
   await fixturePage.evaluate(()=>window.f.parentElement.querySelector('#hint').remove())
   cleared=await browser.call('s1',{tabId,action:'agent_observe'});m.observe(cleared,[])
   assert.equal(cleared.inputFeedback[0].evidenceCurrent,false);assert.equal(cleared.inputFeedback[0].status,'input_feedback_unresolved')
  }
  records.push({kind,passed:true,before:field.fieldFeedback,result,after:observed.fieldFeedback,feedback:after.inputFeedback,cleared:cleared?.inputFeedback})
  await browser.call('tabs',{action:'close',tabId})
 }
 console.log(JSON.stringify({passed:true,cases:records.length,liveJev:false}))
}finally{
 if(process.env.SELECTION_OUT){await mkdir(process.env.SELECTION_OUT,{recursive:true});await writeFile(`${process.env.SELECTION_OUT}/field-feedback.json`,JSON.stringify(records,null,2))}
 if(browser)await browser.close();await new Promise(r=>server.close(r))
}
