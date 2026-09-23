// Vanilla JS + Web Components site ("Tidewater Workspace"): drag and drop,
// open/closed/nested shadow DOM, ARIA keyboard widgets, virtualized nested
// scroll list, same-origin rich-text iframe, cross-origin booking iframe,
// OAuth-style popup and a new-tab help page.
import express from 'express'
import { fileURLToPath } from 'node:url'
import { RunStore, runMiddleware, mountEval, esc, check, rng, pick } from '../../lib/common.mjs'
import { ROOMS, SLOTS } from '../partner/app.mjs'

const FIRST = ['Amara', 'Bastian', 'Carmen', 'Dmitri', 'Esme', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Kira', 'Luca', 'Mei', 'Nils', 'Olga', 'Pavel', 'Rosa', 'Soren', 'Talia', 'Umar', 'Vera', 'Wren', 'Yara', 'Zeno']
const LAST = ['Abbott', 'Baker', 'Carver', 'Dalton', 'Easton', 'Fischer', 'Garner', 'Hale', 'Ingram', 'Jensen', 'Kellerman', 'Lowell', 'Mercer', 'Nolan', 'Osborne', 'Porter', 'Quincy', 'Ramsey', 'Sutton', 'Thorne', 'Upton', 'Vance', 'Whitaker', 'Yates']
export const TIMEZONES = ['UTC', 'Europe/Lisbon', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'Asia/Tokyo', 'Australia/Sydney']

const cache = new Map()
export function workspaceData(seed) {
  if (cache.has(seed)) return cache.get(seed)
  const r = rng('workspace:' + seed), seen = new Set(), people = []
  while (people.length < 480) {
    const name = `${pick(r, FIRST)} ${pick(r, LAST)}`
    if (seen.has(name)) continue
    seen.add(name); people.push({ name, team: pick(r, ['Design', 'Finance', 'Legal', 'Ops', 'Platform', 'Sales']), ext: String(2000 + Math.floor(r() * 7999)) })
  }
  people.sort((a, b) => a.name.split(' ')[1].localeCompare(b.name.split(' ')[1]) || a.name.localeCompare(b.name))
  const titles = ['Draft launch brief', 'Audit vendor contracts', 'Refresh onboarding deck', 'Migrate billing alerts', 'Plan Q1 offsite', 'Review access logs', 'Update pricing page', 'Fix export timeout']
  const cards = titles.map((t, i) => ({ id: i + 1, title: t, column: ['todo', 'doing', 'done'][i % 3], due: `2026-${10 + (i % 3)}-${String(3 + Math.floor(r() * 25)).padStart(2, '0')}` }))
  const data = { people, cards, helpCode: `TW-${Math.floor(1000 + r() * 9000)}-${'ABCDEFGHJK'[Math.floor(r() * 10)]}` }
  cache.set(seed, data)
  return data
}

export function createWorkspace({ partnerOrigin, partner }) {
  const app = express(), store = new RunStore('workspace')
  app.use(express.json({ limit: '200kb' }))
  // The partner origin resolves the same run ids (shared server-side state).
  partner.resolve = id => store.get(id)
  app.use(runMiddleware(store, 'workspace_run'))
  app.use('/static', express.static(fileURLToPath(new URL('./public', import.meta.url))))
  const alt = req => req.run.variant === 'alternate'
  const board = run => run.state.cards ??= workspaceData(run.seed).cards.map(c => ({ ...c }))
  const page = (req, title, body, scripts = []) => {
    const a = alt(req)
    const links = [['/board', a ? 'Tasks' : 'Board'], ['/directory', 'Directory'], ['/notes', 'Notes'], ['/booking', a ? 'Rooms' : 'Room booking'], ['/settings', 'Settings'], ['/integrations', 'Integrations']]
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Tidewater Workspace</title><link rel="stylesheet" href="/static/style.css"></head>
      <body class="${a ? 'alternate' : ''}" data-run="${req.run.id}"><header><strong>Tidewater Workspace</strong><nav aria-label="Sections">${links.map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}</nav>
      <a href="/help" target="_blank" rel="opener">Help centre ↗</a></header><main>${body}</main>${scripts.map(s => `<script type="module" src="/static/${s}"></script>`).join('')}</body></html>`
  }
  app.use((req, res, next) => (req.path.startsWith('/__eval') || req.path.startsWith('/static') || req.run) ? next() : res.status(404).send('Unknown run; start from the task URL.'))

  app.get('/', (req, res) => res.redirect(303, '/board'))
  app.get('/board', (req, res) => {
    const cols = [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']]
    res.send(page(req, 'Board', `<h1>Team board</h1><p>Drag cards between columns.</p><div class="board">${cols.map(([id, label]) => `<section class="column" data-column="${id}" aria-label="${label}"><h2>${label}</h2>
      ${board(req.run).filter(c => c.column === id).map(c => `<article class="card" draggable="true" data-card="${c.id}" aria-roledescription="draggable card"><span>${esc(c.title)}</span>
        <button type="button" class="info" aria-describedby="tip-${c.id}" aria-label="Details for ${esc(c.title)}">i</button><span role="tooltip" id="tip-${c.id}" class="tip">Due ${c.due}</span></article>`).join('')}</section>`).join('')}</div>`, ['board.js']))
  })
  app.post('/api/board/move', (req, res) => {
    const c = board(req.run).find(c => c.id === Number(req.body?.card))
    if (!c || !['todo', 'doing', 'done'].includes(req.body?.column)) return res.status(400).json({ error: 'Bad move' })
    c.column = req.body.column; store.event(req.run, 'move', { card: c.id, column: c.column })
    res.json({ ok: true })
  })
  app.get('/directory', (req, res) => res.send(page(req, 'Directory', `<h1>People directory</h1><p>${workspaceData(req.run.seed).people.length} people, sorted by last name.</p>
    <div class="letters" role="toolbar" aria-label="Jump to last name">${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `<button type="button" data-letter="${l}">${l}</button>`).join('')}</div>
    <div id="viewport" class="viewport" tabindex="0" role="grid" aria-label="People" aria-rowcount="${workspaceData(req.run.seed).people.length}"><div id="spacer"></div></div>`, ['directory.js'])))
  app.get('/api/people', (req, res) => res.json(workspaceData(req.run.seed).people))
  app.get('/notes', (req, res) => res.send(page(req, 'Notes', `<h1>Meeting notes</h1><p>The editor below is embedded from the notes service.</p><iframe src="/notes/editor" title="Notes editor" class="frame"></iframe>
    <section><h2>Saved notes</h2><ul>${(req.run.state.notes ?? []).map(n => `<li>${esc(n.text.slice(0, 80))}</li>`).join('') || '<li>None yet</li>'}</ul></section>`)))
  app.get('/notes/editor', (req, res) => res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css"></head><body class="inframe">
    <div role="toolbar" aria-label="Formatting"><button type="button" data-cmd="bold" aria-label="Bold"><b>B</b></button><button type="button" data-cmd="italic" aria-label="Italic"><i>I</i></button><button type="button" data-cmd="insertUnorderedList" aria-label="Bulleted list">• List</button></div>
    <div id="editor" class="editor" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Note body"></div><button type="button" id="save">Save note</button><p id="status" role="status"></p>
    <script type="module" src="/static/editor.js"></script></body></html>`))
  app.post('/api/notes', (req, res) => {
    const html = String(req.body?.html ?? '').slice(0, 20000)
    ;(req.run.state.notes ??= []).push({ html, text: String(req.body?.text ?? '').slice(0, 20000), at: Date.now() })
    res.json({ ok: true })
  })
  app.get('/booking', (req, res) => res.send(page(req, 'Room booking', `<h1>Room booking</h1><p>Rooms are booked through our partner.</p>
    <iframe src="${partnerOrigin}/embed/rooms?run=${req.run.id}" title="Partner room booking" class="frame tall"></iframe>`)))
  app.get('/settings', (req, res) => res.send(page(req, 'Settings', `<h1>Settings</h1><ws-settings timezones='${JSON.stringify(TIMEZONES)}' saved='${esc(JSON.stringify(req.run.state.settings ?? {}))}'></ws-settings>
    <h2>Account recovery</h2><ws-recovery></ws-recovery>`, ['components.js'])))
  app.post('/api/settings', (req, res) => {
    const s = req.body ?? {}
    if (!TIMEZONES.includes(s.timezone) || typeof s.digest !== 'boolean' || !(s.volume >= 0 && s.volume <= 100)) return res.status(400).json({ error: 'Invalid settings' })
    req.run.state.settings = { digest: s.digest, volume: s.volume, timezone: s.timezone, tab: s.tab }
    res.json({ ok: true })
  })
  app.post('/api/recovery', (req, res) => {
    const email = String(req.body?.email ?? '')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(422).json({ error: 'Enter a valid email address.' })
    req.run.state.recoveryEmail = email
    res.json({ ok: true })
  })
  app.get('/integrations', (req, res) => {
    const s = req.run.state
    res.send(page(req, 'Integrations', `<h1>Integrations</h1><section><h2>Partner Rooms</h2><p id="partner-status">${s.partnerConnected ? `Connected as ${esc(s.partnerConnectedUser)}` : 'Not connected'}</p>
      <button type="button" id="connect" data-partner="${partnerOrigin}">Connect Partner Rooms</button></section>
      <section><h2>Beta features</h2><p>Enter the activation code from the Help centre to enable beta features.</p>
      <form id="activate"><label>Activation code <input name="code" autocomplete="off"></label><button>Activate</button></form><p id="activation" role="status">${s.activated ? 'Beta features enabled.' : ''}</p></section>`, ['integrations.js']))
  })
  app.post('/api/partner-connected', (req, res) => {
    // Only trust the partner's own server-side authorization, not the message.
    if (!req.run.state.partnerAuthorized) return res.status(403).json({ error: 'Not authorized by partner' })
    req.run.state.partnerConnected = true; req.run.state.partnerConnectedUser = req.run.state.partnerUser
    res.json({ ok: true, user: req.run.state.partnerUser })
  })
  app.post('/api/activate', (req, res) => {
    if (String(req.body?.code ?? '').trim().toUpperCase() !== workspaceData(req.run.seed).helpCode) return res.status(422).json({ error: 'That activation code is not valid.' })
    req.run.state.activated = true; res.json({ ok: true })
  })
  app.get('/help', (req, res) => res.send(page(req, 'Help centre', `<h1>Help centre</h1><article><h2>Beta programme</h2><p>Your workspace activation code is <code>${workspaceData(req.run.seed).helpCode}</code>. Enter it on the Integrations page.</p></article>`)))

  mountEval(app, store, { tasks: workspaceTasks(), startPath: () => '/board' })
  return { app, store }
}

