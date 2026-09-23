// jev-ultrafast's local "Forma" fixture, vendored unchanged, so both runners
// can be compared on the same page. A passive observer appended at serve time
// reports the visible state to the server-side oracle; it never changes the page.
import express from 'express'
import { readFileSync } from 'node:fs'
import { RunStore, mountEval, check } from '../../lib/common.mjs'

const FIXTURE = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8')
const OBSERVER = `<script>(() => { const run = new URLSearchParams(location.search).get('run'); let t
  const send = () => { clearTimeout(t); t = setTimeout(() => navigator.sendBeacon('/__eval/observe?run=' + run, JSON.stringify({ hash: location.hash, title: document.title, note: document.querySelector('.fixture-note')?.textContent ?? null })), 30) }
  addEventListener('hashchange', send); new MutationObserver(send).observe(document.body, { childList: true, subtree: true }); send() })()</script>`

export function createForma() {
  const app = express(), store = new RunStore('forma')
  app.use('/__eval/reset', express.json())
  app.post('/__eval/observe', express.text({ type: '*/*' }), (req, res) => {
    const run = store.get(String(req.query.run)); if (!run) return res.status(404).end()
    try { run.state.last = JSON.parse(req.body) } catch { return res.status(400).end() }
    res.status(204).end()
  })
  app.get('/fixture.html', (req, res) => { if (!store.get(String(req.query.run))) return res.status(404).send('Unknown run; start from the task URL.'); res.type('html').send(FIXTURE.replace('</body>', OBSERVER + '</body>')) })
  mountEval(app, store, { tasks: formaTasks(), startPath: () => '/fixture.html?scenario=travel' })
  return { app, store }
}

export function formaTasks() {
  return {
    // Same goal and success condition as jev-ultrafast scripts/smoke.py.
    'forma.travel_filter': {
      path: () => '/fixture.html?scenario=travel',
      check: run => [check('opened_casa_flora', run.state.last?.hash === '#casa-flora'), check('filters_applied', run.state.last?.note === 'Your filters: Design · Free cancellation enabled · Destination Lisbon')]
    },
    'forma.research_article': {
      path: () => '/fixture.html?scenario=research',
      check: run => [check('opened_article', run.state.last?.hash === '#uncertainty' && /Confidence is not correctness/.test(run.state.last?.title ?? ''))]
    }
  }
}
