// Real isolated extension: verify retained DOM associations, not model accuracy.
import { createServer } from 'node:http'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
const cases = ['valid', 'shadow-valid', 'close-only', 'move-owner', 'relabel', 'labelledby', 'duplicate-label', 'duplicate-owner', 'replace-list', 'controls', 'second-owner', 'shadow-opacity', 'shadow-hidden', 'slot-hidden']
const fixture = kind => `<!doctype html><style>button,input{padding:10px;margin:8px}</style><div id=host></div><script>
const host=document.querySelector('#host'), root=${kind.startsWith('shadow') ? "host.attachShadow({mode:'open'})" : 'host'};
root.innerHTML='<div id="scope"><label id="label" for="field">School</label><input id="field" role="combobox" aria-labelledby="label" aria-controls="list" aria-expanded="true" value="Example University"><span id="display"></span></div><div id="list" role="listbox"><button type="button" role="option">Example University</button></div><div id="other"></div>';
const get=id=>root.querySelector('#'+id), field=get('field'), list=get('list');
list.firstChild.onmousedown=e=>{e.preventDefault();field.style.opacity='0';field.setAttribute('aria-expanded','false');list.hidden=true;
${kind === 'close-only' ? '' : "get('display').textContent='Example University';"}
${kind === 'move-owner' ? "get('other').append(field);" : ''}
${kind === 'relabel' ? "get('label').htmlFor='other';" : ''}
${kind === 'labelledby' ? "field.setAttribute('aria-labelledby','other');" : ''}
${kind === 'duplicate-label' ? "get('other').append(get('label').cloneNode(true));" : ''}
${kind === 'duplicate-owner' ? "get('other').append(field.cloneNode(true));" : ''}
${kind === 'replace-list' ? "list.replaceWith(list.cloneNode(true));" : ''}
${kind === 'controls' ? "field.setAttribute('aria-controls','other');" : ''}
${kind === 'second-owner' ? "get('other').setAttribute('aria-controls','list');" : ''}
${kind === 'shadow-opacity' ? "host.style.opacity='0';" : ''}
${kind === 'slot-hidden' ? "host.attachShadow({mode:'open'}).innerHTML='<slot style=opacity:0></slot>';" : ''}
${kind === 'shadow-hidden' ? "host.setAttribute('aria-hidden','true');" : ''}
};</script>`
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture(new URL(req.url,'http://x').searchParams.get('case') ?? 'valid'))}).listen(0,'127.0.0.1');await once(server,'listening')
let browser;const records=[]
try {
 browser=await launchIsolated()
 for(const kind of cases){
  const {tabId}=await browser.call('tabs',{action:'new',url:`http://127.0.0.1:${server.address().port}/?case=${kind}`})
  let before
  for(let i=0;i<30;i++){before=await browser.call('s1',{tabId,action:'agent_observe'});if(before.elements.some(e=>e.role==='option'))break;await new Promise(r=>setTimeout(r,100))}
  const option=before.elements.find(e=>e.role==='option');assert.ok(option,kind)
  const execution=await browser.call('s1',{tabId,action:'agent_execute',op:'click',ref:option.ref,guard:option.guard,documentId:before.documentId,url:before.url})
  assert.equal(execution.execution,'returned',kind)
  const after=await browser.call('s1',{tabId,action:'agent_observe'})
  const witness=after.selectionWitnesses[0];assert.ok(witness,kind)
  assert.equal(witness.committed,kind==='valid'||kind==='shadow-valid',kind)
  records.push({kind,witness});console.log(JSON.stringify({kind,passed:true}))
  await browser.call('tabs',{action:'close',tabId})
 }
} finally {
 if(process.env.SELECTION_OUT){await mkdir(process.env.SELECTION_OUT,{recursive:true});await writeFile(`${process.env.SELECTION_OUT}/association-cases.json`,JSON.stringify(records,null,2))}
 if(browser)await browser.close();await new Promise(r=>server.close(r))
}