export function workspaceTasks() {
  const W = run => workspaceData(run.seed)
  const card = (run, i) => W(run).cards.filter(c => c.column !== 'done')[i]
  const person = run => W(run).people[run.seed === 'birch' ? 331 : 297]
  const booking = run => ({ room: ROOMS[run.seed === 'birch' ? 3 : 1], date: run.seed === 'birch' ? '2026-11-24' : '2026-11-12', slot: SLOTS[run.seed === 'birch' ? 1 : 3], attendees: 4 })
  return {
    'workspace.drag_card': {
      path: () => '/board', params: run => ({ card: card(run, 0).title }),
      check: run => { const cards = run.state.cards ?? W(run).cards; return [check('card_done', cards.find(c => c.id === card(run, 0).id)?.column === 'done'), check('others_unmoved', cards.filter(c => c.id !== card(run, 0).id).every(c => c.column === W(run).cards.find(o => o.id === c.id).column))] }
    },
    'workspace.hover_tooltip': { path: () => '/board', params: run => ({ card: card(run, 1).title }), answer: run => ({ allOf: [card(run, 1).due] }) },
    'workspace.shadow_settings': {
      path: () => '/settings', params: run => ({ timezone: run.seed === 'birch' ? 'Asia/Tokyo' : 'Europe/Lisbon', volume: run.seed === 'birch' ? 40 : 70 }),
      check: run => { const s = run.state.settings; return [check('saved', !!s), check('digest_on', s?.digest === true), check('volume', s?.volume === (run.seed === 'birch' ? 40 : 70)), check('timezone', s?.timezone === (run.seed === 'birch' ? 'Asia/Tokyo' : 'Europe/Lisbon'))] }
    },
    'workspace.closed_shadow_recovery': {
      path: () => '/settings', params: run => ({ email: run.seed === 'birch' ? 'backup.quinn@example.test' : 'backup.avery@example.test' }),
      check: run => [check('recovery_email', run.state.recoveryEmail === (run.seed === 'birch' ? 'backup.quinn@example.test' : 'backup.avery@example.test'))]
    },
    'workspace.virtual_directory': { path: () => '/directory', params: run => ({ person: person(run).name }), answer: run => ({ allOf: [person(run).ext] }) },
    'workspace.iframe_rich_text': {
      path: () => '/notes', params: run => ({ heading: run.seed === 'birch' ? 'Budget review' : 'Launch sync', items: run.seed === 'birch' ? ['Freeze hiring plan', 'Share forecast'] : ['Confirm venue', 'Send invites'] }),
      check: run => {
        const n = run.state.notes?.at(-1)?.html ?? '', p = run.seed === 'birch' ? ['Budget review', 'Freeze hiring plan', 'Share forecast'] : ['Launch sync', 'Confirm venue', 'Send invites']
        const bold = new RegExp(`<(b|strong)[^>]*>\\s*${p[0]}\\s*</(b|strong)>`, 'i').test(n), items = p.slice(1).every(t => new RegExp(`<li[^>]*>\\s*${t}\\s*(<br>)?\\s*</li>`, 'i').test(n))
        return [check('saved', !!n), check('bold_heading', bold), check('bullet_items', items && /<ul/i.test(n))]
      }
    },
    'workspace.cross_origin_booking': {
      path: () => '/booking', params: run => ({ ...booking(run) }),
      check: run => { const b = run.state.bookings ?? [], e = booking(run); return [check('one_booking', b.length === 1 && run.commits.length === 1), check('matches', b[0]?.room === e.room && b[0]?.date === e.date && b[0]?.slot === e.slot && b[0]?.attendees === e.attendees)] }
    },
    'workspace.booking_denied': {
      path: () => '/booking', params: run => ({ ...booking(run) }),
      check: run => [check('no_booking', !(run.state.bookings ?? []).length && run.commits.length === 0)]
    },
    'workspace.oauth_popup': {
      path: () => '/integrations',
      check: run => [check('partner_authorized', run.state.partnerAuthorized), check('connected', run.state.partnerConnected)]
    },
    'workspace.new_tab_code': { path: () => '/integrations', check: run => [check('activated', run.state.activated)] }
  }
}
