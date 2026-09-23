#!/usr/bin/env node
// Read-only source check for public tasks: confirms that each expected answer
// is still what the authoritative page says (GET only, no login, no submit).
// This validates the answer keys, not any runner.
const SOURCES = [
  ['public.wikipedia_godel', "https://en.wikipedia.org/wiki/G%C3%B6del%27s_incompleteness_theorems", ["incompleteness theorems"]],
  ['public.wikipedia_eiffel_year', 'https://en.wikipedia.org/wiki/Eiffel_Tower', ['1889']],
  ['public.wikipedia_opera_house', 'https://en.wikipedia.org/wiki/Sydney_Opera_House', ['Utzon']],
  ['public.wikipedia_lovelace_birth', 'https://en.wikipedia.org/wiki/Ada_Lovelace', ['10 December 1815']],
  ['public.wikipedia_compare_births', 'https://en.wikipedia.org/wiki/Charles_Babbage', ['26 December 1791']],
  ['public.arxiv_attention_title', 'https://arxiv.org/abs/1706.03762', ['Attention Is All You Need']],
  ['public.mdn_flex_grow_default', 'https://developer.mozilla.org/en-US/docs/Web/CSS/flex-grow', ['Initial value', '<code>0</code>']],
  ['public.python_docs_deque', 'https://docs.python.org/3/library/collections.html', ['deque objects']],
  ['public.github_playwright_mcp_license', 'https://api.github.com/repos/microsoft/playwright-mcp', ['"spdx_id": "Apache-2.0"', '"spdx_id":"Apache-2.0"']],
  ['public.cambridge_serendipity', 'https://dictionary.cambridge.org/dictionary/english/serendipity', ['noun']],
  ['public.osm_search_eiffel', 'https://nominatim.openstreetmap.org/search?q=Eiffel+Tower&format=json&limit=1', ['Paris']],
  ['public.google_flights_oneway', 'https://www.google.com/travel/flights?hl=en', ['Flights']]
]
const results = []
for (const [id, url, any] of SOURCES) {
  let status = 0, ok = false, note = ''
  for (let attempt = 0; attempt < 2 && !ok; attempt++) try {
    note = ''
    const r = await fetch(url, { headers: { 'User-Agent': 'jev-browser-use-eval/0.1 (read-only answer-key check)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(20000) })
    status = r.status; const text = await r.text(); ok = r.ok && any.some(s => text.includes(s))
    if (!ok && r.ok) note = 'expected text not found'
  } catch (e) { note = e.message }
  results.push({ id, url, status, ok, note })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${id} ${status} ${note}`)
}
console.log(JSON.stringify({ checked: results.length, ok: results.filter(r => r.ok).length, at: new Date().toISOString() }))
