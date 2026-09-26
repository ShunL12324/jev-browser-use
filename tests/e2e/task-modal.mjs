// Real isolated extension: inactive ARIA dialogs must not hide form bindings;
// actual modality must still prevent execution, including across shadow roots.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { launchIsolated } from '../../scripts/jev/task-browser.mjs'
import { build } from '../../packages/bridge/src/agent/jev.mjs'

const cases = ['aria-hidden', 'ancestor-hidden', 'ancestor-opacity', 'shadow-hidden', 'native-nonmodal', 'visible-aria', 'visible-alert', 'offscreen-aria', 'native-modal', 'native-hidden-modal', 'native-inert-ancestor', 'native-inert-self', 'native-aria-inner', 'shadow-inside', 'nested-modal', 'late-modal']
const blocked = new Set(['visible-aria', 'visible-alert', 'offscreen-aria', 'native-modal', 'native-hidden-modal', 'native-aria-inner', 'nested-modal'])
const requested = process.env.MODAL_VARIANTS?.split(',')
const stackedFixture = kind => `<!doctype html><input aria-label=Background id=background><div id=host></div><script>
window.inputs={A:0,B:0,Background:0};document.querySelector('#background').oninput=()=>window.inputs.Background++;
const kind=${JSON.stringify(kind)}, host=document.querySelector('#host'), root=kind==='stack-shadow'?host.attachShadow({mode:'open'}):host;
root.innerHTML='<style>dialog{width:320px;height:150px}input{padding:12px}</style><dialog id=a><input aria-label=A></dialog><dialog id=b><input aria-label=B></dialog>';
window.fixtureStyle=root.querySelector('style');
const a=root.querySelector('#a'),b=root.querySelector('#b');a.querySelector('input').oninput=()=>window.inputs.A++;b.querySelector('input').oninput=()=>window.inputs.B++;
if(kind.startsWith('stack-nested'))a.append(b);
const order=kind.endsWith('reverse')?[b,a]:[a,b];window.lower=order[0];window.upper=order[1];
window.openUpper=()=>{if(kind==='stack-nested-reverse')a.close();order[1].showModal();if(kind==='stack-hidden')order[1].style.display='none';if(kind==='stack-no-hit'){root.querySelector('style').textContent+='dialog,dialog::backdrop{pointer-events:none}';}if(kind==='stack-aria-behind')document.body.insertAdjacentHTML('beforeend','<div role=dialog aria-modal=true style="width:100px;height:80px">Old ARIA panel</div>');};
if(kind==='stack-nested-reverse')a.show();order[0].showModal();window.ready=true;</script>`
const fixture = kind => kind.startsWith('stack-') ? stackedFixture(kind) : `<!doctype html><style>input{padding:12px} #panel{position:fixed;left:600px;top:20px;width:200px;height:100px;background:white}</style>
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
if(kind.startsWith('native-inert')){panel.append(document.querySelector('label'),document.querySelector('#field'));(kind==='native-inert-self'?panel:host).setAttribute('inert','');}
if(kind==='native-aria-inner'){panel.append(document.querySelector('label'),document.querySelector('#field'));panel.insertAdjacentHTML('beforeend','<div role=dialog aria-modal=true style="width:100px;height:40px">Nested ARIA modal</div>');}
if(kind==='shadow-inside')panel.append(document.querySelector('label'),document.querySelector('#field'));
if(kind==='nested-modal'){panel.append(document.querySelector('label'),document.querySelector('#field'));panel.insertAdjacentHTML('beforeend','<div role=dialog aria-modal=true style="width:100px;height:40px">Inner dialog</div>');}
window.ready=true;</script>`
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fixture(new URL(req.url, 'http://x').searchParams.get('kind') ?? 'aria-hidden')) }).listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`, records = []
let browser
try {
  browser = await launchIsolated()
  for (const kind of cases.filter(k => !requested || requested.includes(k))) {
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
    assert.equal(!!request.binds.bind_1?.candidates[field.ref], !blocked.has(kind) && kind !== 'native-inert-self', kind)
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
    const result = await execute(), denied = blocked.has(kind) || kind === 'late-modal' || kind === 'native-inert-self'
    assert.equal(result.execution, denied ? 'not_sent' : 'returned', kind)
    assert.equal(await fixturePage.evaluate(() => window.inputs), denied ? 0 : 1, kind)
    records.push({ kind, passed: true, modalBlocked: field.modalBlocked, blockers: field.modalBlockers, stale, result, inputEvents: denied ? 0 : 1 })
    await browser.call('tabs', { action: 'close', tabId })
  }
  for (const kind of ['stack-forward', 'stack-reverse', 'stack-shadow', 'stack-hidden', 'stack-no-hit', 'stack-aria-behind', 'stack-nested-forward', 'stack-nested-reverse'].filter(k => !requested || requested.includes(k))) {
    const url = `${origin}/?kind=${kind}`, { tabId } = await browser.call('tabs', { action: 'new', url })
    let fixturePage
    for (let i = 0; i < 40; i++) {
      fixturePage = browser.context.pages().find(p => p.url() === url)
      if (fixturePage && await fixturePage.evaluate(() => window.ready)) break
      await new Promise(r => setTimeout(r, 25))
    }
    assert.ok(fixturePage, kind)
    const lowerName = kind.endsWith('reverse') ? 'B' : 'A', upperName = lowerName === 'A' ? 'B' : 'A'
    const before = await browser.call('s1', { tabId, action: 'agent_observe' })
    const oldLower = before.elements.find(e => e.name === lowerName)
    assert.equal(oldLower.modalBlocked, false)
    await fixturePage.evaluate(() => window.openUpper())
    const page = await browser.call('s1', { tabId, action: 'agent_observe' })
    const execute = (p, e) => browser.call('s1', { tabId, action: 'agent_execute', documentId: p.documentId, url: p.url, ref: e.ref, guard: e.guard, op: 'type', text: 'Checked value' })
    const stale = await execute(before, oldLower)
    assert.equal(stale.execution, 'not_sent', kind + ' old lower guard')
    const lower = page.elements.find(e => e.name === lowerName), background = page.elements.find(e => e.name === 'Background'), upper = page.elements.find(e => e.name === upperName)
    assert.equal(lower.modalBlocked, true, kind + ' lower blocked')
    assert.equal(background.modalBlocked, true, kind + ' background blocked')
    const lowerAttempt = await execute(page, lower), backgroundAttempt = await execute(page, background)
    assert.equal(lowerAttempt.execution, 'not_sent'); assert.equal(backgroundAttempt.execution, 'not_sent')
    const uncertain = ['stack-hidden', 'stack-no-hit'].includes(kind) || kind.startsWith('stack-nested')
    let upperAttempt
    if (upper) {
      assert.equal(upper.modalBlocked, uncertain, kind + ' upper state')
      upperAttempt = await execute(page, upper)
      assert.equal(upperAttempt.execution, uncertain ? 'not_sent' : 'returned', kind)
    } else assert.equal(kind, 'stack-hidden')
    const afterUpper = await fixturePage.evaluate(() => window.inputs)
    assert.equal(afterUpper[lowerName], 0); assert.equal(afterUpper.Background, 0)
    assert.equal(afterUpper[upperName], uncertain ? 0 : 1)
    await fixturePage.evaluate(kind => { window.upper.close(); if(kind==='stack-nested-reverse')window.upper.show(); document.querySelector('[role=dialog]')?.remove(); }, kind)
    // Remove pointer-events test styling only after verifying the unknown-order
    // refusal; the lower dialog is again physically interactive on restoration.
    if (kind === 'stack-no-hit') await fixturePage.evaluate(() => window.fixtureStyle.textContent = 'dialog{width:320px;height:150px}input{padding:12px}')
    const restored = await browser.call('s1', { tabId, action: 'agent_observe' })
    const restoredLower = restored.elements.find(e => e.name === lowerName)
    assert.equal(restoredLower.modalBlocked, false, kind + ' lower restored')
    const restoredAttempt = await execute(restored, restoredLower)
    if (restoredAttempt.execution !== 'returned') {
      const diagnostic = await fixturePage.evaluate(() => {
        const input = window.lower.querySelector('input'), rect = input.getBoundingClientRect()
        return { styles: [...document.querySelectorAll('style')].map(s => s.textContent), inputPointer: getComputedStyle(input).pointerEvents, lowerPointer: getComputedStyle(window.lower).pointerEvents, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML, modals: [...document.querySelectorAll(':modal')].map(d => d.id) }
      })
      records.push({ kind, passed: false, restoredAttempt, restoredLower, diagnostic })
    }
    assert.equal(restoredAttempt.execution, 'returned', kind + ' restored input')
    const inputEvents = await fixturePage.evaluate(() => window.inputs)
    assert.equal(inputEvents[lowerName], 1); assert.equal(inputEvents.Background, 0)
    let reopenedStale
    if (kind === 'stack-forward') {
      const beforeReopen = await browser.call('s1', { tabId, action: 'agent_observe' })
      await fixturePage.evaluate(() => window.upper.showModal())
      reopenedStale = await execute(beforeReopen, beforeReopen.elements.find(e => e.name === lowerName))
      assert.equal(reopenedStale.code, 'STALE_REF', 'reopening with unchanged DOM text invalidates modal guard')
      assert.deepEqual(await fixturePage.evaluate(() => window.inputs), inputEvents)
    }
    records.push({ kind, passed: true, stale, lowerAttempt, backgroundAttempt, upperAttempt, restoredAttempt, reopenedStale, inputEvents })
    await browser.call('tabs', { action: 'close', tabId })
  }
  console.log(JSON.stringify({ passed: true, cases: records.length, liveJev: false }))
} finally {
  if (process.env.SELECTION_OUT) { await mkdir(process.env.SELECTION_OUT, { recursive: true }); await writeFile(`${process.env.SELECTION_OUT}/modal-cases.json`, JSON.stringify(records, null, 2)) }
  if (browser) await browser.close()
  await new Promise(r => server.close(r))
}
