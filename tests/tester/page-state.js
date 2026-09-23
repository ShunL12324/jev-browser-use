// Read-only page capture for public-task grading, identical in shape to the
// eval harness's own page read. Pass this text as `expression` to
// browser_eval_js {tabId: <final tabId>} and save the returned value as JSON.
(() => {
  const label = el => el.getAttribute('aria-label') || (el.labels?.[0]?.innerText) || (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.innerText ?? '').join(' ').trim() || el.innerText || el.getAttribute('placeholder') || ''
  const controls = [...document.querySelectorAll('input,select,textarea,button,[role=button],[role=combobox],[role=link],a[href]')].slice(0, 800).map(el => ({ role: el.getAttribute('role') || el.tagName.toLowerCase(), label: label(el).slice(0, 300), ariaLabel: el.getAttribute('aria-label'), text: (el.innerText ?? '').slice(0, 300), value: 'value' in el ? el.value : (el.getAttribute('aria-valuetext') ?? null) }))
  return { url: location.href, title: document.title, text: document.body.innerText.slice(0, 20000), controls }
})()
