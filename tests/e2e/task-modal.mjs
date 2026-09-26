// Real isolated extension: inactive ARIA dialogs must not hide form bindings;
// actual modality must still prevent execution, including across shadow roots.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { build } from '../../packages/bridge/src/agent/jev.mjs'

const cases = ['aria-hidden', 'ancestor-hidden', 'ancestor-opacity', 'shadow-hidden', 'native-nonmodal', 'visible-aria', 'visible-alert', 'offscreen-aria', 'native-modal', 'native-hidden-modal', 'shadow-inside', 'nested-modal', 'late-modal']
const blocked = new Set(['visible-aria', 'visible-alert', 'offscreen-aria', 'native-modal', 'native-hidden-modal', 'nested-modal'])
const fixture = kind => `<!doctype html><style>input{padding:12px} #panel{position:fixed;left:600px;top:20px;width:200px;height:100px;background:white}</style>
<label for=field>Address</label><input id=field><div id=host></div><script>
window.inputs=0;document.querySelector('#field').oninput=()=>window.inputs++;
const kind=${JSON.stringify(kind)}, host=document.querySelector('#host');
const root=kind.startsWith('shadow')?host.attachShadow({mode:'open'}):host;
const native=kind.startsWith('native');
root.innerHTML=native?'<dialog id=panel>Dialog</dialog>':'<div id=panel role=dialog aria-modal=true>Dialog</div>';
const panel=root.querySelector('#panel');panel.style.cssText='position:fixed;left:600px;top:20px;width:200px;height:100px;background:white';
if(kind==='aria-hidden'||kind==='shadow-hidden'||kind==='late-modal')panel.setAttribute('aria-hidden','true');
if(kind==='ancestor-hidden')host.setAttribute('aria-hidden','true');
if(kind==='ancestor-opacity')host.style.opacity=0;
if(kind==='visible-alert')panel.setAttribute('role','alertdialog');
if(kind==='offscreen-aria')panel.style.left='5000px';
if(kind==='native-nonmodal')panel.show();else if(native)panel.showModal();
if(kind==='native-hidden-modal')panel.style.opacity=0;
if(kind==='shadow-inside')panel.append(document.querySelector('label'),document.querySelector('#field'));
if(kind==='nested-modal'){panel.append(document.querySelector('label'),document.querySelector('#field'));panel.insertAdjacentHTML('beforeend','<div role=dialog aria-modal=true style="width:100px;height:40px">Inner dialog</div>');}
window.ready=true;</script>`
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fixture(new URL(req.url, 'http://x').searchParams.get('kind'))) }).listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`, records = []
let browser
try {
  browser = await launchIsolated()
  for (const kind of cases) {
    const url = `${origin}/?kind=${kind}`
    const { tabId } = await browser.call('tabs', { action: 'new', url })
    let fixturePage
    for (let i = 0; i < 40; i++) {
      fixturePage = browser.context.pages().find(p => p.url() === url)
      if (fixturePage && await fixturePage.evaluate(() => window.ready)) break
      await new Promise(r => setTimeout(r, 25))
    }
    assert.ok(fixturePage, kind)
    let page = await browser.call('s1', { tabId, action: 'agent_observe' })
    let field = page.elements.find(e => e.name === 'Address')
    assert.ok(field, kind)
    assert.equal(field.modalBlocked, blocked.has(kind), kind)
    const request = build(page, { goal: 'Fill Address and stop', inputs: { address: { value: 'Public landmark', purpose: 'address' } } }, [])
    assert.equal(!!request.binds.bind_1?.candidates[field.ref], !blocked.has(kind), kind)
    if (blocked.has(kind)) {
      assert.ok(request.payload.state.baseTargetExclusions.modal_blocked)
      assert.ok(request.payload.state.elements.find(e => e.id === field.ref).modalBlockers.length)
    }
    const execute = () => browser.call('s1', { tabId, action: 'agent_execute', documentId: page.documentId, url: page.url, ref: field.ref, guard: field.guard, op: 'type', text: 'Public landmark' })
    let stale
    if (kind === 'late-modal') {
      await fixturePage.evaluate(() => document.querySelector('#panel').removeAttribute('aria-hidden'))
      stale = await execute()
      assert.equal(stale.execution, 'not_sent')
      page = await browser.call('s1', { tabId, action: 'agent_observe' })
      field = page.elements.find(e => e.ref === field.ref)
      assert.equal(field.modalBlocked, true)
    }
    const result = await execute(), denied = blocked.has(kind) || kind === 'late-modal'
    assert.equal(result.execution, denied ? 'not_sent' : 'returned', kind)
    assert.equal(await fixturePage.evaluate(() => window.inputs), denied ? 0 : 1, kind)
    records.push({ kind, passed: true, modalBlocked: field.modalBlocked, blockers: field.modalBlockers, stale, result, inputEvents: denied ? 0 : 1 })
    await browser.call('tabs', { action: 'close', tabId })
  }
  console.log(JSON.stringify({ passed: true, cases: records.length, liveJev: false }))
} finally {
  if (process.env.SELECTION_OUT) { await mkdir(process.env.SELECTION_OUT, { recursive: true }); await writeFile(`${process.env.SELECTION_OUT}/modal-cases.json`, JSON.stringify(records, null, 2)) }
  if (browser) await browser.close()
  await new Promise(r => server.close(r))
}
