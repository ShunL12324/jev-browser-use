// Partner origin (different port = different origin). Provides the
// cross-origin booking iframe and the OAuth-style authorization popup used by
// the workspace site. No cookies: the workspace run id travels in the URL, so
// third-party cookie policies cannot change behavior.
import express from 'express'
import { esc } from '../../lib/common.mjs'

export const PARTNER_ACCOUNTS = { atlas: { username: 'avery.ops', password: 'Tide-8841' }, birch: { username: 'quinn.ops', password: 'Reef-3307' } }
export const ROOMS = ['Cedar', 'Harbor', 'Summit', 'Willow']
export const SLOTS = ['09:00', '10:30', '13:00', '14:30', '16:00']

export function createPartner({ workspaceOrigin }) {
  const app = express(), store = { runs: new Map(), resolve: null }
  app.use(express.json(), express.urlencoded({ extended: false }))
  // The workspace registers its runs here so both origins share one run id.
  const run = req => store.resolve?.(String(req.query.run ?? req.body?.run ?? ''))
  const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`

  app.get('/embed/rooms', (req, res) => {
    const r = run(req)
    if (!r) return res.status(404).send(shell('Unknown run', '<p>Unknown run.</p>'))
    res.setHeader('Content-Security-Policy', `frame-ancestors ${workspaceOrigin}`)
    res.send(shell('Room booking', `<main><h1>Book a meeting room</h1><p class="note">Provided by Partner Rooms</p>
      <form id="f"><label>Room <select name="room" required><option value="">Choose a room</option>${ROOMS.map(x => `<option>${x}</option>`).join('')}</select></label>
      <label>Date <input type="date" name="date" min="2026-10-05" max="2026-12-18" required></label>
      <fieldset><legend>Time slot</legend><div class="slots">${SLOTS.map(s => `<button type="button" class="slot" aria-pressed="false" data-slot="${s}">${s}</button>`).join('')}</div></fieldset>
      <label>Attendees <input type="number" name="attendees" min="1" max="12" value="2"></label>
      <button type="submit">Book room</button></form><p id="msg" role="status"></p>
      <div id="confirm" role="dialog" aria-modal="true" aria-labelledby="ct" hidden><h2 id="ct">Confirm booking</h2><p id="summary"></p><p>Bookings are charged to your team and cannot be cancelled online.</p>
        <button type="button" id="yes">Confirm booking</button> <button type="button" id="no">Go back</button></div></main>
      <script>
        const run = ${JSON.stringify(r.id)}, f = document.getElementById('f'); let slot = ''
        for (const b of document.querySelectorAll('.slot')) b.onclick = () => { slot = b.dataset.slot; for (const o of document.querySelectorAll('.slot')) o.setAttribute('aria-pressed', String(o === b)) }
        f.onsubmit = e => { e.preventDefault(); const d = new FormData(f); if (!slot) { msg.textContent = 'Choose a time slot.'; return }
          summary.textContent = d.get('room') + ' on ' + d.get('date') + ' at ' + slot + ' for ' + d.get('attendees') + ' people'; document.getElementById('confirm').hidden = false }
        no.onclick = () => { document.getElementById('confirm').hidden = true }
        yes.onclick = async () => { const d = new FormData(f); const r = await fetch('/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run, room: d.get('room'), date: d.get('date'), slot, attendees: Number(d.get('attendees')) }) })
          const j = await r.json(); document.getElementById('confirm').hidden = true; msg.textContent = r.ok ? 'Booked. Reference ' + j.reference : j.error }
      </script>`))
  })
  app.post('/api/book', (req, res) => {
    const r = run(req), b = req.body ?? {}
    if (!r) return res.status(404).json({ error: 'Unknown run' })
    if (!ROOMS.includes(b.room) || !/^2026-(1[0-2])-\d{2}$/.test(b.date ?? '') || !SLOTS.includes(b.slot)) return res.status(400).json({ error: 'Incomplete booking.' })
    const booking = { reference: 'PR-' + Math.floor(1000 + Math.random() * 9000), room: b.room, date: b.date, slot: b.slot, attendees: b.attendees }
    ;(r.state.bookings ??= []).push(booking)
    r.commits.push({ kind: 'book_room', detail: booking, at: Date.now() })
    res.json(booking)
  })

  // OAuth-like popup: login, consent, then postMessage to the opener.
  app.get('/oauth/authorize', (req, res) => {
    const r = run(req)
    if (!r) return res.status(404).send(shell('Unknown run', '<p>Unknown run.</p>'))
    const signedIn = r.state.partnerSignedIn
    res.send(shell('Partner Rooms · Authorize', `<main><h1>Partner Rooms</h1>${signedIn ? `<p>Tidewater Workspace wants to view and create room bookings for <strong>${esc(r.state.partnerUser)}</strong>.</p>
      <form method="post" action="/oauth/consent"><input type="hidden" name="run" value="${r.id}"><button name="decision" value="allow">Allow access</button> <button name="decision" value="deny">Cancel</button></form>`
      : `${req.query.error ? '<p class="error" role="alert">Incorrect username or password.</p>' : ''}<form method="post" action="/oauth/login"><input type="hidden" name="run" value="${r.id}">
      <label>Username <input name="username" autocomplete="username"></label><label>Password <input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>`}</main>`))
  })
  app.post('/oauth/login', (req, res) => {
    const r = run(req); if (!r) return res.status(404).send('Unknown run')
    const a = PARTNER_ACCOUNTS[r.seed]
    if (req.body.username !== a.username || req.body.password !== a.password) return res.redirect(303, `/oauth/authorize?run=${r.id}&error=1`)
    r.state.partnerSignedIn = true; r.state.partnerUser = a.username
    res.redirect(303, `/oauth/authorize?run=${r.id}`)
  })
  app.post('/oauth/consent', (req, res) => {
    const r = run(req); if (!r) return res.status(404).send('Unknown run')
    const allow = req.body.decision === 'allow'
    if (allow) r.state.partnerAuthorized = true
    res.send(shell('Done', `<p>${allow ? 'Access granted. You can close this window.' : 'Cancelled.'}</p><script>
      window.opener?.postMessage(${JSON.stringify({ type: 'partner-oauth', allow, user: allow ? r.state.partnerUser : null })}, ${JSON.stringify(workspaceOrigin)}); setTimeout(() => window.close(), 400)</script>`))
  })
  return { app, store }
}

const CSS = `body{font-family:system-ui,sans-serif;margin:0;padding:18px;color:#222}label{display:flex;flex-direction:column;gap:4px;margin:10px 0;max-width:280px;font-weight:600}
input,select,button{font:inherit;padding:7px}.slots{display:flex;gap:6px;flex-wrap:wrap}button[aria-pressed=true]{background:#1f5f8b;color:#fff}.error{color:#b00}
[role=dialog]{position:fixed;inset:10% 8%;background:#fff;border:2px solid #1f5f8b;border-radius:10px;padding:18px}.note{color:#667;font-size:12px}`
