// Opens the partner authorization popup and finalizes after its message.
const button = document.getElementById('connect'), partner = button.dataset.partner, run = document.body.dataset.run
button.addEventListener('click', () => { window.open(`${partner}/oauth/authorize?run=${run}`, 'partner-oauth', 'popup,width=480,height=560') })
window.addEventListener('message', async e => {
  if (e.origin !== partner || e.data?.type !== 'partner-oauth' || !e.data.allow) return
  const r = await fetch('/api/partner-connected', { method: 'POST' }), j = await r.json()
  document.getElementById('partner-status').textContent = r.ok ? `Connected as ${j.user}` : j.error
})
document.getElementById('activate').addEventListener('submit', async e => {
  e.preventDefault()
  const code = new FormData(e.target).get('code')
  const r = await fetch('/api/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }), j = await r.json()
  document.getElementById('activation').textContent = r.ok ? 'Beta features enabled.' : j.error
})
