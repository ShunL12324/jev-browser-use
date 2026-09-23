// Web components: <ws-settings> (open shadow root with ARIA tabs, switch and
// keyboard slider, plus nested <ws-select> with its own shadow root) and
// <ws-recovery> (closed shadow root).
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

class WsSelect extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' }), options = JSON.parse(this.getAttribute('options')), label = this.getAttribute('label')
    this.value = this.getAttribute('value') || options[0]
    root.innerHTML = `<style>ul{list-style:none;margin:4px 0;padding:4px;border:1px solid #89a;max-height:180px;overflow:auto;background:#fff}li{padding:4px 8px;cursor:pointer}li[aria-selected=true]{background:#dde}</style>
      <span id="l">${label}</span> <button type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="l v"><span id="v">${this.value}</span></button>
      <ul role="listbox" aria-labelledby="l" hidden>${options.map(o => `<li role="option" aria-selected="${o === this.value}">${o}</li>`).join('')}</ul>`
    const button = root.querySelector('button'), list = root.querySelector('ul')
    button.addEventListener('click', () => { list.hidden = !list.hidden; button.setAttribute('aria-expanded', String(!list.hidden)) })
    for (const li of list.children) li.addEventListener('click', () => {
      this.value = li.textContent; root.getElementById('v').textContent = this.value
      for (const o of list.children) o.setAttribute('aria-selected', String(o === li))
      list.hidden = true; button.setAttribute('aria-expanded', 'false')
      this.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    })
  }
}
customElements.define('ws-select', WsSelect)

class WsSettings extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' }), saved = JSON.parse(this.getAttribute('saved') || '{}'), zones = this.getAttribute('timezones')
    const state = { digest: saved.digest ?? false, volume: saved.volume ?? 50, timezone: saved.timezone ?? 'UTC', tab: 'profile' }
    root.innerHTML = `<style>[role=tablist]{display:flex;gap:4px;border-bottom:1px solid #aab}[role=tab]{padding:8px 14px;border:0;background:none;font:inherit}[role=tab][aria-selected=true]{border-bottom:3px solid #0f3d56;font-weight:700}
      [role=tabpanel]{padding:16px 4px}[role=switch]{padding:4px 12px;font:inherit}[role=switch][aria-checked=true]{background:#0f3d56;color:#fff}.track{width:240px;height:8px;background:#ccd;border-radius:4px;position:relative;margin:14px 0}
      .thumb{position:absolute;top:-6px;width:20px;height:20px;border-radius:50%;background:#0f3d56;transform:translateX(-50%)}.thumb:focus{outline:3px solid #f90}</style>
      <div role="tablist" aria-label="Settings sections">
        <button role="tab" id="t-profile" aria-controls="p-profile" aria-selected="true" tabindex="0">Profile</button>
        <button role="tab" id="t-notifications" aria-controls="p-notifications" aria-selected="false" tabindex="-1">Notifications</button>
        <button role="tab" id="t-region" aria-controls="p-region" aria-selected="false" tabindex="-1">Region</button></div>
      <div role="tabpanel" id="p-profile" aria-labelledby="t-profile"><p>Display name: Workspace member</p></div>
      <div role="tabpanel" id="p-notifications" aria-labelledby="t-notifications" hidden>
        <p><span id="dl">Weekly digest email</span> <button type="button" role="switch" aria-labelledby="dl" aria-checked="${state.digest}">${state.digest ? 'On' : 'Off'}</button></p>
        <p id="vl">Notification volume</p><div class="track"><div class="thumb" role="slider" tabindex="0" aria-labelledby="vl" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${state.volume}" aria-valuetext="${state.volume}%" style="left:${state.volume}%"></div></div>
        <p><small>Use the arrow keys to adjust the volume in steps of 10.</small></p></div>
      <div role="tabpanel" id="p-region" aria-labelledby="t-region" hidden><ws-select label="Time zone" options='${zones}' value="${state.timezone}"></ws-select></div>
      <button type="button" id="save">Save settings</button> <span id="status" role="status"></span>`
    const tabs = [...root.querySelectorAll('[role=tab]')]
    const select = tab => {
      for (const t of tabs) { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; root.getElementById(t.getAttribute('aria-controls')).hidden = !on }
      state.tab = tab.id.slice(2); tab.focus()
    }
    for (const t of tabs) {
      t.addEventListener('click', () => select(t))
      t.addEventListener('keydown', e => { const i = tabs.indexOf(t); if (e.key === 'ArrowRight') select(tabs[(i + 1) % tabs.length]); if (e.key === 'ArrowLeft') select(tabs[(i + tabs.length - 1) % tabs.length]) })
    }
    const sw = root.querySelector('[role=switch]')
    sw.addEventListener('click', () => { state.digest = !state.digest; sw.setAttribute('aria-checked', String(state.digest)); sw.textContent = state.digest ? 'On' : 'Off' })
    const thumb = root.querySelector('[role=slider]')
    thumb.addEventListener('keydown', e => {
      const delta = { ArrowRight: 10, ArrowUp: 10, ArrowLeft: -10, ArrowDown: -10 }[e.key]
      if (e.key === 'Home') state.volume = 0; else if (e.key === 'End') state.volume = 100; else if (delta) state.volume = Math.max(0, Math.min(100, state.volume + delta)); else return
      e.preventDefault(); thumb.setAttribute('aria-valuenow', String(state.volume)); thumb.setAttribute('aria-valuetext', state.volume + '%'); thumb.style.left = state.volume + '%'
    })
    root.querySelector('ws-select').addEventListener('change', e => { state.timezone = e.target.value })
    root.getElementById('save').addEventListener('click', async () => {
      const r = await post('/api/settings', state)
      root.getElementById('status').textContent = r.ok ? 'Settings saved.' : 'Could not save settings.'
    })
  }
}
customElements.define('ws-settings', WsSettings)

class WsRecovery extends HTMLElement {
  connectedCallback() {
    // Closed root: page scripts cannot reach inside via element.shadowRoot.
    const root = this.attachShadow({ mode: 'closed' })
    root.innerHTML = `<label>Recovery email <input type="email" name="recovery"></label><button type="button">Save recovery email</button><p role="status"></p>`
    root.querySelector('button').addEventListener('click', async () => {
      const r = await post('/api/recovery', { email: root.querySelector('input').value }), j = await r.json()
      root.querySelector('p').textContent = r.ok ? 'Recovery email saved.' : j.error
    })
  }
}
customElements.define('ws-recovery', WsRecovery)
