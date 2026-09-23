// Independent checks for public read-only tasks. pageState is captured by the
// harness from the browser it owns (evidence 'harness_page_read'); when only a
// runner-reported URL or snapshot is available the evidence level says so.
import { gradeAnswer } from '../lib/common.mjs'

const c = (id, passed, detail) => ({ id, passed: !!passed, ...(detail !== undefined ? { detail } : {}) })
const evidence = pageState => pageState?.source === 'harness' ? 'harness_page_read' : pageState ? 'runner_reported_page' : 'runner_reported_url'

export function answer({ task, result }) {
  const g = gradeAnswer(result.answer ?? '', task.expect)
  return { checks: g.checks, evidence: 'answer_text' }
}

export function wikipediaGodel({ result, pageState }) {
  const url = new URL(pageState?.url ?? result.finalUrl ?? 'about:blank')
  const path = decodeURIComponent(url.pathname)
  return { evidence: evidence(pageState), checks: [c('host', url.hostname === 'en.wikipedia.org', url.hostname), c('article', path === "/wiki/Gödel's_incompleteness_theorems", path)] }
}

// Mirrors jev-ultrafast examples/flights.py verify(), with the date as a
// parameter. Requires a page read (URL + control values + visible text).
export function googleFlightsOneWay({ task, pageState }) {
  if (!pageState) return { evidence: 'none', checks: [c('page_state_available', false, 'Google Flights needs a page read')] }
  const url = new URL(pageState.url), e = task.expect
  const values = Object.fromEntries((pageState.controls ?? []).map(x => [String(x.label ?? '').trim(), x.value]))
  let dateInUrl = false
  try { const tfs = url.searchParams.get('tfs') ?? ''; dateInUrl = Buffer.from(tfs.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1').includes(e.iso) } catch { dateInUrl = false }
  // Result rows: jev-ultrafast reads 'Select flight' labels that carry the
  // date; this page read also sees the result links whose description carries it.
  const all = pageState.controls ?? [], texts = x => [x.label, x.ariaLabel, x.text].filter(Boolean).map(String)
  const flights = all.flatMap(texts).filter(l => /Leaves .+ on /.test(l) || (l.includes('Select flight') && l.length > 'Select flight'.length))
  const oneWay = values['Change ticket type. One way'] === 'One way' || all.some(x => x.role === 'combobox' && texts(x).some(t => /^(change ticket type\.? )?one way$/i.test(t.trim())))
  return {
    evidence: evidence(pageState),
    checks: [
      c('search_page', url.hostname === 'www.google.com' && url.pathname === '/travel/flights/search', url.pathname),
      c('one_way', oneWay),
      c('origin', /z(ü|u)rich/i.test(values['Where from?'] ?? ''), values['Where from?']),
      c('destination', /london/i.test(values['Where to?'] ?? ''), values['Where to?']),
      c('date', values['Departure'] === e.short, values['Departure']),
      c('year', dateInUrl || (pageState.text ?? '').includes(`departing ${e.iso}`)),
      c('results', flights.length > 0 && flights.every(f => f.includes(e.long)), flights.length)
    ]
  }
}
