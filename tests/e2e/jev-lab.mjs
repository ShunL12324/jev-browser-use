// Mechanical fixture/extension test. No Jev request and no model-success claim.
import assert from 'node:assert/strict'
import { mkdtemp, cp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createLab } from '../../scripts/jev/lab.mjs'
import { connectBrowser } from '../../scripts/jev/mcp.mjs'
import { prepare, validateTask } from '../../scripts/jev/core.mjs'

const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? '/tmp/jev-browser-validation/node_modules/playwright/index.mjs').href)
const evidence=await mkdtemp(join(tmpdir(),'jev-lab-preflight-'))
console.log(JSON.stringify({event:'evidence_directory',path:evidence}))
const temp=await mkdtemp(join(tmpdir(),'jev-lab-mechanical-'))
let lab,browser,context
try {
  const reservation=createServer().listen(0,'127.0.0.1');await once(reservation,'listening')
  const port=reservation.address().port;await new Promise(r=>reservation.close(r))
  process.env.BROWSER_USE_PORT=String(port)
  const extension=join(temp,'extension'),root=fileURLToPath(new URL('../../',import.meta.url))
  await cp(join(root,'packages/extension/dist'),extension,{recursive:true})
  let replacements=0
  for(const file of await readdir(join(extension,'assets'))){
    if(!file.endsWith('.js'))continue
    const path=join(extension,'assets',file),text=await readFile(path,'utf8')
    replacements+=(text.match(/\b17329\b/g)??[]).length
    await writeFile(path,text.replace(/\b17329\b/g,String(port)))
  }
  assert.equal(replacements,1)
  lab=await createLab({port:0});const origin=`http://127.0.0.1:${lab.address().port}`
  browser=await connectBrowser()
  context=await chromium.launchPersistentContext(join(temp,'profile'),{channel:'chromium',executablePath:process.env.CHROMIUM_EXECUTABLE??'/home/shun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]})
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');assert.ok(worker.url().startsWith('chrome-extension://'))
  const reset=async(scenario,density,seed='round1')=> (await fetch(origin+'/reset',{method:'POST',body:JSON.stringify({scenario,density,seed})})).json()
  for(const seed of ['round1','round2','holdout']) for(const density of [8,64,180,120]){
    const session=await reset('A',density,seed),{tabId}=await browser.call('tabs',{action:'new',url:session.task.startUrl})
    // Opening a tab is not page readiness; extension navigate waits for load.
    await browser.call('navigate',{tabId,url:session.task.startUrl})
    const view=await browser.call('view',{tabId}),snapshot=await browser.call('snapshot',{tabId,limit:500})
    assert.equal(snapshot.interactables.filter(e=>!e.disabled).length,density)
    assert.ok(!view.content.includes(session.task.expectedText))
    assert.ok(!JSON.stringify(snapshot).includes(session.task.expectedText))
    let payloadBytes,resourceBoundary
    try {const p=prepare(validateTask(session.task),view,snapshot);payloadBytes=Buffer.byteLength(JSON.stringify({state:p.state,questions:p.questions}))}catch(e){resourceBoundary=e.code;payloadBytes=e.details?.payloadBytes;assert.equal(e.code,'PAGE_TOO_LARGE')}
    const metrics={event:'density_measured',seed,density,candidates:snapshot.interactables.length,payloadBytes,resourceBoundary}
    await writeFile(join(evidence,`${seed}-${density}.json`),JSON.stringify({task:session.task,view,snapshot,metrics},null,2))
    console.log(JSON.stringify(metrics))
    await browser.call('tabs',{action:'close',tabId})
  }
  const session=await reset('B',8),{tabId}=await browser.call('tabs',{action:'new',url:'about:blank'})
  await browser.call('navigate',{tabId,url:session.task.startUrl})
  const initialView=await browser.call('view',{tabId});assert.ok(!initialView.content.includes(session.task.expectedText))
  await writeFile(join(evidence,'B-initial.json'),JSON.stringify({task:session.task,view:initialView,snapshot:await browser.call('snapshot',{tabId,limit:500})},null,2))
  const snapshot=()=>browser.call('snapshot',{tabId,limit:500})
  const click=async name=>{const s=await snapshot(),e=s.interactables.find(e=>e.name===name&&!e.disabled);assert.ok(e,`Missing ${name}`);await browser.call('click',{tabId,ref:e.ref})}
  await click('Open Harbor release guide | Operations | v3')
  await click('Edit record')
  for(const [name,text]of[['Display name','River'],['Reviewer name','Riley']]){const s=await snapshot(),e=s.interactables.find(e=>e.name===name);assert.ok(e);await browser.call('type',{tabId,ref:e.ref,text,clear:true})}
  await click('Review changes');await click('Save')
  await browser.call('wait_for',{tabId,timeoutMs:600});await click('Close editor')
  const result=await(await fetch(origin+'/oracle/'+session.runId)).json();assert.equal(result.passed,true)
  const view=await browser.call('view',{tabId});assert.ok(view.content.includes(session.task.expectedText))
  console.log(JSON.stringify({event:'mechanical_fixture_pass',liveJev:false,runId:session.runId}))
}finally{
  await browser?.close();await context?.close();if(lab)await new Promise(r=>lab.close(r));await rm(temp,{recursive:true,force:true})
}
